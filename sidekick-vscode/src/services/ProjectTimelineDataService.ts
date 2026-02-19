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
import type { SessionProvider } from '../types/sessionProvider';
import type { ClaudeSessionEvent } from '../types/claudeSession';
import type {
  TimelineSessionEntry,
  TimelineSessionDetail,
  TimelineRange,
} from '../types/projectTimeline';
import { log } from './Logger';

/**
 * Cached session metadata with mtime for invalidation.
 */
interface CachedEntry {
  entry: TimelineSessionEntry;
  mtime: number;
}

/**
 * Data service that scans session files to build timeline entries.
 *
 * Uses lightweight parsing to extract only the metadata needed for
 * the timeline view (timestamps, token totals, error counts, key files).
 */
export class ProjectTimelineDataService {
  /** Cache keyed by session path */
  private _cache = new Map<string, CachedEntry>();

  constructor(private readonly _provider: SessionProvider) {}

  /**
   * Gets timeline entries for the current project, filtered by range.
   *
   * @param workspacePath - Workspace directory path
   * @param range - Time range filter
   * @returns Sorted session entries (most recent first)
   */
  getTimelineEntries(
    workspacePath: string,
    range: TimelineRange,
    currentSessionPath?: string | null
  ): TimelineSessionEntry[] {
    const sessionPaths = this._provider.findAllSessions(workspacePath);
    log(`[Timeline] Found ${sessionPaths.length} sessions for workspace`);

    const cutoff = this._getRangeCutoff(range);
    const entries: TimelineSessionEntry[] = [];

    for (const sessionPath of sessionPaths) {
      try {
        const entry = this._getOrParseEntry(sessionPath, currentSessionPath);
        if (!entry) continue;

        // Filter by range
        if (cutoff && new Date(entry.startTime).getTime() < cutoff) continue;

        entries.push(entry);
      } catch (error) {
        log(`[Timeline] Failed to parse session: ${sessionPath}: ${error}`);
      }
    }

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
    try {
      const reader = this._provider.createReader(sessionPath);
      const events = reader.readAll();
      const sessionId = this._provider.getSessionId(sessionPath);

      const tasks: TimelineSessionDetail['tasks'] = [];
      const errorMap = new Map<string, { count: number; example: string }>();
      const toolMap = new Map<string, { calls: number; failures: number }>();

      for (const event of events) {
        // Extract tasks
        if (event.type === 'tool_use' && event.tool) {
          const toolName = event.tool.name;
          const existing = toolMap.get(toolName) || { calls: 0, failures: 0 };
          existing.calls++;
          toolMap.set(toolName, existing);

          if (toolName === 'TaskCreate') {
            const subject = (event.tool.input?.subject as string) || 'Untitled';
            tasks.push({ subject, status: 'pending' });
          }
          if (toolName === 'TaskUpdate') {
            const status = event.tool.input?.status as string;
            const taskId = event.tool.input?.taskId as string;
            if (status && taskId) {
              // Update matching task if possible
              const task = tasks.find(t => t.subject.includes(taskId));
              if (task) task.status = status;
            }
          }
        }

        // Count tool failures
        if (event.type === 'tool_result' && event.result?.is_error) {
          // Try to find the matching tool call
          const output = String(event.result.output || '');
          const category = this._categorizeError(output);
          const existing = errorMap.get(category) || { count: 0, example: '' };
          existing.count++;
          if (!existing.example) {
            existing.example = output.slice(0, 100);
          }
          errorMap.set(category, existing);

          // Increment failure count for the tool
          // Note: we can't reliably match tool_result to tool_use by name here,
          // so failures are tracked via errorMap only
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
  }

  /**
   * Clears all cached data.
   */
  clearCache(): void {
    this._cache.clear();
  }

  /**
   * Gets or parses a timeline entry, using cache when mtime hasn't changed.
   */
  private _getOrParseEntry(
    sessionPath: string,
    currentSessionPath?: string | null
  ): TimelineSessionEntry | null {
    // Get file mtime
    let mtime: number;
    try {
      const stat = fs.statSync(sessionPath);
      mtime = stat.mtimeMs;
    } catch {
      return null;
    }

    // Check cache
    const cached = this._cache.get(sessionPath);
    if (cached && cached.mtime === mtime) {
      // Update current/active flags which may change
      cached.entry.isCurrent = sessionPath === currentSessionPath;
      cached.entry.isActive = cached.entry.isCurrent;
      return cached.entry;
    }

    // Parse session
    const entry = this._parseSession(sessionPath, currentSessionPath);
    if (entry) {
      this._cache.set(sessionPath, { entry, mtime });
    }
    return entry;
  }

  /**
   * Parses a session file to extract timeline metadata.
   *
   * Uses a lightweight two-pass approach:
   * 1. Read the first 16 KB to extract start time, label, and first model
   * 2. Read the last 16 KB to extract end time and final stats
   *
   * This avoids reading entire multi-MB session files just for the timeline.
   */
  private _parseSession(
    sessionPath: string,
    currentSessionPath?: string | null
  ): TimelineSessionEntry | null {
    const sessionId = this._provider.getSessionId(sessionPath);

    let fileSize: number;
    try {
      fileSize = fs.statSync(sessionPath).size;
    } catch {
      return null;
    }

    if (fileSize === 0) return null;

    // Read first chunk for start time, label, model
    const headChunk = this._readChunk(sessionPath, 0, Math.min(16384, fileSize));
    if (!headChunk) return null;

    const headEvents = this._parseChunkEvents(headChunk);
    if (headEvents.length === 0) return null;

    // Read tail chunk for end time (skip if file is small enough that head covered it)
    let tailEvents: ClaudeSessionEvent[] = [];
    if (fileSize > 16384) {
      const tailOffset = Math.max(0, fileSize - 16384);
      const tailChunk = this._readChunk(sessionPath, tailOffset, fileSize - tailOffset);
      if (tailChunk) {
        tailEvents = this._parseChunkEvents(tailChunk);
      }
    }

    const allSampled = [...headEvents, ...tailEvents];

    let startTime = '';
    let endTime = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let messageCount = 0;
    let taskCount = 0;
    let errorCount = 0;
    const modelSet = new Set<string>();

    for (const event of allSampled) {
      if (event.timestamp) {
        if (!startTime || event.timestamp < startTime) startTime = event.timestamp;
        if (!endTime || event.timestamp > endTime) endTime = event.timestamp;
      }

      if (event.type === 'assistant' || event.type === 'user') {
        messageCount++;
      }

      if (event.message?.usage) {
        totalInputTokens += event.message.usage.input_tokens || 0;
        totalOutputTokens += event.message.usage.output_tokens || 0;
      }

      if (event.message?.model) {
        modelSet.add(event.message.model);
      }

      if (event.type === 'tool_use' && event.tool?.name === 'TaskCreate') {
        taskCount++;
      }

      if (event.type === 'tool_result' && event.result?.is_error) {
        errorCount++;
      }
    }

    if (!startTime) return null;

    const label = this._provider.extractSessionLabel(sessionPath) || sessionId.slice(0, 8);
    const startMs = new Date(startTime).getTime();
    const endMs = endTime ? new Date(endTime).getTime() : startMs;
    const isCurrent = sessionPath === currentSessionPath;

    return {
      sessionId,
      sessionPath,
      startTime,
      endTime: endTime || null,
      durationMs: endMs - startMs,
      label,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCost: 0,
      messageCount,
      taskCount,
      errorCount,
      keyFiles: [],
      isCurrent,
      isActive: isCurrent,
      models: Array.from(modelSet),
    };
  }

  /**
   * Reads a raw chunk of bytes from a file.
   */
  private _readChunk(filePath: string, offset: number, length: number): string | null {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      fs.closeSync(fd);
      return buffer.toString('utf-8', 0, bytesRead);
    } catch {
      return null;
    }
  }

  /**
   * Parses JSONL events from a raw text chunk.
   * Skips the first and last lines (may be partial).
   */
  private _parseChunkEvents(chunk: string): ClaudeSessionEvent[] {
    const lines = chunk.split('\n');
    const events: ClaudeSessionEvent[] = [];

    // If chunk starts at offset > 0, the first line may be partial — skip it.
    // If chunk doesn't end with \n, the last line may be partial — skip it.
    // For safety, always skip first and last if we have more than 2 lines.
    const start = lines.length > 2 ? 1 : 0;
    const end = lines.length > 2 ? lines.length - 1 : lines.length;

    for (let i = start; i < end; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      try {
        events.push(JSON.parse(trimmed) as ClaudeSessionEvent);
      } catch {
        // Skip malformed lines
      }
    }

    return events;
  }

  /**
   * Gets the cutoff timestamp for a time range filter.
   */
  private _getRangeCutoff(range: TimelineRange): number | null {
    const now = Date.now();
    switch (range) {
      case '24h': return now - 24 * 60 * 60 * 1000;
      case '7d': return now - 7 * 24 * 60 * 60 * 1000;
      case '30d': return now - 30 * 24 * 60 * 60 * 1000;
      case 'all': return null;
    }
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
