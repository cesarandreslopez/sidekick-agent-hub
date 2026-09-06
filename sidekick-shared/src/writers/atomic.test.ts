import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atomicWriteFileSync,
  updateJsonStoreAtomic,
  updateJsonStoreAtomicSync,
  withFileLockSync,
} from './atomic';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe('updateJsonStoreAtomic', { timeout: 30_000 }, () => {
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

describe('updateJsonStoreAtomicSync', { timeout: 30_000 }, () => {
  it('preserves interleaved updates from concurrent sync and async processes', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'store.json');
    const workerScript = `
      // require() resolves to dist/index.js via package.json main; the
      // package's "pretest": "npm run build" rebuilds dist before vitest runs.
      const pkg = require(${JSON.stringify(process.cwd())});
      // Under \`node -e\`, positional arguments start at argv[1].
      const filePath = process.argv[1];
      const id = process.argv[2];
      const createEmpty = () => ({ entries: {} });
      const update = (store) => ({ entries: { ...store.entries, [id]: Number(id) } });
      if (process.argv[3] === 'sync') {
        pkg.updateJsonStoreAtomicSync(filePath, createEmpty, update);
      } else {
        pkg.updateJsonStoreAtomic(filePath, createEmpty, update).catch((error) => {
          console.error(error);
          process.exit(1);
        });
      }
    `;

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        runWorker(process.execPath, [
          '-e',
          workerScript,
          filePath,
          String(index),
          index % 2 === 0 ? 'sync' : 'async',
        ]),
      ),
    );

    expect(results.filter((result) => result.status !== 0).map((result) => result.stderr)).toEqual(
      [],
    );
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      entries: Record<string, number>;
    };
    expect(Object.keys(persisted.entries)).toHaveLength(12);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  }, 60_000);

  it('still times out when the holder makes no progress', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'store.json');
    // A live owner (this process) with a fresh mtime: not reclaimable as stale,
    // and the token never changes, so no progress is ever observed.
    fs.writeFileSync(`${filePath}.lock`, `${process.pid}:wedged`, { mode: 0o600 });

    const started = Date.now();
    expect(() =>
      updateJsonStoreAtomicSync(
        filePath,
        () => ({ entries: {} as Record<string, number> }),
        (store) => store,
      ),
    ).toThrow(/no progress/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  }, 15_000);

  it('caps a synchronous wait even while the queue keeps making progress', () => {
    // Progress resets must not extend a sync waiter's block indefinitely — the
    // waiter is holding its process's event loop hostage while it queues. The
    // fs sync methods are not spyable from ESM, so the scenario runs in a CJS
    // child where the module object is mutable: the lock always "exists", its
    // token changes on every read, its mtime is always fresh, and Date.now()
    // advances on every call so the 15s ceiling is reached in milliseconds of
    // real time.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, 'store.json.lock');
    const script = `
      const fs = require('fs');
      const lockPath = process.argv[1];
      let tokenReads = 0;
      const realOpenSync = fs.openSync;
      fs.openSync = (target, flags, mode) => {
        if (String(target) === lockPath)
          throw Object.assign(new Error('locked'), { code: 'EEXIST' });
        return realOpenSync(target, flags, mode);
      };
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = (target, options) => {
        if (String(target) === lockPath) return 'other:token-' + (++tokenReads);
        return realReadFileSync(target, options);
      };
      const realStatSync = fs.statSync;
      fs.statSync = (target, options) => {
        if (String(target) === lockPath) return { mtimeMs: Date.now() };
        return realStatSync(target, options);
      };
      const base = Date.now();
      let clock = 0;
      Date.now = () => base + (clock += 200);
      const { withFileLockSync } = require(process.cwd());
      try {
        withFileLockSync(lockPath, () => 'unreachable');
        console.error('lock unexpectedly acquired');
        process.exit(1);
      } catch (error) {
        if (!/blocked synchronously/.test(String(error))) {
          console.error('wrong error: ' + error);
          process.exit(1);
        }
        process.stdout.write('ceiling:' + tokenReads);
      }
    `;

    const output = execFileSync(process.execPath, ['-e', script, lockPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    // The queue was advancing the whole time — the ceiling fired, not the
    // no-progress budget.
    const tokenReads = Number(output.replace('ceiling:', ''));
    expect(output).toMatch(/^ceiling:/);
    expect(tokenReads).toBeGreaterThan(5);
  });

  it('reclaims a lock abandoned past the heartbeat ceiling even when its PID is live', async () => {
    // PID reuse makes process.kill(pid, 0) an unreliable liveness signal: a
    // crashed owner's recycled PID looks alive forever and the store wedges
    // until a human deletes the lock. An mtime frozen far past the heartbeat
    // interval is the stronger signal that the owner is gone.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'store.json');
    const lockPath = `${filePath}.lock`;
    const past = new Date(Date.now() - 180_000);

    fs.writeFileSync(lockPath, `${process.pid}:abandoned`, { mode: 0o600 });
    fs.utimesSync(lockPath, past, past);
    await updateJsonStoreAtomic(
      filePath,
      () => ({ entries: {} as Record<string, number> }),
      (store) => ({ entries: { ...store.entries, async: 1 } }),
    );

    fs.writeFileSync(lockPath, `${process.pid}:abandoned`, { mode: 0o600 });
    fs.utimesSync(lockPath, past, past);
    updateJsonStoreAtomicSync(
      filePath,
      () => ({ entries: {} as Record<string, number> }),
      (store) => ({ entries: { ...store.entries, sync: 1 } }),
    );

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      entries: Record<string, number>;
    };
    expect(persisted.entries).toEqual({ async: 1, sync: 1 });
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('atomicWriteFileSync', { timeout: 30_000 }, () => {
  it('writes raw content atomically without leaving temp files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'auth.json');

    atomicWriteFileSync(filePath, '{"raw": true}\n');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"raw": true}\n');
    expect(fs.readdirSync(directory)).toEqual(['auth.json']);
  });

  it.skipIf(process.platform === 'win32')('applies the requested file mode', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'auth.json');

    atomicWriteFileSync(filePath, 'secret', 0o600);

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

function runWorker(
  command: string,
  args: string[],
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

describe('atomicWriteJsonSync', { timeout: 30_000 }, () => {
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
