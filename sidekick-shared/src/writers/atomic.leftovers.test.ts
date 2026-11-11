import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let configDir: string;

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  return { ...actual, getConfigDir: () => configDir };
});

import {
  STALE_ATOMIC_TEMP_MS,
  atomicWriteFileSync,
  atomicWriteJson,
  updateJsonStoreAtomic,
  updateJsonStoreAtomicSync,
  waitForPendingAtomicWrites,
} from './atomic';

const PAST = new Date(Date.UTC(2020, 0, 1));

let root: string;

function directory(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempFile(dir: string, name: string, ageMs: number): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{}');
  const time = new Date(Date.now() - ageMs);
  fs.utimesSync(file, time, time);
  return file;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-leftovers-')));
  configDir = path.join(root, 'config');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('store updates that change nothing', () => {
  const empty = () => ({ version: 1, models: {} as Record<string, number> });

  it('leave the file untouched, async and sync', async () => {
    const file = path.join(directory('config'), 'store.json');
    await updateJsonStoreAtomic(file, empty, (store) => ({ ...store, models: { a: 1 } }));
    const written = fs.readFileSync(file, 'utf8');
    fs.utimesSync(file, PAST, PAST);

    await updateJsonStoreAtomic(file, empty, (store) => store);
    updateJsonStoreAtomicSync(file, empty, (store) => ({ ...store }));
    expect(fs.statSync(file).mtimeMs).toBe(PAST.getTime());
    expect(fs.readFileSync(file, 'utf8')).toBe(written);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['store.json']);
  });

  it('still write a change made in place, and create a missing store', async () => {
    const file = path.join(directory('config'), 'store.json');
    await updateJsonStoreAtomic(file, empty, (store) => store);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(empty());
    fs.utimesSync(file, PAST, PAST);

    await updateJsonStoreAtomic(file, empty, (store) => {
      store.models.b = 2;
      return store;
    });
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(PAST.getTime());
    updateJsonStoreAtomicSync(file, empty, (store) => {
      store.models.c = 3;
      return store;
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).models).toEqual({ b: 2, c: 3 });
  });
});

describe('waitForPendingAtomicWrites', () => {
  it('waits for fire-and-forget writes, including one started right after the call', async () => {
    const dir = directory('config');
    void atomicWriteJson(path.join(dir, 'a.json'), { a: 1 });
    const waiting = waitForPendingAtomicWrites(5_000);
    void updateJsonStoreAtomic(
      path.join(dir, 'b.json'),
      () => ({}),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { b: 2 };
      },
    );
    await expect(waiting).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'))).toEqual({ a: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'))).toEqual({ b: 2 });
  });

  it('gives up after the budget, and never rejects for a failed write', async () => {
    const dir = directory('config');
    let release: () => void = () => undefined;
    const slow = updateJsonStoreAtomic(
      path.join(dir, 'slow.json'),
      () => ({}),
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { done: true };
      },
    );
    await expect(waitForPendingAtomicWrites(30)).resolves.toBe(false);
    release();
    await slow;

    const failing = updateJsonStoreAtomic(
      path.join(dir, 'failing.json'),
      () => ({}),
      () => {
        throw new Error('update failed');
      },
    );
    await expect(waitForPendingAtomicWrites(5_000)).resolves.toBe(true);
    await expect(failing).rejects.toThrow('update failed');
    await expect(waitForPendingAtomicWrites(0)).resolves.toBe(true);
  });
});

describe('stale temp files', () => {
  const STALE = STALE_ATOMIC_TEMP_MS + 60_000;

  it('are removed from a config directory the first time it is written, fresh ones kept', async () => {
    const dir = directory('config');
    tempFile(dir, 'store.json.123.0123456789abcdef.tmp', STALE);
    tempFile(dir, 'other.json.45.fedcba9876543210.tmp', STALE);
    tempFile(dir, 'store.json.678.00112233445566ff.tmp', 60_000);
    tempFile(dir, 'notes.tmp', STALE);
    await atomicWriteJson(path.join(dir, 'store.json'), { ok: true });
    expect(fs.readdirSync(dir).sort()).toEqual([
      'notes.tmp',
      'store.json',
      'store.json.678.00112233445566ff.tmp',
    ]);

    // Swept once per process: a leftover appearing later waits for the next one.
    tempFile(dir, 'late.json.9.0123456789abcdef.tmp', STALE);
    await atomicWriteJson(path.join(dir, 'store.json'), { ok: false });
    expect(fs.readdirSync(dir)).toContain('late.json.9.0123456789abcdef.tmp');
  });

  it('are swept by sync writes and in config subdirectories', () => {
    const dir = directory('config/tasks');
    tempFile(dir, 'project.json.7.0123456789abcdef.tmp', STALE);
    atomicWriteFileSync(path.join(dir, 'project.json'), '{}');
    expect(fs.readdirSync(dir)).toEqual(['project.json']);
  });

  it('are left alone outside the config directory', async () => {
    const dir = directory('claude-home');
    tempFile(dir, '.credentials.json.123.0123456789abcdef.tmp', STALE);
    await atomicWriteJson(path.join(dir, 'state.json'), {});
    expect(fs.readdirSync(dir)).toContain('.credentials.json.123.0123456789abcdef.tmp');
  });
});
