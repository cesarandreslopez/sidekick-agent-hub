/**
 * On-disk schema types for historical session data.
 * Canonical source: sidekick-vscode/src/types/historicalData.ts
 */

export const HISTORICAL_DATA_SCHEMA_VERSION = 1;

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
  cost: number;
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
  totalCost: number;
  messageCount: number;
  modelUsage: ModelUsageRecord[];
  toolUsage: ToolUsageRecord[];
}

export function createEmptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
}
