import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './paths';
import { atomicWriteJsonSync, withFileLockSync } from './writers/atomic';
import { classifyQuotaFreshness, type QuotaState } from './quota';
import type { AccountProviderId } from './accountRegistry';
import { isAggregateCodexLimit } from './types/codex';

/**
 * Storage key for a quota snapshot. Extends `AccountProviderId` with `'zai'`
 * because z.ai has no full account-management surface in v1, but the snapshot
 * store still needs a stable key for the z.ai quota cache.
 */
export type QuotaSnapshotProviderId = AccountProviderId | 'zai';

interface QuotaSnapshotRecord {
  providerId: QuotaSnapshotProviderId;
  accountId: string;
  quota: QuotaState;
}

interface QuotaSnapshotStore {
  version: 1;
  snapshots: QuotaSnapshotRecord[];
}

function getQuotaSnapshotPath(): string {
  return path.join(getConfigDir(), 'quota-snapshots.json');
}

function ensureConfigDir(): void {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
}

function readStore(): QuotaSnapshotStore {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getQuotaSnapshotPath(), 'utf8'),
    ) as QuotaSnapshotStore;
    if (parsed?.version === 1 && Array.isArray(parsed.snapshots)) {
      return parsed;
    }
  } catch {
    // Ignore absent or malformed store.
  }

  return {
    version: 1,
    snapshots: [],
  };
}

function writeStore(store: QuotaSnapshotStore): void {
  ensureConfigDir();
  atomicWriteJsonSync(getQuotaSnapshotPath(), store);
}

/**
 * Serializes snapshot read-modify-write cycles across processes on the shared
 * store lock. The lock file path is unchanged from the previous local
 * implementation, so processes running older versions still exclude correctly.
 */
function withSnapshotStoreLock<T>(operation: () => T): T {
  ensureConfigDir();
  return withFileLockSync(`${getQuotaSnapshotPath()}.lock`, operation);
}

function snapshotTimeMs(quota: QuotaState): number {
  const capturedAt = quota.capturedAt ? Date.parse(quota.capturedAt) : NaN;
  return Number.isFinite(capturedAt) ? capturedAt : 0;
}

function windowResetMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

// Preserve the best-known same-window snapshot while still allowing lower
// utilization after Codex advances to a newer reset window.
function shouldKeepExistingSnapshot(existing: QuotaState, next: QuotaState): boolean {
  // Family rank first (Codex): the aggregate plan-quota family ("codex") must never be
  // replaced or blocked by a model/feature-specific family (e.g. codex_bengalfox), whose
  // later-resetting 0% window would otherwise win the reset-window comparison below. This
  // is a no-op for providers whose limitId is consistent across samples (Claude: absent;
  // z.ai: zai-*), where both sides share the same aggregate-ness.
  const existingAggregate = isAggregateCodexLimit(existing.limitId);
  const nextAggregate = isAggregateCodexLimit(next.limitId);
  if (existingAggregate !== nextAggregate) return existingAggregate;

  const existingPrimaryReset = windowResetMs(existing.fiveHour.resetsAt);
  const nextPrimaryReset = windowResetMs(next.fiveHour.resetsAt);
  if (existingPrimaryReset !== nextPrimaryReset) return existingPrimaryReset > nextPrimaryReset;

  const existingSecondaryReset = windowResetMs(existing.sevenDay.resetsAt);
  const nextSecondaryReset = windowResetMs(next.sevenDay.resetsAt);
  if (existingSecondaryReset !== nextSecondaryReset)
    return existingSecondaryReset > nextSecondaryReset;

  const existingUtilization = existing.fiveHour.utilization + existing.sevenDay.utilization;
  const nextUtilization = next.fiveHour.utilization + next.sevenDay.utilization;
  if (existingUtilization !== nextUtilization) return existingUtilization > nextUtilization;

  return snapshotTimeMs(existing) > snapshotTimeMs(next);
}

export function writeQuotaSnapshot(
  providerId: QuotaSnapshotProviderId,
  accountId: string,
  quota: QuotaState,
): void {
  withSnapshotStoreLock(() => {
    const store = readStore();
    const index = store.snapshots.findIndex(
      (item) => item.providerId === providerId && item.accountId === accountId,
    );
    const existingQuota = index >= 0 ? store.snapshots[index].quota : undefined;
    const snapshot: QuotaState = {
      ...quota,
      providerId,
      capturedAt: quota.capturedAt ?? new Date().toISOString(),
      source: quota.source ?? 'session',
      stale: false,
      resetCredits:
        quota.resetCredits ?? (providerId === 'codex' ? existingQuota?.resetCredits : undefined),
    };

    if (index >= 0 && shouldKeepExistingSnapshot(store.snapshots[index].quota, snapshot)) return;

    const record: QuotaSnapshotRecord = { providerId, accountId, quota: snapshot };
    if (index >= 0) store.snapshots[index] = record;
    else store.snapshots.push(record);

    writeStore(store);
  });
}

/**
 * Read the persisted snapshot for one provider/account.
 *
 * `stale: true` and `source: 'cache'` mean "not a live fetch"; the age of the
 * sample is reported separately as `ageMs` and `freshness` so a reader can
 * tell a ten-second-old snapshot from a two-day-old one.
 */
export function readQuotaSnapshot(
  providerId: QuotaSnapshotProviderId,
  accountId: string,
  now: Date = new Date(),
): QuotaState | null {
  const store = readStore();
  const snapshot = store.snapshots.find(
    (item) => item.providerId === providerId && item.accountId === accountId,
  );
  if (!snapshot) return null;

  const capturedMs = snapshotTimeMs(snapshot.quota);
  const ageMs = capturedMs > 0 ? Math.max(0, now.getTime() - capturedMs) : undefined;
  return {
    ...snapshot.quota,
    providerId,
    source: 'cache',
    stale: true,
    ...(ageMs !== undefined ? { ageMs } : {}),
    freshness: classifyQuotaFreshness(ageMs),
  };
}
