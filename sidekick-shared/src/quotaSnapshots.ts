import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './paths';
import type { QuotaState } from './quota';
import type { AccountProviderId } from './accountRegistry';

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

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const json = JSON.stringify(data, null, 2);
  // Throws if `data` was undefined or a top-level non-serializable value — prevents writing the literal string "undefined" to disk.
  JSON.parse(json);
  try {
    fs.writeFileSync(tmp, json, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }
}

function readStore(): QuotaSnapshotStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(getQuotaSnapshotPath(), 'utf8')) as QuotaSnapshotStore;
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
  atomicWriteJson(getQuotaSnapshotPath(), store);
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
  const existingPrimaryReset = windowResetMs(existing.fiveHour.resetsAt);
  const nextPrimaryReset = windowResetMs(next.fiveHour.resetsAt);
  if (existingPrimaryReset !== nextPrimaryReset) return existingPrimaryReset > nextPrimaryReset;

  const existingSecondaryReset = windowResetMs(existing.sevenDay.resetsAt);
  const nextSecondaryReset = windowResetMs(next.sevenDay.resetsAt);
  if (existingSecondaryReset !== nextSecondaryReset) return existingSecondaryReset > nextSecondaryReset;

  const existingUtilization = existing.fiveHour.utilization + existing.sevenDay.utilization;
  const nextUtilization = next.fiveHour.utilization + next.sevenDay.utilization;
  if (existingUtilization !== nextUtilization) return existingUtilization > nextUtilization;

  return snapshotTimeMs(existing) > snapshotTimeMs(next);
}

export function writeQuotaSnapshot(providerId: QuotaSnapshotProviderId, accountId: string, quota: QuotaState): void {
  const store = readStore();
  const snapshot: QuotaState = {
    ...quota,
    providerId,
    capturedAt: quota.capturedAt ?? new Date().toISOString(),
    source: quota.source ?? 'session',
    stale: false,
  };

  const index = store.snapshots.findIndex(item => item.providerId === providerId && item.accountId === accountId);
  if (index >= 0 && shouldKeepExistingSnapshot(store.snapshots[index].quota, snapshot)) {
    return;
  }

  const record: QuotaSnapshotRecord = {
    providerId,
    accountId,
    quota: snapshot,
  };

  if (index >= 0) {
    store.snapshots[index] = record;
  } else {
    store.snapshots.push(record);
  }

  writeStore(store);
}

export function readQuotaSnapshot(providerId: QuotaSnapshotProviderId, accountId: string): QuotaState | null {
  const store = readStore();
  const snapshot = store.snapshots.find(item => item.providerId === providerId && item.accountId === accountId);
  if (!snapshot) return null;

  return {
    ...snapshot.quota,
    providerId,
    source: 'cache',
    stale: true,
  };
}
