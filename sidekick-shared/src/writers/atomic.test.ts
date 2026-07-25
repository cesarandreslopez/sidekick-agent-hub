import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateJsonStoreAtomic } from './atomic';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe('updateJsonStoreAtomic', () => {
  it('preserves every interleaved read-modify-write update', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'tasks.json');

    await Promise.all(
      Array.from({ length: 24 }, (_, id) =>
        updateJsonStoreAtomic(
          filePath,
          () => ({ schemaVersion: 1, entries: {} as Record<string, number>, lastSaved: '' }),
          async (store) => {
            await new Promise((resolve) => setTimeout(resolve, id % 3));
            return {
              ...store,
              entries: { ...store.entries, [String(id)]: id },
              lastSaved: new Date().toISOString(),
            };
          },
        ),
      ),
    );

    const persisted = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      entries: Record<string, number>;
      lastSaved: string;
    };
    expect(persisted.schemaVersion).toBe(1);
    expect(Object.keys(persisted.entries)).toHaveLength(24);
    expect(persisted.entries['0']).toBe(0);
    expect(persisted.entries['23']).toBe(23);
    expect(persisted.lastSaved).not.toBe('');
    await expect(fs.promises.access(`${filePath}.lock`)).rejects.toThrow();
  });

  it('still times out when the holder makes no progress', async () => {
    // The wait budget resets whenever the lock changes hands, so that a queue of
    // healthy writers cannot manufacture a timeout. It must still fire for a
    // holder that is alive but wedged, or a stuck process would hang every
    // writer behind it forever.
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'tasks.json');

    // A live owner (this process) with a fresh mtime: not reclaimable as stale,
    // and the token never changes, so no progress is ever observed.
    await fs.promises.writeFile(`${filePath}.lock`, `${process.pid}:wedged`, { mode: 0o600 });

    const started = Date.now();
    await expect(
      updateJsonStoreAtomic(
        filePath,
        () => ({ entries: {} as Record<string, number> }),
        (store) => store,
      ),
    ).rejects.toThrow(/no progress/);
    // Fired on the no-progress budget, not instantly and not after the 10s
    // stale-reclaim window.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  }, 15_000);

  it('rethrows transient read failures instead of overwriting from an empty store', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'tasks.json');
    await fs.promises.writeFile(filePath, JSON.stringify({ entries: { safe: 1 } }));
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (source, options) => {
      if (String(source) === filePath)
        throw Object.assign(new Error('temporary I/O failure'), { code: 'EIO' });
      return originalReadFile(source, options as never) as never;
    });

    await expect(
      updateJsonStoreAtomic(
        filePath,
        () => ({ entries: {} as Record<string, number> }),
        (store) => store,
      ),
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(JSON.parse(await originalReadFile(filePath, 'utf8'))).toEqual({ entries: { safe: 1 } });
  });

  it('preserves malformed JSON before recovering the store', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'tasks.json');
    await fs.promises.writeFile(filePath, '{truncated');

    await updateJsonStoreAtomic(
      filePath,
      () => ({ entries: {} as Record<string, number> }),
      (store) => ({ entries: { ...store.entries, recovered: 1 } }),
    );

    const backup = (await fs.promises.readdir(directory)).find((name) =>
      name.startsWith('tasks.json.corrupt-'),
    );
    expect(backup).toBeDefined();
    expect(await fs.promises.readFile(path.join(directory, backup!), 'utf8')).toBe('{truncated');
  });

  it("does not remove another owner's replacement lock", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'tasks.json');
    const lockPath = `${filePath}.lock`;

    await updateJsonStoreAtomic(
      filePath,
      () => ({ entries: {} as Record<string, number> }),
      async (store) => {
        await fs.promises.writeFile(lockPath, '999999:replacement-owner');
        return store;
      },
    );

    expect(await fs.promises.readFile(lockPath, 'utf8')).toBe('999999:replacement-owner');
  });
});

describe('atomicWriteJsonSync', () => {
  it('fsyncs the file before rename and the containing directory after rename', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'state.json');
    const script = `
      const fs = require('fs');
      const original = fs.fsyncSync;
      let calls = 0;
      fs.fsyncSync = (fd) => { calls++; return original(fd); };
      const { atomicWriteJsonSync } = require(process.cwd());
      atomicWriteJsonSync(process.argv[1], { durable: true });
      process.stdout.write(String(calls));
    `;

    const calls = execFileSync(process.execPath, ['-e', script, filePath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(calls).toBe('2');
  });
});
