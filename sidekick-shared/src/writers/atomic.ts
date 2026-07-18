import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
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
    try {
      latest = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as T;
    } catch {
      // Missing/malformed stores start from the schema-correct empty value.
    }
    const next = await update(latest);
    await atomicWriteJson(filePath, next);
    return next;
  } finally {
    await lock.close().catch(() => undefined);
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function acquireLock(lockPath: string): Promise<fs.promises.FileHandle> {
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      return await fs.promises.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) await fs.promises.rm(lockPath, { force: true });
      } catch {
        // The other writer released between checks.
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for store lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}
