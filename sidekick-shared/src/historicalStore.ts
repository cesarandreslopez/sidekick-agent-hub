/**
 * Pure mutations of the `historical-data.json` store.
 *
 * Ported verbatim from the VS Code extension's HistoricalDataService so the
 * CLI importer and the extension apply session summaries the same way:
 * a session's previous contribution is subtracted before the new one is
 * added (idempotent replacement), daily, hourly, monthly, and all-time
 * buckets are updated together, and the per-session record list is capped
 * at `HISTORICAL_SESSION_RETENTION_LIMIT`. Browser-safe: no Node imports.
 *
 * @module historicalStore
 */

import { formatLocalDateKey } from './formatting';
import type { SessionFileStats } from './providers/types';
import { HISTORICAL_SESSION_RETENTION_LIMIT, createEmptyTokenTotals } from './types/historicalData';
import type {
  DailyData,
  HistoricalDataStore,
  ModelUsageRecord,
  MonthlyData,
  SessionHistoryRecord,
  SessionSummary,
  TokenTotals,
  ToolUsageRecord,
} from './types/historicalData';

export interface ApplySessionSummaryOptions {
  /** Clock for `updatedAt` stamps (default `new Date()`). */
  now?: Date;
  /** Cap on `store.sessions` (default `HISTORICAL_SESSION_RETENTION_LIMIT`). */
  retentionLimit?: number;
}

interface UsageBucket {
  tokens: TokenTotals;
  totalCost: number;
  messageCount: number;
  sessionCount: number;
  modelUsage: ModelUsageRecord[];
  toolUsage: ToolUsageRecord[];
  updatedAt: string;
}

function mergeModelUsage(
  existing: ModelUsageRecord[],
  incoming: ModelUsageRecord[],
): ModelUsageRecord[] {
  const map = new Map<string, ModelUsageRecord>();
  for (const record of existing) map.set(record.model, { ...record });
  for (const record of incoming) {
    const current = map.get(record.model);
    if (current) {
      current.calls += record.calls;
      current.tokens += record.tokens;
      current.cost += record.cost;
      // Unpriced taints: if either side was unpriced, the merged row is too.
      // Legacy v1 records (priced === undefined) are assumed priced.
      if (record.priced === false || current.priced === false) current.priced = false;
    } else {
      map.set(record.model, { ...record });
    }
  }
  return Array.from(map.values());
}

function mergeToolUsage(
  existing: ToolUsageRecord[],
  incoming: ToolUsageRecord[],
): ToolUsageRecord[] {
  const map = new Map<string, ToolUsageRecord>();
  for (const record of existing) map.set(record.tool, { ...record });
  for (const record of incoming) {
    const current = map.get(record.tool);
    if (current) {
      current.calls += record.calls;
      current.successCount += record.successCount;
      current.failureCount += record.failureCount;
    } else {
      map.set(record.tool, { ...record });
    }
  }
  return Array.from(map.values());
}

function subtractTokenTotals(target: TokenTotals, contribution: TokenTotals): void {
  target.inputTokens = Math.max(0, target.inputTokens - contribution.inputTokens);
  target.outputTokens = Math.max(0, target.outputTokens - contribution.outputTokens);
  target.cacheWriteTokens = Math.max(0, target.cacheWriteTokens - contribution.cacheWriteTokens);
  target.cacheReadTokens = Math.max(0, target.cacheReadTokens - contribution.cacheReadTokens);
}

function subtractModelUsage(
  existing: ModelUsageRecord[],
  outgoing: ModelUsageRecord[],
): ModelUsageRecord[] {
  const map = new Map(existing.map((record) => [record.model, { ...record }]));
  for (const record of outgoing) {
    const current = map.get(record.model);
    if (!current) continue;
    current.calls = Math.max(0, current.calls - record.calls);
    current.tokens = Math.max(0, current.tokens - record.tokens);
    current.cost = Math.max(0, current.cost - record.cost);
    if (current.calls === 0 && current.tokens === 0) map.delete(record.model);
  }
  return [...map.values()];
}

function subtractToolUsage(
  existing: ToolUsageRecord[],
  outgoing: ToolUsageRecord[],
): ToolUsageRecord[] {
  const map = new Map(existing.map((record) => [record.tool, { ...record }]));
  for (const record of outgoing) {
    const current = map.get(record.tool);
    if (!current) continue;
    current.calls = Math.max(0, current.calls - record.calls);
    current.successCount = Math.max(0, current.successCount - record.successCount);
    current.failureCount = Math.max(0, current.failureCount - record.failureCount);
    if (current.calls === 0) map.delete(record.tool);
  }
  return [...map.values()];
}

function subtractSummary(bucket: UsageBucket, summary: SessionSummary, now: Date): void {
  subtractTokenTotals(bucket.tokens, summary.tokens);
  bucket.totalCost = Math.max(0, bucket.totalCost - summary.totalCost);
  bucket.messageCount = Math.max(0, bucket.messageCount - summary.messageCount);
  bucket.sessionCount = Math.max(0, bucket.sessionCount - 1);
  bucket.modelUsage = subtractModelUsage(bucket.modelUsage, summary.modelUsage);
  bucket.toolUsage = subtractToolUsage(bucket.toolUsage, summary.toolUsage);
  bucket.updatedAt = now.toISOString();
}

function accumulateSummary(bucket: UsageBucket, summary: SessionSummary, now: Date): void {
  bucket.tokens.inputTokens += summary.tokens.inputTokens;
  bucket.tokens.outputTokens += summary.tokens.outputTokens;
  bucket.tokens.cacheWriteTokens += summary.tokens.cacheWriteTokens;
  bucket.tokens.cacheReadTokens += summary.tokens.cacheReadTokens;
  bucket.totalCost += summary.totalCost;
  bucket.messageCount += summary.messageCount;
  bucket.sessionCount += 1;
  bucket.modelUsage = mergeModelUsage(bucket.modelUsage, summary.modelUsage);
  bucket.toolUsage = mergeToolUsage(bucket.toolUsage, summary.toolUsage);
  bucket.updatedAt = now.toISOString();
}

function emptyDaily(date: string, now: Date): DailyData {
  return {
    date,
    tokens: createEmptyTokenTotals(),
    totalCost: 0,
    messageCount: 0,
    sessionCount: 0,
    modelUsage: [],
    toolUsage: [],
    updatedAt: now.toISOString(),
  };
}

function emptyMonthly(month: string, now: Date): MonthlyData {
  return {
    month,
    tokens: createEmptyTokenTotals(),
    totalCost: 0,
    messageCount: 0,
    sessionCount: 0,
    modelUsage: [],
    toolUsage: [],
    updatedAt: now.toISOString(),
  };
}

function refreshAllTimeDateRange(store: HistoricalDataStore): void {
  const dates = Object.keys(store.daily).sort();
  store.allTime.firstDate = dates[0] ?? '';
  store.allTime.lastDate = dates[dates.length - 1] ?? '';
}

/** Subtract a previously saved session's contribution from every bucket. */
export function removeSessionSummary(
  store: HistoricalDataStore,
  record: SessionHistoryRecord,
  now: Date = new Date(),
): void {
  const summary: SessionSummary = {
    sessionId: record.sessionId,
    startTime: record.startTime,
    endTime: record.endTime,
    tokens: { ...record.tokens },
    totalCost: record.totalCost,
    messageCount: record.messageCount,
    modelUsage: record.modelUsage?.map((usage) => ({ ...usage })) ?? [],
    toolUsage: record.toolUsage?.map((usage) => ({ ...usage })) ?? [],
    unpricedModelIds: record.unpricedModelIds ? [...record.unpricedModelIds] : undefined,
  };
  const date = formatLocalDateKey(new Date(record.startTime));
  const month = date.substring(0, 7);

  const daily = store.daily[date];
  if (daily) {
    subtractSummary(daily, summary, now);
    if (daily.sessionCount === 0) delete store.daily[date];
  }

  const hourly = store.hourly?.[date];
  if (hourly && store.hourly) {
    const hour = new Date(record.startTime).getHours();
    const bucket = hourly.find((entry) => entry.hour === hour);
    if (bucket) {
      subtractTokenTotals(bucket.tokens, summary.tokens);
      bucket.totalCost = Math.max(0, bucket.totalCost - summary.totalCost);
      bucket.messageCount = Math.max(0, bucket.messageCount - summary.messageCount);
      bucket.sessionCount = Math.max(0, bucket.sessionCount - 1);
    }
    store.hourly[date] = hourly.filter((entry) => entry.sessionCount > 0);
    if (store.hourly[date].length === 0) delete store.hourly[date];
  }

  const monthly = store.monthly[month];
  if (monthly) {
    subtractSummary(monthly, summary, now);
    if (monthly.sessionCount === 0) delete store.monthly[month];
  }

  subtractSummary(store.allTime, summary, now);
}

/**
 * Apply a completed session to the daily, hourly, monthly, and all-time
 * buckets and the capped per-session list. Re-applying the same session id
 * replaces its earlier contribution instead of double counting it.
 *
 * Returns the stored per-session record.
 */
export function applySessionSummary(
  store: HistoricalDataStore,
  summary: SessionSummary,
  options: ApplySessionSummaryOptions = {},
): SessionHistoryRecord {
  const now = options.now ?? new Date();
  const retentionLimit = options.retentionLimit ?? HISTORICAL_SESSION_RETENTION_LIMIT;
  const date = formatLocalDateKey(new Date(summary.startTime));
  const month = date.substring(0, 7);

  store.sessions ??= [];
  const previous = store.sessions.find((session) => session.sessionId === summary.sessionId);
  if (previous) removeSessionSummary(store, previous, now);

  // Daily
  store.daily[date] ??= emptyDaily(date, now);
  accumulateSummary(store.daily[date], summary, now);

  // Hourly (by the session's local start hour)
  store.hourly ??= {};
  store.hourly[date] ??= [];
  const hour = new Date(summary.startTime).getHours();
  let hourly = store.hourly[date].find((entry) => entry.hour === hour);
  if (!hourly) {
    hourly = {
      hour,
      tokens: createEmptyTokenTotals(),
      totalCost: 0,
      messageCount: 0,
      sessionCount: 0,
    };
    store.hourly[date].push(hourly);
  }
  hourly.tokens.inputTokens += summary.tokens.inputTokens;
  hourly.tokens.outputTokens += summary.tokens.outputTokens;
  hourly.tokens.cacheWriteTokens += summary.tokens.cacheWriteTokens;
  hourly.tokens.cacheReadTokens += summary.tokens.cacheReadTokens;
  hourly.totalCost += summary.totalCost;
  hourly.messageCount += summary.messageCount;
  hourly.sessionCount += 1;

  // Monthly
  store.monthly[month] ??= emptyMonthly(month, now);
  accumulateSummary(store.monthly[month], summary, now);

  // All-time
  accumulateSummary(store.allTime, summary, now);
  if (!store.allTime.firstDate || date < store.allTime.firstDate) store.allTime.firstDate = date;
  if (!store.allTime.lastDate || date > store.allTime.lastDate) store.allTime.lastDate = date;

  const record: SessionHistoryRecord = {
    sessionId: summary.sessionId,
    provider: summary.provider ?? 'unknown',
    project: summary.project ?? 'unknown',
    startTime: summary.startTime,
    endTime: summary.endTime,
    tokens: { ...summary.tokens },
    totalCost: summary.totalCost,
    messageCount: summary.messageCount,
    modelUsage: summary.modelUsage.map((usage) => ({ ...usage })),
    toolUsage: summary.toolUsage.map((usage) => ({ ...usage })),
    unpricedModelIds: summary.unpricedModelIds ? [...summary.unpricedModelIds] : undefined,
    qualityScore: summary.qualityScore ?? 0,
    qualityFactors: summary.qualityFactors ?? [],
    additions: summary.additions ?? 0,
    deletions: summary.deletions ?? 0,
    costPerChangedLine: summary.costPerChangedLine ?? null,
  };
  store.sessions = [
    ...store.sessions.filter((session) => session.sessionId !== summary.sessionId),
    record,
  ].slice(-retentionLimit);

  refreshAllTimeDateRange(store);
  return record;
}

/** Whether a session file has already been folded into the store. */
export function isFileImported(store: HistoricalDataStore, filePath: string): boolean {
  return store.importedFiles?.includes(filePath) ?? false;
}

/** Record a session file as imported. Returns false when it was already listed. */
export function markFileImported(
  store: HistoricalDataStore,
  filePath: string,
  now: Date = new Date(),
): boolean {
  store.importedFiles ??= [];
  if (store.importedFiles.includes(filePath)) return false;
  store.importedFiles.push(filePath);
  store.lastImportTimestamp = now.toISOString();
  return true;
}

export interface SessionSummaryFromStatsOptions {
  /** Session provider id stored on the record (default `stats.providerId`). */
  provider?: string;
  /** Workspace path stored on the record (default `'unknown'`). */
  project?: string | null;
}

/**
 * Build the summary the history store expects from unified session stats,
 * so the CLI importer and the extension's first-activation import store the
 * same per-model cost, tool success/failure split, and unpriced markers.
 * Pending tool calls count as successes (stats only split out failures).
 */
export function sessionSummaryFromStats(
  stats: SessionFileStats,
  options: SessionSummaryFromStatsOptions = {},
): SessionSummary {
  const modelUsage: ModelUsageRecord[] = Object.entries(stats.modelUsage).map(([model, usage]) => ({
    model,
    calls: usage.calls,
    tokens: usage.tokens,
    cost: usage.costUsd,
    priced: usage.priced,
  }));
  const unpricedModelIds = modelUsage.filter((m) => m.priced === false).map((m) => m.model);
  const toolUsage: ToolUsageRecord[] = Object.entries(stats.toolUsage).map(([tool, calls]) => {
    const failureCount = stats.toolFailures[tool] ?? 0;
    return { tool, calls, successCount: Math.max(0, calls - failureCount), failureCount };
  });
  return {
    sessionId: stats.sessionId,
    startTime: stats.startTime,
    endTime: stats.endTime || stats.startTime,
    tokens: {
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheWriteTokens: stats.tokens.cacheWrite,
      cacheReadTokens: stats.tokens.cacheRead,
    },
    totalCost: stats.costUsd,
    messageCount: stats.messageCount,
    modelUsage,
    toolUsage,
    ...(unpricedModelIds.length > 0 ? { unpricedModelIds } : {}),
    provider: options.provider ?? stats.providerId,
    project: options.project ?? 'unknown',
  };
}
