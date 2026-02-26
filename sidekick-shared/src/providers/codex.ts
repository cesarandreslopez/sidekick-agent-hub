/**
 * Codex CLI session provider for the shared package.
 *
 * Implements SessionProviderBase for monitoring Codex CLI sessions.
 * Codex stores sessions as JSONL rollout files in:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * with an optional SQLite index at ~/.codex/state.sqlite.
 *
 * Ported from sidekick-vscode/src/services/providers/CodexSessionProvider.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexRolloutParser } from '../parsers/codexParser';
import { CodexDatabase } from './codexDatabase';
import type {
  SessionProviderBase,
  SessionReader,
  ProjectFolderInfo,
  SearchHit,
  SessionFileStats,
  ProviderId,
} from './types';
import type { SessionEvent, SubagentStats, TokenUsage } from '../types/sessionEvent';
import type { CodexRolloutLine, CodexRateLimits, CodexSessionMeta } from '../types/codex';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Gets the Codex home directory.
 * Respects CODEX_HOME env var, defaults to ~/.codex/
 */
function getCodexHome(): string {
  const envHome = process.env.CODEX_HOME;
  if (envHome) return envHome;
  return path.join(os.homedir(), '.codex');
}

/** Get the sessions base directory. */
function getSessionsDir(): string {
  return path.join(getCodexHome(), 'sessions');
}

/** Test if a filename is a Codex rollout file. */
function isRolloutFile(filename: string): boolean {
  return filename.startsWith('rollout-') && filename.endsWith('.jsonl');
}

/**
 * Extract session UUID from a rollout filename.
 * Format: rollout-<timestamp>-<uuid>.jsonl -> <uuid>
 */
function extractSessionId(filename: string): string {
  const base = path.basename(filename, '.jsonl');
  // rollout-YYYYMMDD-HHMMSS-<uuid> or rollout-<timestamp>-<uuid>
  const parts = base.split('-');
  // The UUID is typically the last 5 segments (8-4-4-4-12)
  if (parts.length >= 6) {
    const possibleUuid = parts.slice(-5).join('-');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(possibleUuid)) {
      return possibleUuid;
    }
  }
  // Fallback: use everything after "rollout-"
  return base.replace(/^rollout-/, '');
}

/** Truncate a string to maxLen with ellipsis. */
function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length > maxLen) {
    return trimmed.substring(0, maxLen - 3) + '...';
  }
  return trimmed;
}

/**
 * Recursively find all rollout files under a directory.
 * Handles the YYYY/MM/DD subdirectory structure.
 */
function findRolloutFiles(dir: string): Array<{ path: string; mtime: Date }> {
  const results: Array<{ path: string; mtime: Date }> = [];

  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findRolloutFiles(fullPath));
      } else if (entry.isFile() && isRolloutFile(entry.name)) {
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size > 0) {
            results.push({ path: fullPath, mtime: stats.mtime });
          }
        } catch {
          // Skip inaccessible files
        }
      }
    }
  } catch {
    // Skip inaccessible directories
  }

  return results;
}

/**
 * Check if text looks like system-injected context rather than a real user prompt.
 * Codex prepends AGENTS.md, environment_context, permissions, and collaboration_mode
 * as user/developer messages before the actual user prompt.
 */
function isSystemInjection(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('#');
}

/**
 * Read the first N complete lines from a file using chunked reads.
 * Handles arbitrarily long lines (Codex session_meta can be 10KB+).
 */
function readFirstLines(filePath: string, maxLines: number, maxBytes = 256 * 1024): string[] {
  const lines: string[] = [];
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }

  let pending = '';
  let totalRead = 0;
  const chunkSize = 16384;

  try {
    while (totalRead < maxBytes && lines.length < maxLines) {
      const buf = Buffer.alloc(Math.min(chunkSize, maxBytes - totalRead));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, totalRead);
      if (bytesRead === 0) break;

      totalRead += bytesRead;
      pending += buf.toString('utf-8', 0, bytesRead);

      let nlIdx: number;
      while ((nlIdx = pending.indexOf('\n')) !== -1 && lines.length < maxLines) {
        lines.push(pending.substring(0, nlIdx));
        pending = pending.substring(nlIdx + 1);
      }
    }

    if (pending.trim() && lines.length < maxLines) {
      lines.push(pending);
    }
  } finally {
    fs.closeSync(fd);
  }

  return lines;
}

/** Read session_meta from the beginning of a rollout file. */
function readSessionMeta(rolloutPath: string): CodexSessionMeta | null {
  try {
    const lines = readFirstLines(rolloutPath, 1);
    const firstLine = lines[0]?.trim();
    if (!firstLine) return null;

    const parsed = JSON.parse(firstLine) as CodexRolloutLine;
    if (parsed.type === 'session_meta') {
      return parsed.payload as CodexSessionMeta;
    }
  } catch {
    // Skip
  }
  return null;
}

/** Read the CWD from a rollout file's session_meta. Cached. */
const cwdCache = new Map<string, string | null>();
function readSessionCwd(rolloutPath: string): string | null {
  const cached = cwdCache.get(rolloutPath);
  if (cached !== undefined) return cached;

  const meta = readSessionMeta(rolloutPath);
  const cwd = meta?.cwd || null;
  cwdCache.set(rolloutPath, cwd);
  return cwd;
}

/** Check if a session's CWD matches a workspace path. */
function cwdMatches(sessionCwd: string, workspacePath: string): boolean {
  const normalizedSession = normalizePath(sessionCwd);
  const normalizedWorkspace = normalizePath(workspacePath);

  return normalizedSession === normalizedWorkspace ||
    normalizedWorkspace.startsWith(normalizedSession + path.sep) ||
    normalizedSession.startsWith(normalizedWorkspace + path.sep);
}

/** Normalize a path using realpathSync. */
function normalizePath(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

/**
 * Read the first user message text from a rollout file.
 * Reads up to 20 lines to find a real user message (lines can be 10KB+ each).
 * Skips system-injected context (AGENTS.md, environment_context, etc.).
 */
function extractFirstUserMessage(rolloutPath: string): string | null {
  try {
    const lines = readFirstLines(rolloutPath, 20);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as CodexRolloutLine;

        // Check response_item with user message
        if (parsed.type === 'response_item') {
          const payload = parsed.payload as { type?: string; role?: string; content?: unknown };
          if (payload.role === 'user') {
            const content = payload.content;
            if (typeof content === 'string' && content.trim() && !isSystemInjection(content)) {
              return truncate(content, 60);
            }
            if (Array.isArray(content)) {
              for (const part of content) {
                const p = part as { text?: string };
                if (p.text?.trim() && !isSystemInjection(p.text)) {
                  return truncate(p.text, 60);
                }
              }
            }
          }
        }

        // Check event_msg with user_message
        if (parsed.type === 'event_msg') {
          const payload = parsed.payload as { event?: { type: string; message?: string } };
          if (payload.event?.type === 'user_message' && payload.event.message?.trim()) {
            return truncate(payload.event.message, 60);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Extract searchable text from a rollout line. */
function extractSearchableText(line: CodexRolloutLine): string {
  switch (line.type) {
    case 'response_item': {
      const payload = line.payload as { item?: { type: string; content?: unknown; arguments?: string; output?: string } };
      const item = payload.item;
      if (!item) return '';
      if (item.type === 'message') {
        if (typeof item.content === 'string') return item.content;
        if (Array.isArray(item.content)) {
          return item.content
            .map((p: { text?: string }) => p.text || '')
            .filter(Boolean)
            .join(' ');
        }
      }
      if (item.type === 'function_call' && item.arguments) return item.arguments;
      if (item.type === 'function_call_output' && item.output) return item.output;
      return '';
    }
    case 'event_msg': {
      const payload = line.payload as { event?: { type: string; message?: string; result?: string } };
      const event = payload.event;
      if (!event) return '';
      if (event.message) return event.message;
      if (event.result) return event.result;
      return '';
    }
    case 'compacted': {
      const payload = line.payload as { summary?: string };
      return payload.summary || '';
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// CodexReader — incremental JSONL reader wrapping CodexRolloutParser
// ---------------------------------------------------------------------------

/**
 * Incremental JSONL reader for Codex rollout files.
 * Tracks byte position and feeds lines through CodexRolloutParser.
 */
class CodexReader implements SessionReader {
  private parser: CodexRolloutParser;
  private filePosition = 0;
  private lineBuffer = '';
  private _wasTruncated = false;

  constructor(
    private readonly rolloutPath: string,
    private readonly onContextWindowLimit?: (limit: number) => void,
    private readonly onRateLimits?: (limits: CodexRateLimits) => void,
    private readonly onTokenUsage?: (usage: TokenUsage) => void,
  ) {
    this.parser = new CodexRolloutParser();
  }

  /** Get the parser's session metadata. */
  getSessionMeta(): CodexSessionMeta | null {
    return this.parser.getSessionMeta();
  }

  readNew(): SessionEvent[] {
    this._wasTruncated = false;
    const events: SessionEvent[] = [];

    try {
      if (!fs.existsSync(this.rolloutPath)) return [];

      const stats = fs.statSync(this.rolloutPath);
      const currentSize = stats.size;

      // Handle truncation
      if (currentSize < this.filePosition) {
        this._wasTruncated = true;
        this.filePosition = 0;
        this.lineBuffer = '';
        this.parser.reset();
      }

      // No new content
      if (currentSize <= this.filePosition) return [];

      // Read new bytes
      const fd = fs.openSync(this.rolloutPath, 'r');
      const bufferSize = currentSize - this.filePosition;
      const buffer = Buffer.alloc(bufferSize);
      fs.readSync(fd, buffer, 0, bufferSize, this.filePosition);
      fs.closeSync(fd);

      const chunk = buffer.toString('utf-8');
      this.filePosition = currentSize;

      // Process lines
      const text = this.lineBuffer + chunk;
      const lines = text.split('\n');

      // Last element may be incomplete
      this.lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed) as CodexRolloutLine;
          events.push(...this.parser.convertLine(parsed));
        } catch {
          // Skip malformed JSON lines
        }
      }

      // Propagate model_context_window from token_count events to the provider
      const mcw = this.parser.getModelContextWindow();
      if (mcw && this.onContextWindowLimit) {
        this.onContextWindowLimit(mcw);
      }

      // Propagate rate_limits from token_count events to the provider
      const rateLimits = this.parser.getLastRateLimits();
      if (rateLimits && this.onRateLimits) {
        this.onRateLimits(rateLimits);
      }

      // Propagate last token usage snapshot to the provider
      const lastUsage = this.parser.getLastTokenUsage();
      if (lastUsage && this.onTokenUsage) {
        this.onTokenUsage({
          inputTokens: lastUsage.input_tokens || 0,
          outputTokens: lastUsage.output_tokens || 0,
          cacheWriteTokens: 0,
          cacheReadTokens: lastUsage.cached_input_tokens || 0,
          reasoningTokens: lastUsage.reasoning_output_tokens || 0,
          model: this.parser.getCurrentModel() || 'unknown',
          timestamp: new Date(),
        });
      }
    } catch {
      // Skip read errors
    }

    return events;
  }

  readAll(): SessionEvent[] {
    this.reset();
    return this.readNew();
  }

  reset(): void {
    this.filePosition = 0;
    this.lineBuffer = '';
    this.parser.reset();
    this._wasTruncated = false;
  }

  exists(): boolean {
    return fs.existsSync(this.rolloutPath);
  }

  flush(): void {
    // Process any remaining data in the line buffer
    if (this.lineBuffer.trim()) {
      try {
        const parsed = JSON.parse(this.lineBuffer.trim()) as CodexRolloutLine;
        this.parser.convertLine(parsed);
      } catch {
        // Not a complete line yet
      }
    }
  }

  getPosition(): number {
    return this.filePosition;
  }

  seekTo(position: number): void {
    this.filePosition = position;
    this.lineBuffer = '';
  }

  wasTruncated(): boolean {
    return this._wasTruncated;
  }
}

// ---------------------------------------------------------------------------
// CodexProvider — full SessionProviderBase implementation
// ---------------------------------------------------------------------------

/**
 * Session provider for Codex CLI.
 *
 * Uses SQLite database as optional index, with file-system scanning
 * of the YYYY/MM/DD directory structure as primary discovery method.
 */
export class CodexProvider implements SessionProviderBase {
  readonly id: ProviderId = 'codex';
  readonly displayName = 'Codex CLI';

  private db: CodexDatabase | null = null;
  private dbInitialized = false;
  private dynamicContextWindowLimit: number | null = null;
  private lastRateLimitsData: CodexRateLimits | null = null;
  private lastTokenUsageData: TokenUsage | null = null;

  // --- Database ---

  /** Lazy-initialize database connection. */
  private ensureDb(): CodexDatabase | null {
    if (this.dbInitialized) return this.db;
    this.dbInitialized = true;

    const codexHome = getCodexHome();
    const db = new CodexDatabase(codexHome);
    if (db.isAvailable() && db.open()) {
      this.db = db;
    }
    return this.db;
  }

  // --- Path resolution ---

  getSessionDirectory(workspacePath: string): string {
    // Codex doesn't use workspace-encoded directories like Claude Code.
    // All sessions live under ~/.codex/sessions/ in date-based subdirs.
    // We return the sessions base dir; session matching is done by CWD in the data.
    const db = this.ensureDb();
    if (db) {
      const thread = db.getMostRecentThread(workspacePath);
      if (thread?.rollout_path) {
        return path.dirname(thread.rollout_path);
      }
    }
    return getSessionsDir();
  }

  discoverSessionDirectory(workspacePath: string): string | null {
    // DB: find latest rollout directory for this workspace
    const db = this.ensureDb();
    if (db) {
      const thread = db.getMostRecentThread(workspacePath);
      if (thread?.rollout_path && fs.existsSync(thread.rollout_path)) {
        return path.dirname(thread.rollout_path);
      }
    }

    // File scan: look for any rollout file whose session_meta.cwd matches
    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) return null;

    const files = findRolloutFiles(sessionsDir);
    if (files.length === 0) return null;

    // Sort by mtime descending
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    for (const file of files) {
      const meta = readSessionMeta(file.path);
      if (meta && cwdMatches(meta.cwd, workspacePath)) {
        return path.dirname(file.path);
      }
    }

    // Fallback: return sessions dir if it exists
    return fs.existsSync(sessionsDir) ? sessionsDir : null;
  }

  // --- Session discovery ---

  findActiveSession(workspacePath: string): string | null {
    // DB first
    const db = this.ensureDb();
    if (db) {
      const thread = db.getMostRecentThread(workspacePath);
      if (thread?.rollout_path && fs.existsSync(thread.rollout_path)) {
        return thread.rollout_path;
      }
    }

    // File scan fallback
    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) return null;

    const files = findRolloutFiles(sessionsDir);
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    for (const file of files) {
      const meta = readSessionMeta(file.path);
      if (meta && cwdMatches(meta.cwd, workspacePath)) {
        return file.path;
      }
    }

    return null;
  }

  findAllSessions(workspacePath: string): string[] {
    // DB first
    const db = this.ensureDb();
    if (db) {
      const threads = db.getThreadsByCwd(workspacePath);
      const dbPaths = threads
        .filter(t => t.rollout_path && fs.existsSync(t.rollout_path))
        .map(t => t.rollout_path);
      if (dbPaths.length > 0) return dbPaths;
    }

    // File scan
    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) return [];

    const files = findRolloutFiles(sessionsDir);
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return files
      .filter(f => {
        const meta = readSessionMeta(f.path);
        return meta && cwdMatches(meta.cwd, workspacePath);
      })
      .map(f => f.path);
  }

  /** Backward-compatible alias for findAllSessions. */
  findSessionFiles(workspacePath: string): string[] {
    return this.findAllSessions(workspacePath);
  }

  findSessionsInDirectory(dir: string): string[] {
    const files = findRolloutFiles(dir);
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files.map(f => f.path);
  }

  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
    const folders: ProjectFolderInfo[] = [];
    const seenCwds = new Map<string, ProjectFolderInfo>();

    // DB first
    const db = this.ensureDb();
    if (db) {
      const cwdStats = db.getAllDistinctCwds();
      for (const stat of cwdStats) {
        seenCwds.set(stat.cwd, {
          dir: getSessionsDir(),
          name: stat.cwd,
          encodedName: stat.cwd,
          sessionCount: stat.count,
          lastModified: new Date(stat.lastUpdated),
        });
      }
    }

    // File scan supplement
    const sessionsDir = getSessionsDir();
    if (fs.existsSync(sessionsDir)) {
      const files = findRolloutFiles(sessionsDir);
      for (const file of files) {
        const meta = readSessionMeta(file.path);
        if (!meta?.cwd) continue;

        const existing = seenCwds.get(meta.cwd);
        if (existing) {
          // Update mtime if newer
          if (file.mtime > existing.lastModified) {
            existing.lastModified = file.mtime;
          }
        } else {
          seenCwds.set(meta.cwd, {
            dir: path.dirname(file.path),
            name: meta.cwd,
            encodedName: meta.cwd,
            sessionCount: 1,
            lastModified: file.mtime,
          });
        }
      }
    }

    folders.push(...seenCwds.values());

    // Sort: current workspace first, then by recency
    const normalizedWorkspace = workspacePath ? normalizePath(workspacePath) : null;
    folders.sort((a, b) => {
      if (normalizedWorkspace) {
        const aMatch = cwdMatches(a.name, normalizedWorkspace);
        const bMatch = cwdMatches(b.name, normalizedWorkspace);
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
      }
      return b.lastModified.getTime() - a.lastModified.getTime();
    });

    return folders;
  }

  // --- File identification ---

  isSessionFile(filename: string): boolean {
    return isRolloutFile(filename);
  }

  getSessionId(sessionPath: string): string {
    return extractSessionId(path.basename(sessionPath));
  }

  encodeWorkspacePath(workspacePath: string): string {
    // Codex doesn't encode workspace paths in directory names
    return workspacePath;
  }

  extractSessionLabel(sessionPath: string): string | null {
    // DB first
    const db = this.ensureDb();
    if (db) {
      const sessionId = this.getSessionId(sessionPath);
      const thread = db.getThread(sessionId);
      if (thread?.title) return truncate(thread.title, 60);
      if (thread?.first_user_message) return truncate(thread.first_user_message, 60);
    }

    // File fallback: parse first user message
    return extractFirstUserMessage(sessionPath);
  }

  // --- Data reading ---

  createReader(sessionPath: string): SessionReader {
    return new CodexReader(
      sessionPath,
      (limit) => { this.dynamicContextWindowLimit = limit; },
      (limits) => { this.lastRateLimitsData = limits; },
      (usage) => { this.lastTokenUsageData = usage; },
    );
  }

  // --- Subagent support ---

  scanSubagents(_sessionDir: string, sessionId: string): SubagentStats[] {
    // Codex tracks forked sessions via forked_from_id in session_meta.
    // Use DB when available, fall back to filesystem scanning.
    const subagents: SubagentStats[] = [];

    // DB approach: query threads table for forked children
    const db = this.ensureDb();
    if (db) {
      const forkedThreads = db.getThreadsByForkedFromId(sessionId);
      for (const thread of forkedThreads) {
        const stats = this.buildSubagentStats(thread.id, thread.rollout_path, thread.title);
        if (stats) subagents.push(stats);
      }
      if (forkedThreads.length > 0) return subagents;
    }

    // Filesystem fallback: scan all rollout files for matching forked_from_id.
    // Limited to recent files (last 50) to avoid excessive I/O.
    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) return subagents;

    const files = findRolloutFiles(sessionsDir);
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const filesToCheck = files.slice(0, 50);
    for (const file of filesToCheck) {
      const meta = readSessionMeta(file.path);
      if (meta?.forked_from_id === sessionId) {
        const childId = extractSessionId(path.basename(file.path));
        const stats = this.buildSubagentStats(childId, file.path, meta.source);
        if (stats) subagents.push(stats);
      }
    }

    return subagents;
  }

  /**
   * Builds SubagentStats for a forked session by reading its rollout file.
   */
  private buildSubagentStats(
    agentId: string,
    rolloutPath: string,
    description?: string | null,
  ): SubagentStats | null {
    if (!rolloutPath || !fs.existsSync(rolloutPath)) return null;

    const stats: SubagentStats = {
      agentId,
      description: description || undefined,
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
    };

    try {
      const parser = new CodexRolloutParser();
      const content = fs.readFileSync(rolloutPath, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as CodexRolloutLine;

          // Track timestamps
          if (parsed.timestamp) {
            const ts = new Date(parsed.timestamp);
            if (!stats.startTime || ts < stats.startTime) stats.startTime = ts;
            if (!stats.endTime || ts > stats.endTime) stats.endTime = ts;
          }

          const events = parser.convertLine(parsed);
          for (const event of events) {
            // Collect tool calls
            if (event.type === 'assistant' && Array.isArray(event.message.content)) {
              for (const block of event.message.content as Array<Record<string, unknown>>) {
                if (block.type === 'tool_use' && typeof block.name === 'string') {
                  stats.toolCalls.push({
                    name: block.name as string,
                    input: (block.input as Record<string, unknown>) || {},
                    timestamp: new Date(event.timestamp),
                  });
                }
              }
            }
            // Accumulate tokens from usage events
            if (event.message.usage) {
              stats.inputTokens += event.message.usage.input_tokens || 0;
              stats.outputTokens += event.message.usage.output_tokens || 0;
            }
          }
        } catch { /* skip malformed lines */ }
      }

      if (stats.startTime && stats.endTime) {
        stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();
      }
    } catch { /* skip unreadable files */ }

    return stats;
  }

  // --- Cross-session search ---

  searchInSession(sessionPath: string, query: string, maxResults: number): SearchHit[] {
    const results: SearchHit[] = [];
    const queryLower = query.toLowerCase();

    try {
      const content = fs.readFileSync(sessionPath, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (results.length >= maxResults) break;
        if (!line.trim()) continue;

        const lineLower = line.toLowerCase();
        if (!lineLower.includes(queryLower)) continue;

        try {
          const parsed = JSON.parse(line) as CodexRolloutLine;
          const text = extractSearchableText(parsed);
          if (!text) continue;

          const textLower = text.toLowerCase();
          const matchIdx = textLower.indexOf(queryLower);
          if (matchIdx < 0) continue;

          const start = Math.max(0, matchIdx - 40);
          const end = Math.min(text.length, matchIdx + query.length + 40);
          const snippet = (start > 0 ? '...' : '') +
            text.substring(start, end) +
            (end < text.length ? '...' : '');

          results.push({
            sessionPath,
            line: snippet.replace(/\n/g, ' '),
            eventType: parsed.type,
            timestamp: parsed.timestamp || '',
            projectPath: readSessionCwd(sessionPath) || sessionPath,
          });
        } catch {
          // Skip malformed JSON
        }
      }
    } catch {
      // Skip unreadable files
    }

    return results;
  }

  getProjectsBaseDir(): string {
    return getSessionsDir();
  }

  // --- Stats ---

  readSessionStats(sessionPath: string): SessionFileStats {
    const sessionId = extractSessionId(path.basename(sessionPath));
    let messageCount = 0;
    let startTime = '';
    let endTime = '';
    const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const modelUsage: Record<string, { calls: number; tokens: number }> = {};
    const toolUsage: Record<string, number> = {};
    let compactionEstimate = 0;
    let currentModel = 'unknown';

    try {
      const content = fs.readFileSync(sessionPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (!startTime && parsed.timestamp) startTime = parsed.timestamp;
          if (parsed.timestamp) endTime = parsed.timestamp;
          if (parsed.type === 'turn_context' && parsed.payload?.model) currentModel = parsed.payload.model;
          if (parsed.type === 'compacted') compactionEstimate++;
          if (parsed.type === 'response_item') {
            const p = parsed.payload;
            if (p?.role === 'user' || p?.role === 'assistant') messageCount++;
            if (p?.type === 'function_call') {
              const name = p.name || 'unknown';
              toolUsage[name] = (toolUsage[name] || 0) + 1;
            }
            if (p?.type === 'local_shell_call') toolUsage['Bash'] = (toolUsage['Bash'] || 0) + 1;
            if (p?.type === 'custom_tool_call') {
              const name = p.name || 'unknown';
              toolUsage[name] = (toolUsage[name] || 0) + 1;
            }
          }
          if (parsed.type === 'event_msg') {
            const evt = parsed.payload;
            if (evt?.type === 'token_count') {
              const usage = evt.info?.last_token_usage || evt.info?.total_token_usage;
              if (usage) {
                tokens.input = usage.input_tokens || 0;
                tokens.output = usage.output_tokens || 0;
                tokens.cacheRead = usage.cached_input_tokens || 0;
                if (!modelUsage[currentModel]) modelUsage[currentModel] = { calls: 0, tokens: 0 };
                modelUsage[currentModel].calls++;
                modelUsage[currentModel].tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return {
      providerId: 'codex',
      sessionId,
      filePath: sessionPath,
      label: this.extractSessionLabel(sessionPath),
      startTime,
      endTime,
      messageCount,
      tokens,
      modelUsage,
      toolUsage,
      compactionEstimate,
      truncationCount: 0,
      reportedCost: 0,
    };
  }

  // --- Optional methods ---

  getContextWindowLimit(modelId?: string): number {
    // Prefer actual model_context_window reported by token_count events
    if (this.dynamicContextWindowLimit) return this.dynamicContextWindowLimit;

    if (!modelId) return 128_000;
    const id = modelId.toLowerCase();

    // GPT-4.1 series: 1M context
    if (id.startsWith('gpt-4.1')) return 1_048_576;
    // GPT-4o: 128K
    if (id.startsWith('gpt-4o') || id.startsWith('gpt-4')) return 128_000;
    // o3 / o4-mini: 200K
    if (id.startsWith('o3') || id.startsWith('o4')) return 200_000;
    // o1: 200K
    if (id.startsWith('o1')) return 200_000;

    return 128_000;
  }

  getCurrentUsageSnapshot(_sessionPath: string): TokenUsage | null {
    // Return the last token usage snapshot received via the CodexReader callback.
    // This is populated in real-time as token_count events arrive during active monitoring.
    return this.lastTokenUsageData;
  }

  computeContextSize(usage: TokenUsage): number {
    // OpenAI's input_tokens already includes cached_input_tokens (it's a subset,
    // not additive like Anthropic's model). So inputTokens alone represents the
    // full context window usage. This differs from OpenCode's formula which adds
    // cacheWrite + cacheRead because Anthropic reports them separately.
    return usage.inputTokens;
  }

  // --- Rate limits (for vscode wrapper to build QuotaState) ---

  /** Get the last rate limits data received from token_count events. */
  getLastRateLimits(): CodexRateLimits | null {
    return this.lastRateLimitsData;
  }

  // --- Lifecycle ---

  dispose(): void {
    this.db?.close();
    this.db = null;
    this.dbInitialized = false;
    this.dynamicContextWindowLimit = null;
    this.lastRateLimitsData = null;
    this.lastTokenUsageData = null;
  }
}
