/**
 * Borrow Claude Code's own token-refresh lock while Sidekick reads and
 * replaces a home's credential.
 *
 * Claude Code 2.1.x serialises refreshes per config directory with a
 * proper-lockfile directory lock at `<configDir>/.oauth_refresh.lock` (stale
 * after 60 s) plus a legacy `<realpath(configDir)>.lock`. Under that lock it
 * re-reads the store before refreshing and adopts a token someone else wrote,
 * so holding both locks keeps a refresh (which rotates the refresh token) out
 * of the window between Sidekick's read and its write.
 *
 * Best effort by construction: this layers on Claude Code internals. If they
 * change we lose only the exclusion; the callers' fingerprint re-checks still
 * catch a store that moved. Held briefly (a few `security` calls), well under
 * the 60 s stale window, and released on every exit.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Claude Code treats a lock older than this as abandoned (proper-lockfile `stale`). */
export const CLAUDE_REFRESH_LOCK_STALE_MS = 60_000;
const DEFAULT_WAIT_MS = 5_000;
const POLL_MS = 50;
const sleepView = new Int32Array(new SharedArrayBuffer(4));

/** Claude Code is refreshing a login in one of the homes; retry shortly. */
export class ClaudeRefreshLockBusyError extends Error {
  constructor(lockPath: string) {
    super(`Claude Code is refreshing a login (${lockPath} is held); try again in a few seconds.`);
    this.name = 'ClaudeRefreshLockBusyError';
  }
}

export function claudeRefreshLockPaths(home: string): string[] {
  let real = path.resolve(home);
  try {
    real = fs.realpathSync(home);
  } catch {
    /* keep the resolved path */
  }
  return [path.join(home, '.oauth_refresh.lock'), `${real}.lock`];
}

function tryAcquire(lockPath: string, now: number): boolean {
  try {
    fs.mkdirSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  try {
    const stat = fs.statSync(lockPath);
    if (now - stat.mtimeMs > CLAUDE_REFRESH_LOCK_STALE_MS) {
      // proper-lockfile's own recovery: an abandoned lock is removed and retaken.
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.mkdirSync(lockPath);
      return true;
    }
  } catch {
    /* released or retaken between checks; poll again */
  }
  return false;
}

/**
 * Run `operation` holding the refresh locks of every existing home (a home
 * that does not exist has no CLI using it). Throws
 * {@link ClaudeRefreshLockBusyError} when a lock stays held past `waitMs`.
 */
export function withClaudeRefreshLocksSync<T>(
  homes: string[],
  operation: () => T,
  options: { waitMs?: number } = {},
): T {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const lockPaths = [
    ...new Set(
      homes
        .filter((home) => {
          try {
            return fs.statSync(home).isDirectory();
          } catch {
            return false;
          }
        })
        .flatMap(claudeRefreshLockPaths),
    ),
  ];
  const held: string[] = [];
  try {
    const deadline = Date.now() + waitMs;
    for (const lockPath of lockPaths) {
      while (!tryAcquire(lockPath, Date.now())) {
        if (Date.now() >= deadline) throw new ClaudeRefreshLockBusyError(lockPath);
        Atomics.wait(sleepView, 0, 0, POLL_MS);
      }
      held.push(lockPath);
    }
    return operation();
  } finally {
    for (const lockPath of held.reverse()) {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* Claude Code recovers a stale lock after 60 s */
      }
    }
  }
}
