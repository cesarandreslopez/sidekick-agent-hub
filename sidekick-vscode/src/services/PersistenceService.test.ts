import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateJsonStoreAtomic: vi.fn(),
}));

vi.mock('vscode', () => ({}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('sidekick-shared', () => ({
  updateJsonStoreAtomic: mocks.updateJsonStoreAtomic,
  atomicWriteJsonSync: vi.fn(),
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
});
