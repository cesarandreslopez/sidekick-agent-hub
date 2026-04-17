/**
 * On-disk schema types for historical session data.
 * Canonical source: sidekick-vscode/src/types/historicalData.ts
 *
 * Schema version 2 (2026-04-17) adds optional pricing-honesty fields:
 *   - ModelUsageRecord.priced: false when the model had no known pricing
 *     at the time the record was written. When false, `cost` is 0 and UIs
 *     render "—".
 *   - SessionSummary.unpricedModelIds: list of model IDs that fell back to
 *     $0 because pricing was unknown — surfaced in the dashboard footer.
 * Legacy records (schemaVersion 1 or missing) have neither field and should
 * be treated as fully priced.
 */

export const HISTORICAL_DATA_SCHEMA_VERSION = 2;

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface ModelUsageRecord {
  model: string;
  calls: number;
  tokens: number;
  /** Cost in USD. `0` when the model was unpriced (see `priced`). */
  cost: number;
  /**
   * Added in schema v2. `false` when no pricing was known for this model at
   * write time — `cost` is 0 in that case and UIs should render "—".
   * Omitted on legacy v1 records; treat as `true` when undefined.
   */
  priced?: boolean;
}

export interface ToolUsageRecord {
  tool: string;
  calls: number;
  successCount: number;
  failureCount: number;
}

export interface DailyData {
  date: string;
  tokens: TokenTotals;
  totalCost: number;
  messageCount: number;
  sessionCount: number;
  modelUsage: ModelUsageRecord[];
  toolUsage: ToolUsageRecord[];
  updatedAt: string;
}

export interface MonthlyData {
  month: string;
  tokens: TokenTotals;
  totalCost: number;
  messageCount: number;
  sessionCount: number;
  modelUsage: ModelUsageRecord[];
  toolUsage: ToolUsageRecord[];
  updatedAt: string;
}

export interface AllTimeStats {
  tokens: TokenTotals;
  totalCost: number;
  messageCount: number;
  sessionCount: number;
  firstDate: string;
  lastDate: string;
  modelUsage: ModelUsageRecord[];
  toolUsage: ToolUsageRecord[];
  updatedAt: string;
}

export interface HistoricalDataStore {
  schemaVersion: number;
  daily: Record<string, DailyData>;
  monthly: Record<string, MonthlyData>;
  allTime: AllTimeStats;
  lastSaved: string;
  importedFiles?: string[];
  lastImportTimestamp?: string;
}

export interface SessionSummary {
  sessionId: string;
  startTime: string;
  endTime: string;
  tokens: TokenTotals;
  /**
   * USD cost for the priced portion of the session. Models with unknown
   * pricing contribute 0 and are tracked in `unpricedModelIds`.
   */
  totalCost: number;
  messageCount: number;
  modelUsage: ModelUsageRecord[];
  toolUsage: ToolUsageRecord[];
  /**
   * Added in schema v2. Model IDs from this session that had no known
   * pricing. UIs should render a "N model(s) unpriced" indicator.
   * Omitted on v1 records or when every model was priced.
   */
  unpricedModelIds?: string[];
}

export function createEmptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
}
