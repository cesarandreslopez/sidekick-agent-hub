/**
 * @fileoverview Type definitions for historical session data.
 *
 * This module defines types for persisting and aggregating Claude Code session
 * data across days, months, and all-time. Used by HistoricalDataService for
 * long-term analytics storage.
 *
 * @module types/historicalData
 */

/**
 * Schema version for data migrations.
 *
 * v2 (2026-04-17):
 *   - `ModelUsageRecord.priced?: boolean` — false when the model had no known
 *     pricing at write time (cost is 0 and UIs render "—").
 *   - `SessionSummary.unpricedModelIds?: string[]` — list of models that fell
 *     back to $0 because pricing was unknown.
 *   Legacy v1 records are read as-is; missing fields mean "fully priced".
 *   No retroactive migration — fix forward only.
 */
export const HISTORICAL_DATA_SCHEMA_VERSION = 2;

/**
 * Token usage totals by category.
 */
export interface TokenTotals {
  /** Total input tokens consumed */
  inputTokens: number;

  /** Total output tokens generated */
  outputTokens: number;

  /** Total tokens written to cache */
  cacheWriteTokens: number;

  /** Total tokens read from cache */
  cacheReadTokens: number;
}

/**
 * Usage record for a specific model (Claude, GPT, o-series, etc).
 */
export interface ModelUsageRecord {
  /** Model identifier (e.g., "claude-opus-4-20250514", "gpt-5.4") */
  model: string;

  /** Number of API calls to this model */
  calls: number;

  /** Total tokens (input + output) used by this model */
  tokens: number;

  /** Cost in USD for the priced portion. `0` when `priced === false`. */
  cost: number;

  /**
   * Schema v2+. `false` when no pricing was known for this model at write
   * time — cost is 0 and the UI should render "—" instead of "$0". Omit on
   * v1 records; treat `undefined` as `true` (fully priced).
   */
  priced?: boolean;
}

/**
 * Usage record for a specific tool.
 */
export interface ToolUsageRecord {
  /** Tool name (e.g., "Read", "Write", "Bash") */
  tool: string;

  /** Total number of calls */
  calls: number;

  /** Number of successful completions */
  successCount: number;

  /** Number of failed completions */
  failureCount: number;
}

/**
 * Aggregated data for a single day.
 */
export interface DailyData {
  /** Date in YYYY-MM-DD format */
  date: string;

  /** Token usage totals for the day */
  tokens: TokenTotals;

  /** Total estimated cost in USD */
  totalCost: number;

  /** Number of messages (API calls) */
  messageCount: number;

  /** Number of sessions that contributed data */
  sessionCount: number;

  /** Per-model usage breakdown */
  modelUsage: ModelUsageRecord[];

  /** Per-tool usage breakdown */
  toolUsage: ToolUsageRecord[];

  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Aggregated data for a single hour within a day.
 */
export interface HourlyData {
  /** Hour of the day (0-23) */
  hour: number;

  /** Token usage totals for the hour */
  tokens: TokenTotals;

  /** Total estimated cost in USD */
  totalCost: number;

  /** Number of messages (API calls) */
  messageCount: number;

  /** Number of sessions that contributed data */
  sessionCount: number;
}

/**
 * Aggregated data for a single month.
 */
export interface MonthlyData {
  /** Month in YYYY-MM format */
  month: string;

  /** Token usage totals for the month */
  tokens: TokenTotals;

  /** Total estimated cost in USD */
  totalCost: number;

  /** Number of messages (API calls) */
  messageCount: number;

  /** Number of sessions that contributed data */
  sessionCount: number;

  /** Per-model usage breakdown */
  modelUsage: ModelUsageRecord[];

  /** Per-tool usage breakdown */
  toolUsage: ToolUsageRecord[];

  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * All-time aggregated statistics.
 */
export interface AllTimeStats {
  /** Token usage totals across all time */
  tokens: TokenTotals;

  /** Total estimated cost in USD */
  totalCost: number;

  /** Number of messages (API calls) */
  messageCount: number;

  /** Number of sessions tracked */
  sessionCount: number;

  /** First date with recorded data (YYYY-MM-DD) */
  firstDate: string;

  /** Last date with recorded data (YYYY-MM-DD) */
  lastDate: string;

  /** Model usage breakdown */
  modelUsage: ModelUsageRecord[];

  /** Tool usage breakdown */
  toolUsage: ToolUsageRecord[];

  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Complete historical data store persisted to disk.
 */
export interface HistoricalDataStore {
  /** Schema version for migrations */
  schemaVersion: number;

  /** Daily data keyed by YYYY-MM-DD */
  daily: Record<string, DailyData>;

  /** Hourly data keyed by YYYY-MM-DD, each containing an array of HourlyData buckets */
  hourly?: Record<string, HourlyData[]>;

  /** Monthly data keyed by YYYY-MM */
  monthly: Record<string, MonthlyData>;

  /** All-time statistics */
  allTime: AllTimeStats;

  /** ISO timestamp of last save */
  lastSaved: string;

  /** JSONL file paths already imported (prevents duplicates during retroactive import) */
  importedFiles?: string[];

  /** ISO timestamp of when the last retroactive import completed */
  lastImportTimestamp?: string;
}

/**
 * Summary of a completed session for aggregation.
 *
 * Created by SessionMonitor.getSessionSummary() when a session ends.
 */
export interface SessionSummary {
  /** Unique session identifier */
  sessionId: string;

  /** ISO timestamp when session started */
  startTime: string;

  /** ISO timestamp when session ended */
  endTime: string;

  /** Token usage totals for the session */
  tokens: TokenTotals;

  /** Total estimated cost in USD */
  totalCost: number;

  /** Number of messages (API calls) in session */
  messageCount: number;

  /** Per-model usage breakdown */
  modelUsage: ModelUsageRecord[];

  /** Per-tool usage breakdown */
  toolUsage: ToolUsageRecord[];

  /**
   * Schema v2+. Model IDs whose usage contributed 0 to `totalCost` because
   * pricing was unknown. Surfaced to the UI as a "N model(s) unpriced"
   * indicator. Omitted when every model in the session was priced.
   */
  unpricedModelIds?: string[];
}

/**
 * Creates empty token totals.
 */
export function createEmptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
}

/**
 * Creates an empty historical data store.
 */
export function createEmptyDataStore(): HistoricalDataStore {
  const now = new Date().toISOString();
  return {
    schemaVersion: HISTORICAL_DATA_SCHEMA_VERSION,
    daily: {},
    monthly: {},
    allTime: {
      tokens: createEmptyTokenTotals(),
      totalCost: 0,
      messageCount: 0,
      sessionCount: 0,
      firstDate: '',
      lastDate: '',
      modelUsage: [],
      toolUsage: [],
      updatedAt: now,
    },
    lastSaved: now,
  };
}
