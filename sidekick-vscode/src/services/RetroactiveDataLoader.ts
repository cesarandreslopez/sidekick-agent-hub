/**
 * @fileoverview Retroactive historical data loader for Claude Code sessions.
 *
 * This service scans all existing JSONL session files in ~/.claude/projects/
 * and imports historical usage data into the HistoricalDataService. This allows
 * Sidekick to display usage history from sessions that occurred before installation.
 *
 * Key features:
 * - Recursively finds all JSONL files under ~/.claude/projects/
 * - Parses usage records from each file
 * - Deduplicates records using messageId-requestId hash
 * - Groups records by session (JSONL file = session)
 * - Tracks imported files to prevent re-importing
 *
 * @module services/RetroactiveDataLoader
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { HistoricalDataService } from './HistoricalDataService';
import { ModelPricingService } from './ModelPricingService';
import type { SessionSummary, ModelUsageRecord, ToolUsageRecord, TokenTotals } from '../types/historicalData';
import { createEmptyTokenTotals } from '../types/historicalData';
import { log, logError } from './Logger';

/**
 * Result of a retroactive import operation.
 */
export interface ImportResult {
  /** Number of JSONL files processed */
  filesProcessed: number;

  /** Total usage records found in all files */
  recordsFound: number;

  /** Records imported after deduplication */
  recordsImported: number;

  /** Number of sessions created from the records */
  sessionsCreated: number;

  /** Number of files skipped (already imported) */
  filesSkipped: number;
}

/**
 * Raw usage record from a JSONL line.
 */
interface RawUsageRecord {
  timestamp: string;
  type: string;
  message: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    model?: string;
    id?: string;
  };
  requestId?: string;
  isApiErrorMessage?: boolean;
}

/**
 * Parsed and validated usage record.
 */
interface UsageRecord {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  model: string;
  messageId: string | null;
  requestId: string | null;
}

/**
 * Group of usage records for a single session.
 */
interface SessionGroup {
  /** Session ID (from JSONL filename UUID) */
  sessionId: string;

  /** Path to the JSONL file */
  filePath: string;

  /** All usage records for this session */
  records: UsageRecord[];

  /** Earliest timestamp in the session */
  startTime: string;

  /** Latest timestamp in the session */
  endTime: string;
}

/**
 * Service for retroactive loading of historical session data.
 *
 * Scans existing Claude Code JSONL files and imports usage data
 * into the historical data store for analytics display.
 *
 * @example
 * ```typescript
 * const loader = new RetroactiveDataLoader(historicalDataService);
 * const result = await loader.loadHistoricalData((loaded, total) => {
 *   console.log(`Progress: ${loaded}/${total} files`);
 * });
 * console.log(`Imported ${result.recordsImported} records`);
 * ```
 */
export class RetroactiveDataLoader {
  /** Base directory for Claude Code projects */
  private readonly projectsDir: string;

  /**
   * Creates a new RetroactiveDataLoader.
   *
   * @param historicalDataService - Service to save imported data to
   */
  constructor(private readonly historicalDataService: HistoricalDataService) {
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * Finds all JSONL files recursively under ~/.claude/projects/.
   *
   * @returns Array of absolute paths to JSONL files
   */
  async findAllJsonlFiles(): Promise<string[]> {
    const files: string[] = [];

    try {
      if (!fs.existsSync(this.projectsDir)) {
        log('RetroactiveDataLoader: No projects directory found');
        return files;
      }

      // Get all project directories
      const projectDirs = fs.readdirSync(this.projectsDir);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(this.projectsDir, projectDir);

        try {
          const stat = fs.statSync(projectPath);
          if (!stat.isDirectory()) {
            continue;
          }

          // Find JSONL files in this project directory
          const entries = fs.readdirSync(projectPath);
          for (const entry of entries) {
            if (entry.endsWith('.jsonl')) {
              files.push(path.join(projectPath, entry));
            }
          }
        } catch {
          // Skip directories we can't access
          continue;
        }
      }

      log(`RetroactiveDataLoader: Found ${files.length} JSONL files`);
      return files;
    } catch (error) {
      logError('RetroactiveDataLoader: Failed to scan projects directory', error);
      return files;
    }
  }

  /**
   * Parses a single JSONL file and extracts usage records.
   *
   * @param filePath - Absolute path to the JSONL file
   * @returns Array of validated usage records
   */
  async parseJsonlFile(filePath: string): Promise<UsageRecord[]> {
    const records: UsageRecord[] = [];

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) {
          continue;
        }

        try {
          const data = JSON.parse(trimmed) as RawUsageRecord;

          if (!this.isValidUsageRecord(data)) {
            continue;
          }

          const usage = data.message.usage!;
          records.push({
            timestamp: data.timestamp,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheWriteTokens: usage.cache_creation_input_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            model: data.message.model || 'unknown',
            messageId: data.message.id || null,
            requestId: data.requestId || null,
          });
        } catch {
          // Skip malformed lines
          continue;
        }
      }
    } catch (error) {
      logError(`RetroactiveDataLoader: Failed to parse ${filePath}`, error);
    }

    return records;
  }

  /**
   * Validates that a record has required usage data.
   *
   * @param data - Raw record data to validate
   * @returns true if the record is valid for import
   */
  private isValidUsageRecord(data: unknown): data is RawUsageRecord {
    if (!data || typeof data !== 'object') {
      return false;
    }

    const record = data as RawUsageRecord;

    // Skip error messages
    if (record.isApiErrorMessage) {
      return false;
    }

    // Must be assistant type (only they have usage)
    if (record.type !== 'assistant') {
      return false;
    }

    // Must have message with usage
    if (!record.message?.usage) {
      return false;
    }

    // Must have valid token counts
    const usage = record.message.usage;
    if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
      return false;
    }

    // Must have timestamp
    if (!record.timestamp) {
      return false;
    }

    return true;
  }

  /**
   * Creates a hash for deduplication from a usage record.
   *
   * @param record - Usage record to hash
   * @returns Hash string or null if no identifiers available
   */
  private createRecordHash(record: UsageRecord): string {
    // Use messageId-requestId for deduplication
    const msgPart = record.messageId || 'no-msg';
    const reqPart = record.requestId || 'no-req';
    // Include timestamp to disambiguate records without IDs
    return `${msgPart}-${reqPart}-${record.timestamp}`;
  }

  /**
   * Groups records by session (each JSONL file = one session).
   *
   * @param filePath - Path to the JSONL file
   * @param records - Usage records from the file
   * @returns Session group with aggregated data
   */
  private createSessionGroup(filePath: string, records: UsageRecord[]): SessionGroup | null {
    if (records.length === 0) {
      return null;
    }

    // Extract session ID from filename (UUID portion)
    const filename = path.basename(filePath, '.jsonl');
    const sessionId = filename;

    // Sort records by timestamp
    const sorted = [...records].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    return {
      sessionId,
      filePath,
      records: sorted,
      startTime: sorted[0].timestamp,
      endTime: sorted[sorted.length - 1].timestamp,
    };
  }

  /**
   * Creates a SessionSummary from a session group.
   *
   * @param group - Session group to convert
   * @returns SessionSummary for storage
   */
  private createSessionSummary(group: SessionGroup): SessionSummary {
    // Aggregate token totals
    const tokens: TokenTotals = createEmptyTokenTotals();
    const modelUsageMap = new Map<
      string,
      { calls: number; tokens: number; cost: number; priced: boolean }
    >();

    for (const record of group.records) {
      tokens.inputTokens += record.inputTokens;
      tokens.outputTokens += record.outputTokens;
      tokens.cacheWriteTokens += record.cacheWriteTokens;
      tokens.cacheReadTokens += record.cacheReadTokens;

      // Calculate cost for this record. `null` means pricing is unknown —
      // treat contribution as 0 and mark the aggregate as unpriced.
      const pricing = ModelPricingService.getPricing(record.model);
      const cost = ModelPricingService.calculateCost({
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheWriteTokens: record.cacheWriteTokens,
        cacheReadTokens: record.cacheReadTokens,
      }, pricing);
      const priced = cost !== null;
      const contribution = cost ?? 0;

      const existing = modelUsageMap.get(record.model);
      if (existing) {
        existing.calls += 1;
        existing.tokens += record.inputTokens + record.outputTokens;
        existing.cost += contribution;
        // One unpriced record taints the aggregate for this model.
        if (!priced) existing.priced = false;
      } else {
        modelUsageMap.set(record.model, {
          calls: 1,
          tokens: record.inputTokens + record.outputTokens,
          cost: contribution,
          priced,
        });
      }
    }

    // Convert model usage map to array
    const modelUsage: ModelUsageRecord[] = Array.from(modelUsageMap.entries()).map(
      ([model, data]) => ({
        model,
        calls: data.calls,
        tokens: data.tokens,
        cost: data.cost,
        priced: data.priced,
      })
    );
    const unpricedModelIds = modelUsage.filter(m => !m.priced).map(m => m.model);

    // Calculate total cost from priced portion.
    const totalCost = modelUsage.reduce((sum, m) => sum + m.cost, 0);

    // Tool usage is not available from historical JSONL parsing
    // (would require tracking tool_use/tool_result pairs)
    const toolUsage: ToolUsageRecord[] = [];

    return {
      sessionId: group.sessionId,
      startTime: group.startTime,
      endTime: group.endTime,
      tokens,
      totalCost,
      messageCount: group.records.length,
      modelUsage,
      toolUsage,
      unpricedModelIds: unpricedModelIds.length > 0 ? unpricedModelIds : undefined,
    };
  }

  /**
   * Main entry point: loads all historical data from JSONL files.
   *
   * @param onProgress - Optional callback for progress updates
   * @returns Import result with statistics
   */
  async loadHistoricalData(
    onProgress?: (loaded: number, total: number) => void
  ): Promise<ImportResult> {
    const result: ImportResult = {
      filesProcessed: 0,
      recordsFound: 0,
      recordsImported: 0,
      sessionsCreated: 0,
      filesSkipped: 0,
    };

    // Find all JSONL files
    const allFiles = await this.findAllJsonlFiles();
    const total = allFiles.length;

    if (total === 0) {
      log('RetroactiveDataLoader: No JSONL files found');
      return result;
    }

    // Get list of already-imported files
    const importedFiles = new Set(this.historicalDataService.getImportedFiles());

    // Track seen record hashes for deduplication within this import
    const seenHashes = new Set<string>();

    let processed = 0;
    for (const filePath of allFiles) {
      // Check if already imported
      if (importedFiles.has(filePath)) {
        result.filesSkipped++;
        processed++;
        onProgress?.(processed, total);
        continue;
      }

      // Parse the file
      const records = await this.parseJsonlFile(filePath);
      result.filesProcessed++;
      result.recordsFound += records.length;

      // Deduplicate records
      const uniqueRecords: UsageRecord[] = [];
      for (const record of records) {
        const hash = this.createRecordHash(record);
        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          uniqueRecords.push(record);
        }
      }

      result.recordsImported += uniqueRecords.length;

      // Create session group and summary
      const group = this.createSessionGroup(filePath, uniqueRecords);
      if (group && group.records.length > 0) {
        const summary = this.createSessionSummary(group);
        this.historicalDataService.saveSessionSummary(summary);
        result.sessionsCreated++;
      }

      // Mark file as imported
      this.historicalDataService.markFileImported(filePath);

      processed++;
      onProgress?.(processed, total);
    }

    // Force save after import
    await this.historicalDataService.forceSave();

    log(`RetroactiveDataLoader: Import complete - ${result.filesProcessed} files, ${result.recordsImported} records, ${result.sessionsCreated} sessions`);

    return result;
  }
}
