import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface OwnedLock {
  handle: fs.promises.FileHandle;
  token: string;
  heartbeat: NodeJS.Timeout;
}

const LOCK_STALE_MS = 10_000;

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EISDIR', 'EINVAL', 'ENOSYS', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function syncDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EISDIR', 'EINVAL', 'ENOSYS', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
    syncDirectorySync(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Serializes read-modify-write cycles across Sidekick processes. */
export async function updateJsonStoreAtomic<T>(
  filePath: string,
  createEmpty: () => T,
  update: (latest: T) => T | Promise<T>,
): Promise<T> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const lock = await acquireLock(lockPath);
  try {
    let latest = createEmpty();
    let raw: string | undefined;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (raw !== undefined) {
      try {
        latest = JSON.parse(raw) as T;
      } catch {
        const corruptPath = `${filePath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        await fs.promises.rename(filePath, corruptPath);
      }
    }
    const next = await update(latest);
    await atomicWriteJson(filePath, next);
    return next;
  } finally {
    await releaseLock(lockPath, lock);
  }
}

async function acquireLock(lockPath: string): Promise<OwnedLock> {
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx', 0o600);
      const token = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
      await handle.writeFile(token, 'utf8');
      await handle.sync();
      const heartbeat = setInterval(
        () => {
          fs.promises.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
        },
        Math.floor(LOCK_STALE_MS / 3),
      );
      heartbeat.unref();
      return { handle, token, heartbeat };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          const owner = await fs.promises.readFile(lockPath, 'utf8').catch(() => '');
          const ownerPid = Number.parseInt(owner.split(':', 1)[0], 10);
          let ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0;
          if (ownerAlive) {
            try {
              process.kill(ownerPid, 0);
            } catch (ownerError) {
              ownerAlive = (ownerError as NodeJS.ErrnoException).code === 'EPERM';
            }
          }
          if (!ownerAlive) await fs.promises.rm(lockPath, { force: true });
        }
      } catch {
        // The other writer released between checks.
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for store lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

async function releaseLock(lockPath: string, lock: OwnedLock): Promise<void> {
  clearInterval(lock.heartbeat);
  await lock.handle.close().catch(() => undefined);
  try {
    const currentToken = await fs.promises.readFile(lockPath, 'utf8');
    if (currentToken === lock.token) await fs.promises.rm(lockPath, { force: true });
  } catch {
    // The lock was already released or replaced; never delete another owner's lock.
  }
}
