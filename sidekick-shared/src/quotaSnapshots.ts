import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './paths';
import { atomicWriteJsonSync, withFileLockSync } from './writers/atomic';
import { classifyQuotaFreshness, extraQuotaRows, type QuotaState } from './quota';
import type { AccountProviderId } from './accountRegistry';
import { isAggregateCodexLimit } from './types/codex';

/**
 * Storage key for a quota snapshot. Extends `AccountProviderId` with `'zai'`
 * because z.ai has no full account-management surface in v1, but the snapshot
 * store still needs a stable key for the z.ai quota cache.
 */
export type QuotaSnapshotProviderId = AccountProviderId | 'zai';

export interface QuotaSnapshotRecord {
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

/**
 * Rank two samples by one window's reset time. A later reset means a newer
 * window, so it wins — except that an existing window which had already reset
 * by the time the newer sample was captured is obsolete and always yields.
 * Without that exception a pre-reset sample outranks every later sample whose
 * window has not started yet (empty reset), and the snapshot freezes.
 * Returns `undefined` when the reset times tie.
 */
function compareWindowResets(
  existing: QuotaState['fiveHour'],
  next: QuotaState['fiveHour'],
  asOfMs: number,
): boolean | undefined {
  const existingReset = windowResetMs(existing.resetsAt);
  const nextReset = windowResetMs(next.resetsAt);
  if (existingReset === nextReset) return undefined;
  if (existingReset > 0 && asOfMs > 0 && existingReset <= asOfMs) return false;
  return existingReset > nextReset;
}

function windowPresenceChanged(existing: QuotaState, next: QuotaState): boolean {
  return (
    Boolean(existing.fiveHour.absent) !== Boolean(next.fiveHour.absent) ||
    Boolean(existing.sevenDay.absent) !== Boolean(next.sevenDay.absent)
  );
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

  // The plan's window layout changed (a window appeared or disappeared): the
  // reset times are not comparable, so the newer capture wins.
  if (windowPresenceChanged(existing, next)) {
    return snapshotTimeMs(existing) > snapshotTimeMs(next);
  }

  const asOfMs = snapshotTimeMs(next);
  const primary = compareWindowResets(existing.fiveHour, next.fiveHour, asOfMs);
  if (primary !== undefined) return primary;

  const secondary = compareWindowResets(existing.sevenDay, next.sevenDay, asOfMs);
  if (secondary !== undefined) return secondary;

  const existingUtilization = existing.fiveHour.utilization + existing.sevenDay.utilization;
  const nextUtilization = next.fiveHour.utilization + next.sevenDay.utilization;
  if (existingUtilization !== nextUtilization) return existingUtilization > nextUtilization;

  return snapshotTimeMs(existing) > snapshotTimeMs(next);
}

/**
 * Status-line and history samples only know the two headline windows. Keep
 * the plan label, extra usage, and still-running extra meters (e.g. a Fable
 * weekly cap) an earlier API sample recorded, so a fresh status-line write
 * does not erase them from every snapshot reader.
 */
function carryApiOnlyFields(existing: QuotaState, next: QuotaState): QuotaState {
  const merged: QuotaState = { ...next };
  if (merged.planLabel === undefined && existing.planLabel !== undefined) {
    merged.planLabel = existing.planLabel;
  }
  if (merged.planType === undefined && existing.planType !== undefined) {
    merged.planType = existing.planType;
  }
  if (merged.extraUsage === undefined && existing.extraUsage !== undefined) {
    merged.extraUsage = existing.extraUsage;
  }
  if (merged.limits === undefined && existing.limits !== undefined) {
    const asOfMs = snapshotTimeMs(next);
    // Headline meters duplicate the fresher windows on `next`; carry only the extras.
    const running = extraQuotaRows(existing).filter((row) => windowResetMs(row.resetsAt) > asOfMs);
    if (running.length > 0) merged.limits = running;
  }
  return merged;
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
    // `ageMs`, `freshness`, `stale`, and `capturedSource` are read-time facts: a
    // sample that came back from `readQuotaSnapshot()` and is written again keeps
    // its original source rather than being stored as `cache`.
    const { capturedSource, ...sample } = quota;
    delete sample.ageMs;
    delete sample.freshness;
    const snapshot: QuotaState = {
      ...sample,
      providerId,
      capturedAt: quota.capturedAt ?? new Date().toISOString(),
      source:
        sample.source && sample.source !== 'cache' ? sample.source : (capturedSource ?? 'session'),
      stale: false,
      resetCredits:
        quota.resetCredits ?? (providerId === 'codex' ? existingQuota?.resetCredits : undefined),
    };

    if (index >= 0 && shouldKeepExistingSnapshot(store.snapshots[index].quota, snapshot)) return;

    const record: QuotaSnapshotRecord = {
      providerId,
      accountId,
      quota: existingQuota ? carryApiOnlyFields(existingQuota, snapshot) : snapshot,
    };
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
 * tell a ten-second-old snapshot from a two-day-old one, and the original
 * origin is kept as `capturedSource` (`statusline`, `session`, or `api`).
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
  const storedSource = snapshot.quota.capturedSource ?? snapshot.quota.source;
  const capturedSource = storedSource && storedSource !== 'cache' ? storedSource : undefined;
  return {
    ...snapshot.quota,
    providerId,
    source: 'cache',
    ...(capturedSource ? { capturedSource } : {}),
    stale: true,
    ...(ageMs !== undefined ? { ageMs } : {}),
    freshness: classifyQuotaFreshness(ageMs),
  };
}
