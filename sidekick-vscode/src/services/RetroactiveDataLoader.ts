/**
 * @fileoverview Retroactive historical data import for every session provider.
 *
 * Thin wrapper over the shared `importSessionHistory()`: Claude Code, Codex,
 * and OpenCode sessions are read once each through the unified stats path
 * and folded into the HistoricalDataService with the same mutation the CLI's
 * `sidekick import` applies. Files already imported, sessions already
 * persisted by the live monitor, and files modified in the last minute are
 * skipped, so the import is idempotent and never freezes an active session.
 *
 * @module services/RetroactiveDataLoader
 */

import { createSessionProviders, importSessionHistory } from 'sidekick-shared';
import type { SessionProviderBase } from 'sidekick-shared';
import type { HistoricalDataService } from './HistoricalDataService';
import { log } from './Logger';

/**
 * Result of a retroactive import operation.
 */
export interface ImportResult {
  /** Session files read (including ones that held no usage) */
  filesProcessed: number;

  /** Messages across the imported sessions */
  recordsFound: number;

  /** Messages credited to the store (same as `recordsFound`) */
  recordsImported: number;

  /** Sessions credited to the store */
  sessionsCreated: number;

  /** Files skipped (already imported, already persisted, or still live) */
  filesSkipped: number;
}

/**
 * Service for retroactive loading of historical session data.
 *
 * @example
 * ```typescript
 * const loader = new RetroactiveDataLoader(historicalDataService);
 * const result = await loader.loadHistoricalData((loaded, total) => {
 *   console.log(`Progress: ${loaded}/${total} files`);
 * });
 * console.log(`Imported ${result.sessionsCreated} sessions`);
 * ```
 */
export class RetroactiveDataLoader {
  private readonly providers: SessionProviderBase[];
  private readonly ownsProviders: boolean;

  /**
   * @param historicalDataService - Service to save imported data to
   * @param providers - Providers to import from (default: every built-in provider)
   */
  constructor(
    private readonly historicalDataService: HistoricalDataService,
    providers?: SessionProviderBase[],
  ) {
    if (providers) {
      this.providers = providers;
      this.ownsProviders = false;
    } else {
      this.providers = createSessionProviders({
        onDiagnostic: (diagnostic) =>
          log(
            `RetroactiveDataLoader: ${diagnostic.providerId} ${diagnostic.kind}: ${diagnostic.message}`,
          ),
      }).providers;
      this.ownsProviders = true;
    }
  }

  /**
   * Main entry point: imports every finished session the providers know about.
   *
   * @param onProgress - Optional callback for progress updates
   * @returns Import result with statistics
   */
  async loadHistoricalData(
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<ImportResult> {
    const importedFiles = new Set(this.historicalDataService.getImportedFiles());
    const savedSessionIds = new Set(
      this.historicalDataService.getSessionRecords().map((session) => session.sessionId),
    );

    try {
      const result = await importSessionHistory({
        providers: this.providers,
        // Do not re-credit a session already persisted by the live monitor or
        // a file already folded in; the capped session list is not the key.
        isImported: (sessionId, filePath) =>
          importedFiles.has(filePath) || savedSessionIds.has(sessionId),
        applySummary: (summary) => {
          this.historicalDataService.saveSessionSummary(summary);
          savedSessionIds.add(summary.sessionId);
        },
        markImported: (filePath) => {
          this.historicalDataService.markFileImported(filePath);
          importedFiles.add(filePath);
        },
        onProgress,
      });

      if (result.filesFound === 0) {
        log('RetroactiveDataLoader: No session files found');
      } else {
        await this.historicalDataService.forceSave();
        log(
          `RetroactiveDataLoader: Import complete - ${result.filesProcessed} files, ${result.messagesImported} messages, ${result.sessionsImported} sessions`,
        );
      }
      for (const diagnostic of result.diagnostics) {
        log(`RetroactiveDataLoader: ${diagnostic.providerId}: ${diagnostic.message}`);
      }

      return {
        filesProcessed: result.filesProcessed,
        recordsFound: result.messagesImported,
        recordsImported: result.messagesImported,
        sessionsCreated: result.sessionsImported,
        filesSkipped: result.filesSkipped,
      };
    } finally {
      if (this.ownsProviders) {
        for (const provider of this.providers) provider.dispose();
      }
    }
  }
}
