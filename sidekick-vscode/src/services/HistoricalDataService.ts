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
  TokenTotals,
  createEmptyDataStore,
  createEmptyTokenTotals,
  HISTORICAL_DATA_SCHEMA_VERSION,
} from '../types/historicalData';
import { PersistenceService, resolveSidekickDataPath } from './PersistenceService';
import { log } from './Logger';
import {
  applySessionSummary,
  calculateQualityTrend,
  formatLocalDateKey,
  isFileImported,
  markFileImported,
} from 'sidekick-shared';

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
    this.store.schemaVersion = HISTORICAL_DATA_SCHEMA_VERSION;
    this.store.sessions ??= [];
    log(
      `Loaded historical data: ${Object.keys(this.store.daily).length} days, ${this.store.allTime.sessionCount} sessions`,
    );
  }

  /**
   * Saves a completed session summary to historical data.
   *
   * Applies the shared `applySessionSummary()` mutation (the same one the CLI
   * importer uses), which replaces an earlier contribution from the same
   * session id and updates the daily, hourly, monthly, and all-time buckets.
   *
   * @param summary - Session summary from SessionMonitor.getSessionSummary()
   */
  saveSessionSummary(summary: SessionSummary): void {
    applySessionSummary(this.store, summary);
    this.markDirty();
    log(
      `Saved session ${summary.sessionId.slice(0, 8)} to historical data (${formatLocalDateKey(new Date(summary.startTime))})`,
    );
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
      return [
        {
          hour: 12,
          tokens: { ...dailyData.tokens },
          totalCost: dailyData.totalCost,
          messageCount: dailyData.messageCount,
          sessionCount: dailyData.sessionCount,
        },
      ];
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

  getSessionRecords() {
    return [...(this.store.sessions ?? [])];
  }

  getQualityTrend() {
    return calculateQualityTrend(this.store.sessions ?? []);
  }

  getLatestSessionRecord() {
    return this.store.sessions?.[this.store.sessions.length - 1] ?? null;
  }

  /**
   * Gets aggregated data for today.
   */
  getTodayData(): DailyData | null {
    const today = formatLocalDateKey(new Date());
    return this.store.daily[today] || null;
  }

  /**
   * Gets aggregated data for this week (last 7 days).
   */
  getThisWeekData(): DailyData[] {
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);

    const startDate = formatLocalDateKey(weekAgo);
    const endDate = formatLocalDateKey(today);

    return this.getDailyData(startDate, endDate);
  }

  /**
   * Gets aggregated data for this month.
   */
  getThisMonthData(): MonthlyData | null {
    const month = formatLocalDateKey(new Date()).substring(0, 7);
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
    return isFileImported(this.store, filePath);
  }

  /**
   * Marks a JSONL file as imported to prevent re-importing.
   *
   * @param filePath - Absolute path to the JSONL file
   */
  markFileImported(filePath: string): void {
    if (markFileImported(this.store, filePath)) this.markDirty();
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
