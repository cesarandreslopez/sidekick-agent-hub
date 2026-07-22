import * as fs from 'fs';
import { getGlobalDataPath } from './paths';
import type { ErrorRollup, ErrorRollupEntry } from './aggregation/types';
import { updateJsonStoreAtomic } from './writers/atomic';

export const ERROR_HISTORY_SCHEMA_VERSION = 1 as const;
export const MAX_ERROR_HISTORY_SESSIONS = 500;

export interface ErrorHistorySessionRecord {
  sessionId: string;
  providerId: string;
  project: string;
  endedAt: string;
  failures: ErrorRollupEntry[];
  retryAttempts: number;
  finishReasons: Array<{ reason: string; count: number }>;
}

export interface ErrorHistoryStore {
  schemaVersion: 1;
  sessions: ErrorHistorySessionRecord[];
  lastSaved: string;
}

export interface TopFailingTool {
  tool: string;
  failures: number;
  categories: Record<string, number>;
}

function emptyStore(): ErrorHistoryStore {
  return {
    schemaVersion: ERROR_HISTORY_SCHEMA_VERSION,
    sessions: [],
    lastSaved: new Date().toISOString(),
  };
}

export async function appendErrorHistory(
  identity: { sessionId: string; providerId: string; project: string; endedAt?: string },
  rollup: ErrorRollup,
  filePath = getGlobalDataPath('error-history.json'),
): Promise<ErrorHistorySessionRecord> {
  const record: ErrorHistorySessionRecord = {
    ...identity,
    endedAt: identity.endedAt ?? new Date().toISOString(),
    failures: rollup.byToolCategory,
    retryAttempts: rollup.retryAttempts,
    finishReasons: rollup.finishReasons,
  };
  await updateJsonStoreAtomic(filePath, emptyStore, (store) => ({
    ...store,
    schemaVersion: ERROR_HISTORY_SCHEMA_VERSION,
    sessions: [...(Array.isArray(store.sessions) ? store.sessions : []), record].slice(
      -MAX_ERROR_HISTORY_SESSIONS,
    ),
    lastSaved: record.endedAt,
  }));
  return record;
}

export async function readErrorHistory(
  filePath = getGlobalDataPath('error-history.json'),
): Promise<ErrorHistoryStore> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as ErrorHistoryStore;
    if (parsed.schemaVersion === ERROR_HISTORY_SCHEMA_VERSION && Array.isArray(parsed.sessions))
      return parsed;
  } catch {
    // Missing and malformed history are represented as an empty store.
  }
  return emptyStore();
}

export async function getTopFailingTools(
  days = 7,
  now = new Date(),
  filePath = getGlobalDataPath('error-history.json'),
): Promise<TopFailingTool[]> {
  const cutoff = now.getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000;
  const store = await readErrorHistory(filePath);
  const tools = new Map<string, TopFailingTool>();
  for (const session of store.sessions) {
    const endedAt = Date.parse(session.endedAt);
    if (!Number.isFinite(endedAt) || endedAt < cutoff) continue;
    for (const failure of session.failures) {
      const item = tools.get(failure.tool) ?? { tool: failure.tool, failures: 0, categories: {} };
      item.failures += failure.count;
      item.categories[failure.category] = (item.categories[failure.category] ?? 0) + failure.count;
      tools.set(failure.tool, item);
    }
  }
  return Array.from(tools.values()).sort((left, right) => right.failures - left.failures);
}
