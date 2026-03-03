/**
 * @fileoverview Historical data persistence service for session analytics.
 *
 * This service manages long-term storage of Claude Code session statistics,
 * aggregating data into daily, monthly, and all-time buckets. Data is stored
 * in a JSON file in the user's config directory.
 *
 * Storage location:
 * - Linux/Mac: ~/.config/sidekick/historical-data.json
 * - Windows: %APPDATA%/sidekick/historical-data.json
 *
 * @module services/HistoricalDataService
 */

import {
  HistoricalDataStore,
  DailyData,
  HourlyData,
  MonthlyData,
  SessionSummary,
  ModelUsageRecord,
  ToolUsageRecord,
  TokenTotals,
  createEmptyDataStore,
  createEmptyTokenTotals,
  HISTORICAL_DATA_SCHEMA_VERSION,
} from '../types/historicalData';
import { PersistenceService, resolveSidekickDataPath } from './PersistenceService';
import { log } from './Logger';

/**
 * Service for persisting and aggregating historical session data.
 *
 * Provides methods to save session summaries and query aggregated data
 * across different time ranges.
 *
 * @example
 * ```typescript
 * const service = new HistoricalDataService();
 * await service.initialize();
 *
 * // Save a completed session
 * service.saveSessionSummary(sessionSummary);
 *
 * // Query data
 * const today = service.getDailyData('2026-02-03', '2026-02-03');
 * const allTime = service.getAllTimeStats();
 * ```
 */
export class HistoricalDataService extends PersistenceService<HistoricalDataStore> {
  constructor() {
    super(
      resolveSidekickDataPath('', 'historical-data.json'),
      'Historical data',
      HISTORICAL_DATA_SCHEMA_VERSION,
      createEmptyDataStore,
    );
  }

  protected override onStoreLoaded(): void {
    log(`Loaded historical data: ${Object.keys(this.store.daily).length} days, ${this.store.allTime.sessionCount} sessions`);
  }

  /**
   * Saves a completed session summary to historical data.
   *
   * Aggregates the session data into daily, monthly, and all-time buckets.
   *
   * @param summary - Session summary from SessionMonitor.getSessionSummary()
   */
  saveSessionSummary(summary: SessionSummary): void {
    const date = summary.startTime.split('T')[0]; // YYYY-MM-DD
    const month = date.substring(0, 7); // YYYY-MM

    // Update daily data
    this.updateDailyData(date, summary);

    // Update hourly data
    this.updateHourlyData(date, summary);

    // Update monthly data
    this.updateMonthlyData(month, summary);

    // Update all-time stats
    this.updateAllTimeStats(date, summary);

    this.markDirty();

    log(`Saved session ${summary.sessionId.slice(0, 8)} to historical data (${date})`);
  }

  /**
   * Accumulates tokens, cost, message count, and usage from a summary into a bucket.
   */
  private accumulateSummary(
    bucket: { tokens: TokenTotals; totalCost: number; messageCount: number; sessionCount: number; modelUsage: ModelUsageRecord[]; toolUsage: ToolUsageRecord[]; updatedAt: string },
    summary: SessionSummary
  ): void {
    bucket.tokens.inputTokens += summary.tokens.inputTokens;
    bucket.tokens.outputTokens += summary.tokens.outputTokens;
    bucket.tokens.cacheWriteTokens += summary.tokens.cacheWriteTokens;
    bucket.tokens.cacheReadTokens += summary.tokens.cacheReadTokens;
    bucket.totalCost += summary.totalCost;
    bucket.messageCount += summary.messageCount;
    bucket.sessionCount += 1;
    bucket.modelUsage = this.mergeModelUsage(bucket.modelUsage, summary.modelUsage);
    bucket.toolUsage = this.mergeToolUsage(bucket.toolUsage, summary.toolUsage);
    bucket.updatedAt = new Date().toISOString();
  }

  /**
   * Updates daily data with a session summary.
   */
  private updateDailyData(date: string, summary: SessionSummary): void {
    if (!this.store.daily[date]) {
      this.store.daily[date] = {
        date,
        tokens: createEmptyTokenTotals(),
        totalCost: 0,
        messageCount: 0,
        sessionCount: 0,
        modelUsage: [],
        toolUsage: [],
        updatedAt: new Date().toISOString(),
      };
    }

    this.accumulateSummary(this.store.daily[date], summary);
  }

  /**
   * Updates hourly data with a session summary.
   *
   * Extracts the hour from the session start time and accumulates
   * into the corresponding hourly bucket for that day.
   */
  private updateHourlyData(date: string, summary: SessionSummary): void {
    // Initialize hourly store if needed
    if (!this.store.hourly) {
      this.store.hourly = {};
    }

    if (!this.store.hourly[date]) {
      this.store.hourly[date] = [];
    }

    // Extract hour from session start time
    const startDate = new Date(summary.startTime);
    const hour = startDate.getHours();

    // Find or create the hourly bucket
    let bucket = this.store.hourly[date].find(h => h.hour === hour);
    if (!bucket) {
      bucket = {
        hour,
        tokens: createEmptyTokenTotals(),
        totalCost: 0,
        messageCount: 0,
        sessionCount: 0,
      };
      this.store.hourly[date].push(bucket);
    }

    // Accumulate into the hourly bucket
    bucket.tokens.inputTokens += summary.tokens.inputTokens;
    bucket.tokens.outputTokens += summary.tokens.outputTokens;
    bucket.tokens.cacheWriteTokens += summary.tokens.cacheWriteTokens;
    bucket.tokens.cacheReadTokens += summary.tokens.cacheReadTokens;
    bucket.totalCost += summary.totalCost;
    bucket.messageCount += summary.messageCount;
    bucket.sessionCount += 1;
  }

  /**
   * Updates monthly data with a session summary.
   */
  private updateMonthlyData(month: string, summary: SessionSummary): void {
    if (!this.store.monthly[month]) {
      this.store.monthly[month] = {
        month,
        tokens: createEmptyTokenTotals(),
        totalCost: 0,
        messageCount: 0,
        sessionCount: 0,
        modelUsage: [],
        toolUsage: [],
        updatedAt: new Date().toISOString(),
      };
    }

    this.accumulateSummary(this.store.monthly[month], summary);
  }

  /**
   * Updates all-time stats with a session summary.
   */
  private updateAllTimeStats(date: string, summary: SessionSummary): void {
    const allTime = this.store.allTime;

    this.accumulateSummary(allTime, summary);

    // Update date range
    if (!allTime.firstDate || date < allTime.firstDate) {
      allTime.firstDate = date;
    }
    if (!allTime.lastDate || date > allTime.lastDate) {
      allTime.lastDate = date;
    }
  }

  /**
   * Merges model usage records, combining by model name.
   */
  private mergeModelUsage(existing: ModelUsageRecord[], incoming: ModelUsageRecord[]): ModelUsageRecord[] {
    const map = new Map<string, ModelUsageRecord>();

    for (const record of existing) {
      map.set(record.model, { ...record });
    }

    for (const record of incoming) {
      const current = map.get(record.model);
      if (current) {
        current.calls += record.calls;
        current.tokens += record.tokens;
        current.cost += record.cost;
      } else {
        map.set(record.model, { ...record });
      }
    }

    return Array.from(map.values());
  }

  /**
   * Merges tool usage records, combining by tool name.
   */
  private mergeToolUsage(existing: ToolUsageRecord[], incoming: ToolUsageRecord[]): ToolUsageRecord[] {
    const map = new Map<string, ToolUsageRecord>();

    for (const record of existing) {
      map.set(record.tool, { ...record });
    }

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

  /**
   * Gets daily data for a date range.
   *
   * @param startDate - Start date in YYYY-MM-DD format (inclusive)
   * @param endDate - End date in YYYY-MM-DD format (inclusive)
   * @returns Array of daily data within the range
   */
  getDailyData(startDate: string, endDate: string): DailyData[] {
    const results: DailyData[] = [];

    for (const [date, data] of Object.entries(this.store.daily)) {
      if (date >= startDate && date <= endDate) {
        results.push(data);
      }
    }

    // Sort by date ascending
    return results.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Gets hourly data for a specific date.
   *
   * Returns hourly buckets for the given date, sorted by hour (0-23).
   * If no hourly data was recorded (older data without hourly tracking),
   * falls back to distributing the day's daily totals as a single
   * aggregated bucket covering the whole day.
   *
   * @param date - Date in YYYY-MM-DD format
   * @returns Array of hourly data buckets for that date, sorted by hour ascending
   */
  getHourlyData(date: string): HourlyData[] {
    // Check for stored hourly data first
    if (this.store.hourly?.[date] && this.store.hourly[date].length > 0) {
      return [...this.store.hourly[date]].sort((a, b) => a.hour - b.hour);
    }

    // Fall back: synthesize from daily data if available
    // Distribute the daily total evenly across a single "all-day" bucket at hour 12
    // so the chart shows something meaningful for legacy data
    const dailyData = this.store.daily[date];
    if (dailyData) {
      return [{
        hour: 12,
        tokens: { ...dailyData.tokens },
        totalCost: dailyData.totalCost,
        messageCount: dailyData.messageCount,
        sessionCount: dailyData.sessionCount,
      }];
    }

    return [];
  }

  /**
   * Gets monthly data for a month range.
   *
   * @param startMonth - Start month in YYYY-MM format (inclusive)
   * @param endMonth - End month in YYYY-MM format (inclusive)
   * @returns Array of monthly data within the range
   */
  getMonthlyData(startMonth: string, endMonth: string): MonthlyData[] {
    const results: MonthlyData[] = [];

    for (const [month, data] of Object.entries(this.store.monthly)) {
      if (month >= startMonth && month <= endMonth) {
        results.push(data);
      }
    }

    // Sort by month ascending
    return results.sort((a, b) => a.month.localeCompare(b.month));
  }

  /**
   * Gets all-time statistics.
   */
  getAllTimeStats(): HistoricalDataStore['allTime'] {
    return { ...this.store.allTime };
  }

  /**
   * Gets aggregated data for today.
   */
  getTodayData(): DailyData | null {
    const today = new Date().toISOString().split('T')[0];
    return this.store.daily[today] || null;
  }

  /**
   * Gets aggregated data for this week (last 7 days).
   */
  getThisWeekData(): DailyData[] {
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);

    const startDate = weekAgo.toISOString().split('T')[0];
    const endDate = today.toISOString().split('T')[0];

    return this.getDailyData(startDate, endDate);
  }

  /**
   * Gets aggregated data for this month.
   */
  getThisMonthData(): MonthlyData | null {
    const month = new Date().toISOString().substring(0, 7);
    return this.store.monthly[month] || null;
  }

  /**
   * Aggregates token totals from an array of records.
   */
  aggregateTokens(records: Array<{ tokens: TokenTotals }>): TokenTotals {
    const result = createEmptyTokenTotals();

    for (const record of records) {
      result.inputTokens += record.tokens.inputTokens;
      result.outputTokens += record.tokens.outputTokens;
      result.cacheWriteTokens += record.tokens.cacheWriteTokens;
      result.cacheReadTokens += record.tokens.cacheReadTokens;
    }

    return result;
  }

  // ============================================================
  // Retroactive Import Support Methods
  // ============================================================

  /**
   * Checks if a JSONL file has already been imported.
   *
   * @param filePath - Absolute path to the JSONL file
   * @returns true if already imported
   */
  isFileImported(filePath: string): boolean {
    return this.store.importedFiles?.includes(filePath) ?? false;
  }

  /**
   * Marks a JSONL file as imported to prevent re-importing.
   *
   * @param filePath - Absolute path to the JSONL file
   */
  markFileImported(filePath: string): void {
    if (!this.store.importedFiles) {
      this.store.importedFiles = [];
    }

    if (!this.store.importedFiles.includes(filePath)) {
      this.store.importedFiles.push(filePath);
      this.store.lastImportTimestamp = new Date().toISOString();
      this.markDirty();
    }
  }

  /**
   * Gets the list of already-imported JSONL file paths.
   *
   * @returns Array of imported file paths
   */
  getImportedFiles(): string[] {
    return this.store.importedFiles ?? [];
  }

  /**
   * Clears all historical data and import tracking.
   *
   * Use with caution - this deletes all stored analytics data.
   */
  clearAllData(): void {
    this.store = createEmptyDataStore();
    this.markDirty();
    log('Historical data cleared');
  }
}
