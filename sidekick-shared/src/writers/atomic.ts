import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../paths';

interface OwnedLock {
  handle: fs.promises.FileHandle;
  token: string;
  heartbeat: NodeJS.Timeout;
}

const LOCK_STALE_MS = 10_000;

/**
 * How long to wait for a lock that is making no progress.
 *
 * This budget detects a wedged holder, not a long queue. It is measured from the
 * last time the lock changed hands rather than from the first attempt, because a
 * writer queued behind other healthy writers is waiting, not failing — see
 * {@link acquireLock}.
 */
const LOCK_NO_PROGRESS_MS = 3_000;

/**
 * A live async holder heartbeats every LOCK_STALE_MS / 3; an mtime frozen this
 * long means the heartbeat timer is gone — the owner is dead (possibly with its
 * PID recycled by the OS) or wedged beyond recovery. Reclaim regardless of the
 * PID probe, which cannot tell a recycled PID from a live owner. Sync holders
 * have no heartbeat; they usually hold locks for milliseconds, and even the
 * slowest (a keychain read through `security` behind the auth-swap lock, up to
 * a few seconds) stays far under this ceiling.
 */
const LOCK_ABANDONED_MS = 120_000;

/**
 * Hard ceiling on how long a synchronous waiter blocks, regardless of queue
 * progress. Progress resets are correct for async waiters, but a sync waiter
 * blocks its process's event loop while queued, so healthy-queue churn must not
 * extend the block indefinitely.
 */
const SYNC_LOCK_MAX_WAIT_MS = 15_000;

const LOCK_WAIT_INTERVAL_MS = 15;
const lockSleepView = new Int32Array(new SharedArrayBuffer(4));

/**
 * Windows refuses to replace a file another process holds open (antivirus
 * scanners, an editor extension re-reading `auth.json`) with EPERM/EBUSY/EACCES
 * even though the rename would succeed a few milliseconds later. Retry with a
 * short back-off on that platform only; other platforms surface the error.
 */
const WIN32_RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WIN32_RENAME_MAX_ATTEMPTS = 10;

function renameRetryDelayMs(attempt: number): number {
  return Math.min(320, 20 * 2 ** attempt);
}

function shouldRetryRename(error: unknown, attempt: number): boolean {
  if (process.platform !== 'win32') return false;
  if (attempt >= WIN32_RENAME_MAX_ATTEMPTS - 1) return false;
  const code = (error as NodeJS.ErrnoException).code ?? '';
  return WIN32_RENAME_RETRY_CODES.has(code);
}

export function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!shouldRetryRename(error, attempt)) throw error;
      Atomics.wait(lockSleepView, 0, 0, renameRetryDelayMs(attempt));
    }
  }
}

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      if (!shouldRetryRename(error, attempt)) throw error;
      await new Promise((resolve) => setTimeout(resolve, renameRetryDelayMs(attempt)));
    }
  }
}

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

/**
 * Atomic writes still in flight in this process. A process that exits while
 * one is between creating its temp file and the rename leaves the temp file
 * behind, so a host about to exit waits with {@link waitForPendingAtomicWrites}.
 */
const pendingWrites = new Set<Promise<unknown>>();

function trackWrite<T>(write: Promise<T>): Promise<T> {
  pendingWrites.add(write);
  const settle = () => {
    pendingWrites.delete(write);
  };
  write.then(settle, settle);
  return write;
}

/**
 * Waits until no atomic write of this process is in flight, including writes
 * started while waiting, or until `timeoutMs` passes. Call it before a
 * long-lived host exits (VS Code's `deactivate`): fire-and-forget writes such
 * as session-end history otherwise die half-done. Resolves `true` when every
 * write settled and `false` on timeout; never rejects.
 */
export async function waitForPendingAtomicWrites(timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  // Writes that disposers start right after the caller's turn register first.
  await new Promise<void>((resolve) => setImmediate(resolve));
  while (pendingWrites.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled([...pendingWrites]).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), remaining);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) return pendingWrites.size === 0;
  }
  return true;
}

/** The temp file of an atomic write: `<file>.<pid>.<16 hex>.tmp`. */
const ATOMIC_TEMP_FILE = /^.+\.\d+\.[0-9a-f]{16}\.tmp$/;

/** A temp file older than this belongs to no write in progress. */
export const STALE_ATOMIC_TEMP_MS = 24 * 60 * 60 * 1000;

/** Directories already swept by this process; each is swept once. */
const sweptDirectories = new Set<string>();

/**
 * Whether `directory` should be swept now: once per process, and only inside
 * Sidekick's config directory, so another program's files in a directory we
 * also write to (a Claude or Codex home) are never touched.
 */
function claimSweep(directory: string): boolean {
  if (sweptDirectories.has(directory)) return false;
  sweptDirectories.add(directory);
  try {
    const relative = path.relative(path.resolve(getConfigDir()), path.resolve(directory));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

/**
 * Removes temp files that an interrupted write left in `directory` more than
 * {@link STALE_ATOMIC_TEMP_MS} ago. Best-effort; never throws.
 */
async function sweepStaleTempFiles(directory: string): Promise<void> {
  if (!claimSweep(directory)) return;
  try {
    const now = Date.now();
    for (const name of await fs.promises.readdir(directory)) {
      if (!ATOMIC_TEMP_FILE.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const stat = await fs.promises.lstat(file);
        if (stat.isFile() && now - stat.mtimeMs > STALE_ATOMIC_TEMP_MS) {
          await fs.promises.rm(file, { force: true });
        }
      } catch {
        // Removed meanwhile or unreadable; leave it.
      }
    }
  } catch {
    // An unreadable directory only keeps its leftovers.
  }
}

/** Synchronous mirror of {@link sweepStaleTempFiles}. */
function sweepStaleTempFilesSync(directory: string): void {
  if (!claimSweep(directory)) return;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(directory)) {
      if (!ATOMIC_TEMP_FILE.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && now - stat.mtimeMs > STALE_ATOMIC_TEMP_MS) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // Removed meanwhile or unreadable; leave it.
      }
    }
  } catch {
    // An unreadable directory only keeps its leftovers.
  }
}

export function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  return trackWrite(writeFileAtomic(filePath, JSON.stringify(value, null, 2)));
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await sweepStaleTempFiles(path.dirname(filePath));
}

export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(value, null, 2));
}

/** Raw-string sibling of {@link atomicWriteJsonSync} for non-JSON payloads. */
export function atomicWriteFileSync(filePath: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    renameSyncWithRetry(tempPath, filePath);
    syncDirectorySync(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  sweepStaleTempFilesSync(path.dirname(filePath));
}

/**
 * Serializes read-modify-write cycles across Sidekick processes. When the
 * update leaves the store exactly as it is on disk, nothing is written.
 */
export function updateJsonStoreAtomic<T>(
  filePath: string,
  createEmpty: () => T,
  update: (latest: T) => T | Promise<T>,
): Promise<T> {
  return trackWrite(updateJsonStore(filePath, createEmpty, update));
}

async function updateJsonStore<T>(
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
    // Compared as written, so an update that mutated `latest` in place still
    // counts as a change. An unchanged store is not rewritten (no lock-held
    // fsyncs, no temp file a dying process could strand).
    const content = JSON.stringify(next, null, 2);
    if (content !== raw) await trackWrite(writeFileAtomic(filePath, content));
    return next;
  } finally {
    await releaseLock(lockPath, lock);
  }
}

/**
 * Waits for exclusive ownership of `lockPath`.
 *
 * The wait budget is reset every time the lock changes hands. A flat budget from
 * the first attempt conflated two unrelated conditions — a wedged holder and a
 * queue of healthy writers — so under real contention the writers at the back of
 * the queue failed even though every lock was being acquired and released
 * correctly. Each cycle costs three fsyncs (lock file, temp file, directory), so
 * on slow storage a burst of concurrent captures drained slower than the budget.
 *
 * A stuck holder keeps the same token, so it makes no progress and still trips
 * the timeout; the stale-reclaim path below still handles an owner that died.
 */
async function acquireLock(lockPath: string): Promise<OwnedLock> {
  let deadline = Date.now() + LOCK_NO_PROGRESS_MS;
  let observedOwner: string | null = null;
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
      // The token identifies the current holder. mtime cannot stand in for it:
      // the heartbeat keeps touching the file, so even a wedged holder looks
      // fresh. A different token means the queue advanced.
      const currentOwner = await fs.promises.readFile(lockPath, 'utf8').catch(() => null);
      if (currentOwner !== null && currentOwner !== observedOwner) {
        observedOwner = currentOwner;
        deadline = Date.now() + LOCK_NO_PROGRESS_MS;
      }
      try {
        const stat = await fs.promises.stat(lockPath);
        const frozenMs = Date.now() - stat.mtimeMs;
        if (frozenMs > LOCK_STALE_MS && !lockOwnerAlive(currentOwner, frozenMs)) {
          await fs.promises.rm(lockPath, { force: true });
        }
      } catch {
        // The other writer released between checks.
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for store lock: ${lockPath} (no progress for ${LOCK_NO_PROGRESS_MS}ms)`,
        );
      }
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

/**
 * Whether the recorded owner of a stale lock should still be treated as alive.
 * An mtime frozen past {@link LOCK_ABANDONED_MS} overrides the PID probe — see
 * the constant for why the probe alone cannot be trusted at that age.
 */
function lockOwnerAlive(owner: string | null, frozenMs: number): boolean {
  if (frozenMs > LOCK_ABANDONED_MS) return false;
  const ownerPid = Number.parseInt((owner ?? '').split(':', 1)[0], 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Synchronous counterpart of {@link acquireLock}, sharing its lock-file
 * protocol so sync and async waiters exclude each other across processes.
 *
 * Two timeout rules apply instead of one: the same progress-based budget as the
 * async path (a token that never changes trips it in LOCK_NO_PROGRESS_MS), plus
 * an absolute {@link SYNC_LOCK_MAX_WAIT_MS} ceiling, because a sync waiter
 * blocks its event loop while queued. Sync holders take no heartbeat — their
 * critical sections must stay well under LOCK_STALE_MS (in-repo users are
 * local-filesystem read-modify-writes, plus keychain reads behind the
 * auth-swap locks that can take a few seconds).
 *
 * The caller must ensure `dirname(lockPath)` exists — a missing parent
 * surfaces as a raw ENOENT, not a timeout.
 */
export function withFileLockSync<T>(lockPath: string, operation: () => T): T {
  const token = acquireLockSync(lockPath);
  try {
    return operation();
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === token) fs.rmSync(lockPath, { force: true });
    } catch {
      // The lock was already released or replaced; never delete another owner's lock.
    }
  }
}

function acquireLockSync(lockPath: string): string {
  const start = Date.now();
  let deadline = start + LOCK_NO_PROGRESS_MS;
  let observedOwner: string | null = null;
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      const token = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
      fs.writeFileSync(descriptor, token, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let currentOwner: string | null = null;
      try {
        currentOwner = fs.readFileSync(lockPath, 'utf8');
      } catch {
        // The other writer released between checks.
      }
      if (currentOwner !== null && currentOwner !== observedOwner) {
        observedOwner = currentOwner;
        deadline = Date.now() + LOCK_NO_PROGRESS_MS;
      }
      try {
        const stat = fs.statSync(lockPath);
        const frozenMs = Date.now() - stat.mtimeMs;
        if (frozenMs > LOCK_STALE_MS && !lockOwnerAlive(currentOwner, frozenMs)) {
          fs.rmSync(lockPath, { force: true });
        }
      } catch {
        // The other writer released between checks.
      }
      const now = Date.now();
      if (now >= deadline) {
        throw new Error(
          `Timed out waiting for store lock: ${lockPath} (no progress for ${LOCK_NO_PROGRESS_MS}ms)`,
        );
      }
      if (now - start >= SYNC_LOCK_MAX_WAIT_MS) {
        throw new Error(
          `Timed out waiting for store lock: ${lockPath} (blocked synchronously for ${SYNC_LOCK_MAX_WAIT_MS}ms)`,
        );
      }
      Atomics.wait(lockSleepView, 0, 0, LOCK_WAIT_INTERVAL_MS);
    }
  }
}

/** Synchronous mirror of {@link updateJsonStoreAtomic}; an unchanged store is not rewritten. */
export function updateJsonStoreAtomicSync<T>(
  filePath: string,
  createEmpty: () => T,
  update: (latest: T) => T,
): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${filePath}.lock`, () => {
    let latest = createEmpty();
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (raw !== undefined) {
      try {
        latest = JSON.parse(raw) as T;
      } catch {
        const corruptPath = `${filePath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        fs.renameSync(filePath, corruptPath);
      }
    }
    const next = update(latest);
    const content = JSON.stringify(next, null, 2);
    if (content !== raw) atomicWriteFileSync(filePath, content);
    return next;
  });
}
