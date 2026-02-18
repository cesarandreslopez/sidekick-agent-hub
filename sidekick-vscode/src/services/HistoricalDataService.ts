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

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  HistoricalDataStore,
  DailyData,
  MonthlyData,
  SessionSummary,
  ModelUsageRecord,
  ToolUsageRecord,
  TokenTotals,
  createEmptyDataStore,
  createEmptyTokenTotals,
  HISTORICAL_DATA_SCHEMA_VERSION,
} from '../types/historicalData';
import { log, logError } from './Logger';

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
export class HistoricalDataService implements vscode.Disposable {
  /** Data file name */
  private static readonly DATA_FILE = 'historical-data.json';

  /** In-memory data store */
  private store: HistoricalDataStore;

  /** Path to data file */
  private dataFilePath: string;

  /** Whether data has unsaved changes */
  private isDirty: boolean = false;

  /** Debounce timer for saves */
  private saveTimer: NodeJS.Timeout | null = null;

  /** Save debounce delay (5 seconds) */
  private readonly SAVE_DEBOUNCE_MS = 5000;

  /**
   * Creates a new HistoricalDataService.
   *
   * Call initialize() before using other methods.
   */
  constructor() {
    this.store = createEmptyDataStore();
    this.dataFilePath = this.getDataFilePath();
  }

  /**
   * Gets the path to the data file based on platform.
   */
  private getDataFilePath(): string {
    let configDir: string;

    if (process.platform === 'win32') {
      // Windows: %APPDATA%/sidekick/
      configDir = path.join(process.env.APPDATA || os.homedir(), 'sidekick');
    } else {
      // Linux/Mac: ~/.config/sidekick/
      configDir = path.join(os.homedir(), '.config', 'sidekick');
    }

    return path.join(configDir, HistoricalDataService.DATA_FILE);
  }

  /**
   * Initializes the service by loading existing data or creating new store.
   */
  async initialize(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`Created historical data directory: ${dir}`);
      }

      // Load existing data if present
      if (fs.existsSync(this.dataFilePath)) {
        const content = await fs.promises.readFile(this.dataFilePath, 'utf-8');
        const loaded = JSON.parse(content) as HistoricalDataStore;

        // Check schema version for future migrations
        if (loaded.schemaVersion !== HISTORICAL_DATA_SCHEMA_VERSION) {
          log(`Historical data schema version mismatch: ${loaded.schemaVersion} vs ${HISTORICAL_DATA_SCHEMA_VERSION}`);
          // For now, just use loaded data as-is. Future: add migration logic here.
        }

        this.store = loaded;
        log(`Loaded historical data: ${Object.keys(this.store.daily).length} days, ${this.store.allTime.sessionCount} sessions`);
      } else {
        this.store = createEmptyDataStore();
        log('Initialized new historical data store');
      }
    } catch (error) {
      logError('Failed to load historical data', error);
      this.store = createEmptyDataStore();
    }
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

    // Update monthly data
    this.updateMonthlyData(month, summary);

    // Update all-time stats
    this.updateAllTimeStats(date, summary);

    this.isDirty = true;
    this.scheduleSave();

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

  /**
   * Schedules a debounced save to disk.
   */
  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.save();
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * Saves data to disk immediately.
   */
  private async save(): Promise<void> {
    if (!this.isDirty) {
      return;
    }

    try {
      this.store.lastSaved = new Date().toISOString();
      const content = JSON.stringify(this.store, null, 2);
      await fs.promises.writeFile(this.dataFilePath, content, 'utf-8');
      this.isDirty = false;
      log('Historical data saved to disk');
    } catch (error) {
      logError('Failed to save historical data', error);
    }
  }

  /**
   * Forces an immediate save (for extension deactivation).
   */
  async forceSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
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
      this.isDirty = true;
      this.scheduleSave();
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
    this.isDirty = true;
    this.scheduleSave();
    log('Historical data cleared');
  }

  /**
   * Disposes of the service, saving any pending data.
   */
  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Synchronous save on dispose since async may not complete
    if (this.isDirty) {
      try {
        this.store.lastSaved = new Date().toISOString();
        const content = JSON.stringify(this.store, null, 2);
        fs.writeFileSync(this.dataFilePath, content, 'utf-8');
        log('Historical data saved on dispose');
      } catch (error) {
        logError('Failed to save historical data on dispose', error);
      }
    }
  }
}
