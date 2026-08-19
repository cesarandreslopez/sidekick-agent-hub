import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateJsonStoreAtomic: vi.fn(),
  updateJsonStoreAtomicSync: vi.fn(),
}));

vi.mock('vscode', () => ({}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('sidekick-shared', () => ({
  updateJsonStoreAtomic: mocks.updateJsonStoreAtomic,
  updateJsonStoreAtomicSync: mocks.updateJsonStoreAtomicSync,
  getConfigDir: vi.fn(() => '/tmp/sidekick-test-config'),
}));

import { PersistenceService } from './PersistenceService';

interface TestStore {
  schemaVersion: number;
  lastSaved: string;
  values: string[];
}

class TestPersistence extends PersistenceService<TestStore> {
  constructor() {
    super('/tmp/sidekick-persistence-race.json', 'Test', 1, () => ({
      schemaVersion: 1,
      lastSaved: '',
      values: [],
    }));
  }

  add(value: string): void {
    this.store.values.push(value);
    this.markDirty();
  }

  values(): string[] {
    return [...this.store.values];
  }

  protected override mergeStoreForSave(latest: TestStore, pending: TestStore): TestStore {
    return { ...pending, values: [...new Set([...latest.values, ...pending.values])] };
  }
}

describe('PersistenceService', () => {
  it('retains mutations that arrive while an atomic save is in flight', async () => {
    let releaseFirst: (() => void) | undefined;
    mocks.updateJsonStoreAtomic
      .mockImplementationOnce(
        async (
          _filePath: string,
          createEmpty: () => TestStore,
          mutate: (store: TestStore) => TestStore,
        ) => {
          const saved = mutate(createEmpty());
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return saved;
        },
      )
      .mockImplementation(
        async (
          _filePath: string,
          createEmpty: () => TestStore,
          mutate: (store: TestStore) => TestStore,
        ) => mutate(createEmpty()),
      );
    const service = new TestPersistence();
    service.add('before');

    const firstSave = service.forceSave();
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    service.add('during');
    releaseFirst!();
    await firstSave;

    expect(service.values()).toEqual(['before', 'during']);
    await service.forceSave();
    expect(mocks.updateJsonStoreAtomic).toHaveBeenCalledTimes(2);
  });

  it('flushes on dispose through the locked sync updater, merging disk state', () => {
    mocks.updateJsonStoreAtomicSync.mockImplementation(
      (_filePath: string, createEmpty: () => TestStore, mutate: (store: TestStore) => TestStore) =>
        mutate({ ...createEmpty(), values: ['from-cli'] }),
    );
    const service = new TestPersistence();
    service.add('local');

    service.dispose();

    expect(mocks.updateJsonStoreAtomicSync).toHaveBeenCalledTimes(1);
    expect(mocks.updateJsonStoreAtomicSync).toHaveBeenCalledWith(
      '/tmp/sidekick-persistence-race.json',
      expect.any(Function),
      expect.any(Function),
    );
    expect(service.values()).toEqual(['from-cli', 'local']);

    // A second dispose is a no-op: the flush cleared the dirty flag.
    service.dispose();
    expect(mocks.updateJsonStoreAtomicSync).toHaveBeenCalledTimes(1);
  });

  it('skips the sync dispose flush while an async save is in flight', async () => {
    // The sync flush would wait on the same cross-process lock the in-flight
    // async save holds — a wait the parked event loop could never end.
    mocks.updateJsonStoreAtomicSync.mockClear();
    let releaseSave: (() => void) | undefined;
    mocks.updateJsonStoreAtomic.mockImplementationOnce(
      async (
        _filePath: string,
        createEmpty: () => TestStore,
        mutate: (store: TestStore) => TestStore,
      ) => {
        const saved = mutate(createEmpty());
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        return saved;
      },
    );
    const service = new TestPersistence();
    service.add('mid-save');

    const save = service.forceSave();
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf('function'));
    service.dispose();
    expect(mocks.updateJsonStoreAtomicSync).not.toHaveBeenCalled();

    releaseSave!();
    await save;
  });
});
