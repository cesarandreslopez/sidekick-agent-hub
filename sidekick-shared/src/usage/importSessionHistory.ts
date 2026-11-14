/**
 * Import finished sessions from every provider into the history store.
 *
 * The VS Code extension used to import Claude Code only, by hand-parsing
 * JSONL files; the CLI could not import at all. This walks the sessions
 * every provider knows about, reads each once through the unified stats
 * path, and hands a `SessionSummary` to the caller, which applies it to the
 * store it owns (the extension's debounced persistence service or the CLI's
 * locked atomic writer). Dedupe is the caller's `isImported` answer
 * (imported file paths plus persisted session ids); the capped per-session
 * list is deliberately not used as the dedupe key.
 *
 * Node-only: reads session files.
 *
 * @module usage/importSessionHistory
 */

import { sessionSummaryFromStats } from '../historicalStore';
import type {
  SessionFileStats,
  SessionProviderBase,
  SessionProviderDiagnostic,
} from '../providers/types';
import { yieldToEventLoop } from '../providers/readerDrain';
import { listSessionPreviewsAsync } from '../sessionPreviews';
import { readSessionFileStatsAsync } from '../sessionStats';
import type { SessionSummary } from '../types/historicalData';

/** Files modified more recently than this are skipped: they may still be live. */
export const ACTIVE_SESSION_MTIME_THRESHOLD_MS = 60_000;

export interface ImportSessionHistoryOptions {
  providers: SessionProviderBase[];
  /** Only sessions modified after this instant. */
  since?: Date | string;
  /** Restrict to one workspace's sessions. */
  workspacePath?: string;
  /** Clock used for the active-file check (default `new Date()`). */
  now?: Date;
  /** Override of {@link ACTIVE_SESSION_MTIME_THRESHOLD_MS}. */
  activeFileThresholdMs?: number;
  /** Already imported? Checked before the session is read. */
  isImported: (sessionId: string, filePath: string) => boolean;
  /** Apply one credited session to the store. */
  applySummary: (summary: SessionSummary, filePath: string) => void;
  /** Record a file as imported (called after `applySummary`, and alone for usage-free files). */
  markImported: (filePath: string) => void;
  onProgress?: (loaded: number, total: number) => void;
  /**
   * Stops the import before listing, between sessions, and between the
   * bounded read steps of one session. The promise still resolves, with
   * the counts so far and `aborted: true`; the session being read when the
   * signal fired is neither applied nor marked imported, so the next run
   * reads it again.
   */
  signal?: AbortSignal;
}

export interface ImportSessionHistoryResult {
  /** Session files the providers listed in the window. */
  filesFound: number;
  /** Files read and applied. */
  filesProcessed: number;
  /** Files skipped because they were already imported or still live. */
  filesSkipped: number;
  /** Files that could not be read (`availability: 'unavailable'`) or held no usage. */
  filesUnavailable: number;
  sessionsImported: number;
  /** Messages across the imported sessions. */
  messagesImported: number;
  diagnostics: SessionProviderDiagnostic[];
  /** Set when `signal` stopped the import before every listed file was handled. */
  aborted?: true;
}

function emptyResult(): ImportSessionHistoryResult {
  return {
    filesFound: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    filesUnavailable: 0,
    sessionsImported: 0,
    messagesImported: 0,
    diagnostics: [],
  };
}

export async function importSessionHistory(
  options: ImportSessionHistoryOptions,
): Promise<ImportSessionHistoryResult> {
  const now = options.now ?? new Date();
  const threshold = options.activeFileThresholdMs ?? ACTIVE_SESSION_MTIME_THRESHOLD_MS;
  const signal = options.signal;
  if (signal?.aborted) return { ...emptyResult(), aborted: true };
  const listed = await listSessionPreviewsAsync(options.providers, {
    since: options.since,
    workspacePath: options.workspacePath,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const providerById = new Map(options.providers.map((provider) => [provider.id, provider]));
  const result: ImportSessionHistoryResult = {
    ...emptyResult(),
    filesFound: listed.previews.length,
    diagnostics: [...listed.diagnostics],
  };
  const total = listed.previews.length;
  let loaded = 0;

  for (const preview of listed.previews) {
    if (signal?.aborted) {
      result.aborted = true;
      break;
    }
    loaded += 1;
    const provider = providerById.get(preview.provider);
    const modifiedMs = Date.parse(preview.modifiedAt);
    const recentlyModified = Number.isFinite(modifiedMs) && now.getTime() - modifiedMs < threshold;
    if (!provider || recentlyModified || options.isImported(preview.sessionId, preview.filePath)) {
      result.filesSkipped += 1;
      options.onProgress?.(loaded, total);
      continue;
    }

    let stats: SessionFileStats;
    try {
      // Read in bounded steps, yielding between them, so one large session
      // does not block the host's event loop.
      stats = await readSessionFileStatsAsync(provider, preview.filePath, { signal });
    } catch (error) {
      if (!signal?.aborted) throw error;
      result.aborted = true;
      break;
    }
    result.filesProcessed += 1;
    if (stats.availability === 'unavailable') {
      result.filesUnavailable += 1;
      result.diagnostics.push({
        providerId: preview.provider,
        kind: 'read_failed',
        severity: 'warning',
        phase: 'read',
        message: `${preview.provider} session ${preview.sessionId}: ${stats.unavailableReason ?? 'unavailable'}`,
      });
    } else if (Object.keys(stats.modelUsage).length === 0) {
      // No usage record at all (for example a prompt that never got an
      // answer): nothing to credit, but mark the file so it is not re-read
      // on every run.
      result.filesUnavailable += 1;
      options.markImported(preview.filePath);
    } else {
      options.applySummary(
        sessionSummaryFromStats(stats, { project: preview.workspacePath }),
        preview.filePath,
      );
      options.markImported(preview.filePath);
      result.sessionsImported += 1;
      result.messagesImported += stats.messageCount;
    }
    options.onProgress?.(loaded, total);
    await yieldToEventLoop();
  }

  return result;
}
