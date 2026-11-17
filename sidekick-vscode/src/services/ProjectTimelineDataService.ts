/**
 * @fileoverview Data service for multi-session project timeline.
 *
 * Aggregates per-session metadata by scanning session files via the
 * active SessionProvider. Supports time-range filtering and in-memory
 * caching keyed by session path + mtime.
 *
 * @module services/ProjectTimelineDataService
 */

import * as fs from 'fs';
import { summarizeTokens } from 'sidekick-shared';
import type { SessionProvider } from '../types/sessionProvider';
import type {
  TimelineSessionEntry,
  TimelineSessionDetail,
  TimelineRange,
} from '../types/projectTimeline';
import { log } from './Logger';
import { SESSION_LIVE_WINDOW_MS } from '../utils/sessionLiveness';

/** Lets queued I/O and messages run between two synchronous session reads. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Cached session metadata with mtime for invalidation.
 */
interface CachedEntry {
  /** `null` for a session with nothing to show, so it isn't re-read every scan. */
  entry: TimelineSessionEntry | null;
  mtime: number;
  /** When the file was last read (`Date.now()`), for the live-session throttle. */
  parsedAt: number;
}

/**
 * The live session's file changes on every event; re-reading a large one on
 * each 10-second refresh blocks the extension host (about 100 ms at 18 MB).
 * Its card is refreshed at most this often instead.
 */
const LIVE_SESSION_REREAD_MS = 60_000;

/** Cached session detail, keyed by path and invalidated by mtime. */
interface CachedDetail {
  detail: TimelineSessionDetail;
  mtime: number;
}

/**
 * Data service that scans session files to build timeline entries.
 *
 * Each session is summarised by the provider's stats reader and cached by
 * mtime, so only new or changed sessions are read again.
 */
export class ProjectTimelineDataService {
  /** Cache keyed by session path */
  private _cache = new Map<string, CachedEntry>();
  /** Expanded-detail cache keyed by session path */
  private _detailCache = new Map<string, CachedDetail>();

  constructor(private readonly _provider: SessionProvider) {}

  /**
   * Loads timeline entries for the current project, filtered by range.
   *
   * Every provider is summarised by its own `readSessionStats()` (the shared
   * aggregator Session Analytics uses), so the cards agree with the dashboard.
   * A full read of a large session costs ~100 ms, so uncached files are read
   * one per event-loop turn: the extension host stays responsive while "All"
   * scans a big project. Sessions whose last write predates the range are
   * skipped before any read (a session cannot start after its last write).
   *
   * @param workspacePath - Workspace directory path
   * @param range - Time range filter
   * @param currentSessionPath - The monitor's attached session, if any
   * @param options.isStale - Checked between reads; a true result abandons the
   *   scan and resolves `null` (a newer request superseded this one)
   * @param options.onParseStart - Called once, before the first uncached read
   * @returns Sorted session entries (most recent first), or `null` when stale
   */
  async loadTimelineEntries(
    workspacePath: string,
    range: TimelineRange,
    currentSessionPath?: string | null,
    options: { isStale?: () => boolean; onParseStart?: () => void } = {},
  ): Promise<TimelineSessionEntry[] | null> {
    const sessionPaths = this._provider.findAllSessions(workspacePath);
    log(`[Timeline] Found ${sessionPaths.length} sessions for workspace`);

    const cutoff = this._getRangeCutoff(range);
    const entries: TimelineSessionEntry[] = [];
    const toParse: Array<{ sessionPath: string; mtime: number }> = [];
    const inRange = (entry: TimelineSessionEntry) =>
      !cutoff || new Date(entry.startTime).getTime() >= cutoff;

    for (const sessionPath of sessionPaths) {
      const mtime = this._getMtime(sessionPath);
      if (mtime === null) continue;
      if (cutoff && mtime < cutoff) continue;

      const cached = this._cache.get(sessionPath);
      const isCurrent = sessionPath === currentSessionPath;
      const reuse =
        cached &&
        (cached.mtime === mtime ||
          (isCurrent &&
            cached.entry !== null &&
            Date.now() - cached.parsedAt < LIVE_SESSION_REREAD_MS));
      if (cached && reuse) {
        if (!cached.entry) continue;
        // Current/live flags change without the file changing.
        cached.entry.isCurrent = isCurrent;
        cached.entry.isActive = this._isLive(isCurrent, mtime);
        if (inRange(cached.entry)) entries.push(cached.entry);
      } else {
        toParse.push({ sessionPath, mtime });
      }
    }

    if (toParse.length > 0) options.onParseStart?.();

    for (const { sessionPath, mtime } of toParse) {
      if (options.isStale?.()) return null;
      try {
        const entry = this._parseSession(sessionPath, currentSessionPath);
        this._cache.set(sessionPath, { entry, mtime, parsedAt: Date.now() });
        if (entry) {
          entry.isActive = this._isLive(entry.isCurrent, mtime);
          if (inRange(entry)) entries.push(entry);
        }
      } catch (error) {
        log(`[Timeline] Failed to parse session: ${sessionPath}: ${error}`);
        this._cache.set(sessionPath, { entry: null, mtime, parsedAt: Date.now() });
      }
      await yieldToEventLoop();
    }
    if (options.isStale?.()) return null;

    // Sort by start time descending (most recent first)
    entries.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

    log(`[Timeline] Returning ${entries.length} entries (range: ${range})`);
    return entries;
  }

  /**
   * Gets detailed data for a single session (loaded on demand for expand).
   *
   * @param sessionPath - Path to the session file
   * @returns Session detail or null if parse fails
   */
  getSessionDetail(sessionPath: string): TimelineSessionDetail | null {
    const mtime = this._getMtime(sessionPath);
    const cached = this._detailCache.get(sessionPath);
    if (cached && mtime !== null && cached.mtime === mtime) return cached.detail;

    const detail = this._readSessionDetail(sessionPath);
    if (detail && mtime !== null) {
      this._detailCache.set(sessionPath, { detail, mtime });
    }
    return detail;
  }

  private _readSessionDetail(sessionPath: string): TimelineSessionDetail | null {
    try {
      const reader = this._provider.createReader(sessionPath);
      const events = reader.readAll();
      const sessionId = this._provider.getSessionId(sessionPath);

      const tasks: TimelineSessionDetail['tasks'] = [];
      const errorMap = new Map<string, { count: number; example: string }>();
      const toolMap = new Map<string, { calls: number; failures: number }>();

      for (const event of events) {
        if (event.type === 'tool_use' && event.tool) {
          this._recordToolUseForDetail(event.tool.name, event.tool.input || {}, toolMap, tasks);
        }

        if (event.type === 'tool_result' && event.result?.is_error) {
          this._recordErrorForDetail(String(event.result.output || ''), errorMap);
        }

        const content = Array.isArray(event.message?.content)
          ? (event.message.content as Array<Record<string, unknown>>)
          : [];

        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          const toolName = typeof block.name === 'string' ? block.name : 'unknown';
          const input =
            block.input && typeof block.input === 'object'
              ? (block.input as Record<string, unknown>)
              : {};
          this._recordToolUseForDetail(toolName, input, toolMap, tasks);
        }

        for (const block of content) {
          if (block.type !== 'tool_result' || block.is_error !== true) continue;
          this._recordErrorForDetail(String(block.content || ''), errorMap);
        }
      }

      const errors = Array.from(errorMap.entries()).map(([category, data]) => ({
        category,
        count: data.count,
        example: data.example,
      }));

      const toolBreakdown = Array.from(toolMap.entries()).map(([tool, data]) => ({
        tool,
        calls: data.calls,
        failures: data.failures,
      }));

      // Sort tools by call count
      toolBreakdown.sort((a, b) => b.calls - a.calls);

      return { sessionId, tasks, errors, toolBreakdown };
    } catch (error) {
      log(`[Timeline] Failed to get session detail: ${sessionPath}: ${error}`);
      return null;
    }
  }

  /**
   * Invalidates cache for a specific session.
   */
  invalidateSession(sessionPath: string): void {
    this._cache.delete(sessionPath);
    this._detailCache.delete(sessionPath);
  }

  /**
   * Clears all cached data.
   */
  clearCache(): void {
    this._cache.clear();
    this._detailCache.clear();
  }

  /**
   * Last-modified time for a session. DB-backed providers use synthetic paths
   * that don't exist on disk, so fall back to the provider's own metadata.
   */
  private _getMtime(sessionPath: string): number | null {
    try {
      return fs.statSync(sessionPath).mtimeMs;
    } catch {
      const meta = this._provider.getSessionMetadata?.(sessionPath);
      return meta ? meta.mtime.getTime() : null;
    }
  }

  private _isLive(isCurrent: boolean, mtime: number): boolean {
    return isCurrent && Date.now() - mtime < SESSION_LIVE_WINDOW_MS;
  }

  /**
   * Summarises one session through the provider's stats reader. One code path
   * for every provider: the cards then match Session Analytics (full message
   * and token counts, TaskCreate calls, failed tool calls).
   */
  private _parseSession(
    sessionPath: string,
    currentSessionPath?: string | null,
  ): TimelineSessionEntry | null {
    const sessionId = this._provider.getSessionId(sessionPath);
    const stats = this._provider.readSessionStats(sessionPath);
    if (stats.availability === 'unavailable' || !stats.startTime) return null;

    const startMs = new Date(stats.startTime).getTime();
    const endMs = stats.endTime ? new Date(stats.endTime).getTime() : startMs;
    const isCurrent = sessionPath === currentSessionPath;
    const label =
      stats.label || this._provider.extractSessionLabel(sessionPath) || sessionId.slice(0, 8);

    return {
      sessionId,
      sessionPath,
      startTime: stats.startTime,
      endTime: stats.endTime || null,
      durationMs: endMs - startMs,
      label,
      totalTokens: summarizeTokens({
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheWriteTokens: stats.tokens.cacheWrite,
        cacheReadTokens: stats.tokens.cacheRead,
      }).total,
      totalCost: stats.costUsd,
      messageCount: stats.messageCount,
      taskCount: stats.toolUsage.TaskCreate || 0,
      errorCount: Object.values(stats.toolFailures ?? {}).reduce((sum, n) => sum + n, 0),
      keyFiles: [],
      isCurrent,
      isActive: isCurrent,
      models: Object.keys(stats.modelUsage),
    };
  }

  /**
   * Gets the cutoff timestamp for a time range filter.
   */
  private _getRangeCutoff(range: TimelineRange): number | null {
    const now = Date.now();
    switch (range) {
      case '24h':
        return now - 24 * 60 * 60 * 1000;
      case '7d':
        return now - 7 * 24 * 60 * 60 * 1000;
      case '30d':
        return now - 30 * 24 * 60 * 60 * 1000;
      case 'all':
        return null;
    }
  }

  private _recordToolUseForDetail(
    toolName: string,
    input: Record<string, unknown>,
    toolMap: Map<string, { calls: number; failures: number }>,
    tasks: TimelineSessionDetail['tasks'],
  ): void {
    const existing = toolMap.get(toolName) || { calls: 0, failures: 0 };
    existing.calls++;
    toolMap.set(toolName, existing);

    if (toolName === 'TaskCreate') {
      const subject = (input.subject as string) || 'Untitled';
      tasks.push({ subject, status: 'pending' });
    }

    if (toolName === 'TaskUpdate') {
      const status = input.status as string;
      const taskId = input.taskId as string;
      if (status && taskId) {
        const task = tasks.find((t) => t.subject.includes(taskId));
        if (task) task.status = status;
      }
    }
  }

  private _recordErrorForDetail(
    output: string,
    errorMap: Map<string, { count: number; example: string }>,
  ): void {
    const category = this._categorizeError(output);
    const existing = errorMap.get(category) || { count: 0, example: '' };
    existing.count++;
    if (!existing.example) {
      existing.example = output.slice(0, 100);
    }
    errorMap.set(category, existing);
  }

  /**
   * Categorizes an error message into a type.
   */
  private _categorizeError(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes('permission') || lower.includes('eacces')) return 'permission';
    if (lower.includes('not found') || lower.includes('enoent')) return 'not_found';
    if (lower.includes('syntax') || lower.includes('parse')) return 'syntax';
    if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
    if (lower.includes('exit code')) return 'exit_code';
    return 'other';
  }
}
