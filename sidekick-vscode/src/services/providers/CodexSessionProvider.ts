/**
 * @fileoverview Codex CLI session provider.
 *
 * Implements SessionProvider for monitoring Codex CLI sessions.
 * Codex stores sessions as JSONL rollout files in:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * with an optional SQLite index at ~/.codex/state.sqlite.
 *
 * @module services/providers/CodexSessionProvider
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../Logger';
import { CodexRolloutParser } from './CodexRolloutParser';
import { CodexDatabase } from './CodexDatabase';
import type { SessionProvider, SessionReader, ProjectFolderInfo, SearchHit } from '../../types/sessionProvider';
import type { QuotaState } from '../../types/dashboard';
import type { ClaudeSessionEvent, SubagentStats, TokenUsage } from '../../types/claudeSession';
import type { CodexRolloutLine, CodexRateLimits, CodexSessionMeta } from '../../types/codex';

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
 * Format: rollout-<timestamp>-<uuid>.jsonl → <uuid>
 */
function extractSessionId(filename: string): string {
  const base = path.basename(filename, '.jsonl');
  // rollout-YYYYMMDD-HHMMSS-<uuid> or rollout-<timestamp>-<uuid>
  const parts = base.split('-');
  // The UUID is typically the last 5 segments (8-4-4-4-12)
  // Try to find a UUID pattern at the end
  if (parts.length >= 6) {
    // Check if the last 5 segments form a UUID
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

// --- Reader ---

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
  ) {
    this.parser = new CodexRolloutParser();
  }

  /** Get the parser's session metadata. */
  getSessionMeta(): CodexSessionMeta | null {
    return this.parser.getSessionMeta();
  }

  readNew(): ClaudeSessionEvent[] {
    this._wasTruncated = false;
    const events: ClaudeSessionEvent[] = [];

    try {
      if (!fs.existsSync(this.rolloutPath)) return [];

      const stats = fs.statSync(this.rolloutPath);
      const currentSize = stats.size;

      // Handle truncation
      if (currentSize < this.filePosition) {
        log(`CodexReader: file truncated (${this.filePosition} -> ${currentSize}), re-reading`);
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
    } catch (error) {
      log(`CodexReader: error reading: ${error}`);
    }

    return events;
  }

  readAll(): ClaudeSessionEvent[] {
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

  wasTruncated(): boolean {
    return this._wasTruncated;
  }
}

// --- Main provider ---

/**
 * Session provider for Codex CLI.
 *
 * Uses SQLite database as optional index, with file-system scanning
 * of the YYYY/MM/DD directory structure as primary discovery method.
 */
export class CodexSessionProvider implements SessionProvider {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';

  private db: CodexDatabase | null = null;
  private dbInitialized = false;
  private dynamicContextWindowLimit: number | null = null;
  private lastRateLimits: CodexRateLimits | null = null;

  /** Lazy-initialize database connection. */
  private ensureDb(): CodexDatabase | null {
    if (this.dbInitialized) return this.db;
    this.dbInitialized = true;

    const codexHome = getCodexHome();
    const db = new CodexDatabase(codexHome);
    if (db.isAvailable() && db.open()) {
      this.db = db;
      log('Codex SQLite database connected');
    } else {
      log('Codex SQLite database not available, using file-based discovery');
    }
    return this.db;
  }

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

    // Find the most recent rollout file and check its CWD
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
          // Update count and mtime if newer
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

  createReader(sessionPath: string): SessionReader {
    return new CodexReader(
      sessionPath,
      (limit) => { this.dynamicContextWindowLimit = limit; },
      (limits) => { this.lastRateLimits = limits; },
    );
  }

  scanSubagents(_sessionDir: string, _sessionId: string): SubagentStats[] {
    // Codex tracks forked sessions via forked_from_id in session_meta.
    // For now, return empty — fork scanning requires either DB or
    // traversing all rollout files which is expensive.
    return [];
  }

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

  computeContextSize(usage: TokenUsage): number {
    // OpenAI's input_tokens already includes cached_input_tokens (it's a subset, not additive)
    return usage.inputTokens;
  }

  getQuotaFromSession(): QuotaState | null {
    if (!this.lastRateLimits) return null;
    const { primary, secondary } = this.lastRateLimits;
    if (!primary || !secondary) return null;
    return {
      fiveHour: {
        utilization: primary.used_percent,
        resetsAt: new Date(primary.resets_at * 1000).toISOString(),
      },
      sevenDay: {
        utilization: secondary.used_percent,
        resetsAt: new Date(secondary.resets_at * 1000).toISOString(),
      },
      available: true,
    };
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
    this.dbInitialized = false;
  }
}

// --- Helpers ---

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
