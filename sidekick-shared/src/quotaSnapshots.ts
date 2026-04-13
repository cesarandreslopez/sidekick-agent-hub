import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './paths';
import type { QuotaState } from './quota';
import type { AccountProviderId } from './accountRegistry';

interface QuotaSnapshotRecord {
  providerId: AccountProviderId;
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
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  JSON.parse(json);
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode });
  fs.renameSync(tmp, filePath);
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

export function writeQuotaSnapshot(providerId: AccountProviderId, accountId: string, quota: QuotaState): void {
  const store = readStore();
  const snapshot: QuotaState = {
    ...quota,
    providerId,
    capturedAt: quota.capturedAt ?? new Date().toISOString(),
    source: quota.source ?? 'session',
    stale: false,
  };

  const index = store.snapshots.findIndex(item => item.providerId === providerId && item.accountId === accountId);
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

export function readQuotaSnapshot(providerId: AccountProviderId, accountId: string): QuotaState | null {
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
