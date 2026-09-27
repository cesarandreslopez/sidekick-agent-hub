/**
 * Keep-alive leases: while keep-alive runs a provider CLI inside a profile
 * home, that home's credential may be mid-refresh. A switch to that account
 * would copy the pre-refresh token into the live store just as the CLI kills
 * it, so switches refuse a leased target. Leases are acquired under the
 * provider's swap lock (the same lock a switch holds), expire on their own,
 * and are ignored once their process is gone.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AccountProviderId } from './accountRegistry';
import { getClaudeProfileDir } from './claudeProfiles';
import { getCodexProfileDir } from './codexPaths';
import { atomicWriteJsonSync } from './writers/atomic';

interface LeaseFile {
  pid: number;
  expiresAt: number;
}

function leasePath(provider: AccountProviderId, accountId: string): string {
  const dir = provider === 'codex' ? getCodexProfileDir(accountId) : getClaudeProfileDir(accountId);
  return path.join(dir, 'keepalive.lease');
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isAccountLeaseHeld(
  provider: AccountProviderId,
  accountId: string,
  now: number = Date.now(),
): boolean {
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath(provider, accountId), 'utf8')) as LeaseFile;
    return (
      typeof lease.pid === 'number' &&
      typeof lease.expiresAt === 'number' &&
      lease.expiresAt > now &&
      processAlive(lease.pid)
    );
  } catch {
    return false;
  }
}

/** Take the lease; the caller holds the provider's swap lock. False when held elsewhere. */
export function acquireAccountLease(
  provider: AccountProviderId,
  accountId: string,
  durationMs: number,
  now: number = Date.now(),
): boolean {
  if (isAccountLeaseHeld(provider, accountId, now)) return false;
  const target = leasePath(provider, accountId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  atomicWriteJsonSync(target, {
    pid: process.pid,
    expiresAt: now + durationMs,
  } satisfies LeaseFile);
  return true;
}

export function releaseAccountLease(provider: AccountProviderId, accountId: string): void {
  try {
    fs.rmSync(leasePath(provider, accountId), { force: true });
  } catch {
    /* expires on its own */
  }
}
