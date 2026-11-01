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
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { readSessionContextSnapshot } from '../context/sessionContext';
import { readSessionFileStats } from '../sessionStats';
import type {
  ReadSessionContextSnapshotOptions,
  SessionContextSnapshot,
} from '../context/sessionContext';
import { CodexRolloutParser, type CodexRolloutResumeState } from '../parsers/codexParser';
import { CodexDatabase, spawnParentFromSource } from './codexDatabase';
import { cachedSubagentStats } from '../parsers/subagentStatsCache';
import {
  DEFAULT_ROLLOUT_WALK_MAX_DEPTH,
  extractRolloutSessionId as extractSessionId,
  isRolloutFile,
  walkRolloutFiles,
} from './rolloutWalker';
import type { RolloutFileInfo } from './rolloutWalker';
import { getCodexSessionsDirs } from '../codexPaths';
import {
  cwdMatches,
  findCodexRolloutFile,
  getSessionsDirs,
  listCodexSessionFilesAsync,
  normalizePath,
  readFirstLines,
  readSessionCwd,
  readSessionCwdAsync,
  readSessionMeta,
} from './codexRollouts';
import { DirectoryListingCache, splitWatchedPath } from './directoryListingCache';
import type {
  ListSessionFilesOptions,
  SessionProviderBase,
  SessionReader,
  ProjectFolderInfo,
  SearchHit,
  SessionFileInfo,
  SessionFileStats,
  ProviderId,
  ProviderOperationStatus,
  ProviderRuntimeStatus,
  SessionProviderOptions,
  WatchedSessionFile,
} from './types';
import { ProviderDiagnosticTracker, diagnosticFromRuntimeStatus } from './diagnostics';
import type { SessionEvent, SubagentStats, TokenUsage } from '../types/sessionEvent';
import type { CodexRolloutLine, CodexRateLimits, CodexSessionMeta } from '../types/codex';
import { getModelContextWindowSize } from '../modelContext';
import { recordObservedContextWindow } from '../observedContextWindows';
import { extractNormalizedUsage, normalizeProviderUsage } from '../usageNormalization';
import { addUsageToSubagent } from '../usage/subagentUsage';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Truncate a string to maxLen with ellipsis. */
function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length > maxLen) {
    return trimmed.substring(0, maxLen - 3) + '...';
  }
  return trimmed;
}

/** Every rollout under a directory, newest first (one capped walk). */
function findRolloutFiles(dir: string): RolloutFileInfo[] {
  return walkRolloutFiles([dir]);
}

function hasRolloutFile(dir: string): boolean {
  return walkRolloutFiles([dir], { limit: 1 }).length > 0;
}

/** Every rollout across the monitored homes, newest first, deduplicated by path. */
function findRolloutFilesInConfiguredHomes(options: { limit?: number } = {}): RolloutFileInfo[] {
  return walkRolloutFiles(getSessionsDirs(), options);
}

export { findCodexRolloutFile };
export type { FindCodexRolloutFileOptions } from './codexRollouts';

/** Pick the best sessions directory for UI/search entrypoints. */
function getSessionsDir(): string {
  const dirs = getCodexSessionsDirs(undefined, { includeArchived: false });
  for (const dir of dirs) {
    if (hasRolloutFile(dir)) {
      return dir;
    }
  }
  return dirs[0] ?? path.join(process.cwd(), '.codex', 'sessions');
}

/** Pick the home that owns the preferred sessions directory. */
function getCodexHome(): string {
  return path.dirname(getSessionsDir());
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
    return extractFirstUserMessageFromLines(readFirstLines(rolloutPath, 20));
  } catch {
    return null;
  }
}

function extractFirstUserMessageFromLines(lines: readonly string[]): string | null {
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
        const payload = parsed.payload as { type?: string; message?: string };
        if (payload.type === 'user_message' && payload.message?.trim()) {
          return truncate(payload.message, 60);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  return null;
}

async function extractFirstUserMessageAsync(rolloutPath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(rolloutPath, 'r');
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return extractFirstUserMessageFromLines(
      buffer.toString('utf8', 0, bytesRead).split('\n').slice(0, 20),
    );
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Extract searchable text from a rollout line. */
function extractSearchableText(line: CodexRolloutLine): string {
  const parts: string[] = [];

  switch (line.type) {
    case 'session_meta': {
      const payload = line.payload as CodexSessionMeta;
      if (payload.cwd) parts.push(payload.cwd);
      if (payload.source) parts.push(payload.source);
      if (payload.base_instructions?.text) parts.push(payload.base_instructions.text);
      if (payload.git?.branch) parts.push(payload.git.branch);
      if (payload.git?.commit) parts.push(payload.git.commit);
      return parts.join(' ');
    }

    case 'response_item': {
      const item = line.payload as Record<string, unknown>;
      if (item.type === 'message') {
        parts.push(extractTextFromUnknownContent(item.content));
      }
      if (item.type === 'reasoning') {
        const summary = item.summary;
        if (Array.isArray(summary)) {
          for (const entry of summary as Array<Record<string, unknown>>) {
            if (typeof entry.text === 'string') parts.push(entry.text);
          }
        }
      }
      if (item.type === 'function_call') {
        if (typeof item.name === 'string') parts.push(item.name);
        if (typeof item.arguments === 'string') parts.push(item.arguments);
      }
      if (item.type === 'function_call_output' && typeof item.output === 'string') {
        parts.push(item.output);
      }
      if (item.type === 'local_shell_call') {
        const action = item.action as Record<string, unknown> | undefined;
        const command = action?.command;
        if (Array.isArray(command)) parts.push(command.map(String).join(' '));
        if (typeof action?.workdir === 'string') parts.push(action.workdir);
      }
      if (item.type === 'custom_tool_call') {
        if (typeof item.name === 'string') parts.push(item.name);
        if (typeof item.input === 'string') parts.push(item.input);
      }
      if (item.type === 'custom_tool_call_output' && typeof item.output === 'string') {
        parts.push(item.output);
      }
      return parts.filter(Boolean).join(' ');
    }

    case 'event_msg': {
      const event = line.payload as Record<string, unknown>;
      for (const key of [
        'type',
        'message',
        'result',
        'stdout',
        'stderr',
        'summary',
        'error',
        'code',
        'tool_name',
        'server_name',
      ]) {
        if (typeof event[key] === 'string') parts.push(event[key] as string);
      }
      const command = event.command;
      if (Array.isArray(command)) parts.push(command.map(String).join(' '));
      if (event.arguments && typeof event.arguments === 'object')
        parts.push(JSON.stringify(event.arguments));
      return parts.filter(Boolean).join(' ');
    }

    case 'compacted': {
      const payload = line.payload as { summary?: string };
      return payload.summary || '';
    }

    case 'turn_context': {
      const payload = line.payload as Record<string, unknown>;
      for (const key of ['model', 'cwd', 'approval_policy', 'sandbox_policy', 'effort']) {
        if (typeof payload[key] === 'string') parts.push(payload[key] as string);
      }
      return parts.join(' ');
    }

    default:
      return '';
  }
}

function extractTextFromUnknownContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as Record<string, unknown>;
      return typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join(' ');
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
  /** Cursor after the last complete line, safe to persist across restarts. */
  private committedPosition = 0;
  private lineBuffer = '';
  private _wasTruncated = false;
  private decoder = new StringDecoder('utf8');
  /**
   * Position from `seekTo()` whose prefix still has to be parsed for model,
   * turn, and cumulative-token context; `restoreResumeState()` supplies that
   * context instead and clears it.
   */
  private pendingSeek: number | null = null;

  constructor(
    private readonly rolloutPath: string,
    private readonly onContextWindowLimit?: (limit: number, modelId?: string) => void,
    private readonly onRateLimits?: (limits: CodexRateLimits) => void,
    private readonly onTokenUsage?: (usage: TokenUsage) => void,
  ) {
    this.parser = new CodexRolloutParser();
  }

  /** Get the parser's session metadata. */
  getSessionMeta(): CodexSessionMeta | null {
    this.settleSeek();
    return this.parser.getSessionMeta();
  }

  readNew(endPosition?: number): SessionEvent[] {
    this.settleSeek();
    this._wasTruncated = false;
    const events: SessionEvent[] = [];

    try {
      if (!fs.existsSync(this.rolloutPath)) return [];

      const stats = fs.statSync(this.rolloutPath);
      const currentSize = Math.min(stats.size, endPosition ?? stats.size);

      // Handle truncation
      if (currentSize < this.filePosition) {
        this._wasTruncated = true;
        this.filePosition = 0;
        this.committedPosition = 0;
        this.lineBuffer = '';
        this.parser.reset();
        this.decoder = new StringDecoder('utf8');
      }

      // No new content
      if (currentSize <= this.filePosition) return [];

      // Read new bytes
      const fd = fs.openSync(this.rolloutPath, 'r');
      const bufferSize = currentSize - this.filePosition;
      const buffer = Buffer.alloc(bufferSize);
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fd, buffer, 0, bufferSize, this.filePosition);
      } finally {
        fs.closeSync(fd);
      }

      const bytes = buffer.subarray(0, bytesRead);
      const newline = bytes.lastIndexOf(0x0a);
      if (newline >= 0) this.committedPosition = this.filePosition + newline + 1;
      const chunk = this.decoder.write(bytes);
      this.filePosition += bytesRead;

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

      this.propagateParserState();
    } catch {
      // Skip read errors
    }

    return events;
  }

  /** Hands the parser's context window, rate limits, and last usage to the provider. */
  private propagateParserState(): void {
    // Propagate model_context_window from token_count events to the provider.
    // The model comes along so the value can be persisted per model — the
    // window Codex reports is tier-specific, not the published maximum.
    const mcw = this.parser.getModelContextWindow();
    if (mcw && this.onContextWindowLimit) {
      this.onContextWindowLimit(mcw, this.parser.getCurrentModel() ?? undefined);
    }

    // Propagate rate_limits from token_count events to the provider
    const rateLimits = this.parser.getLastRateLimits();
    if (rateLimits && this.onRateLimits) {
      this.onRateLimits(rateLimits);
    }

    // Propagate last token usage snapshot to the provider
    const lastUsage = this.parser.getLastTokenUsage();
    if (lastUsage && this.onTokenUsage) {
      const normalized = normalizeProviderUsage({
        semantics: 'openai',
        provider: 'openai',
        source: 'codex-reader-snapshot',
        model: this.parser.getCurrentModel() || undefined,
        inputTokens: lastUsage.input_tokens,
        outputTokens: lastUsage.output_tokens,
        cacheReadTokens: lastUsage.cached_input_tokens,
        reasoningTokens: lastUsage.reasoning_output_tokens,
      });
      this.onTokenUsage({
        inputTokens: normalized.uncachedInputTokens,
        outputTokens: normalized.outputTokens,
        cacheWriteTokens: normalized.cacheWriteTokens,
        cacheReadTokens: normalized.cacheReadTokens,
        reasoningTokens: normalized.reasoningTokens,
        model: this.parser.getCurrentModel() || 'unknown',
        timestamp: new Date(),
      });
    }
  }

  readAll(): SessionEvent[] {
    this.reset();
    return this.readNew();
  }

  reset(): void {
    this.filePosition = 0;
    this.committedPosition = 0;
    this.lineBuffer = '';
    this.parser.reset();
    this.decoder = new StringDecoder('utf8');
    this._wasTruncated = false;
    this.pendingSeek = null;
  }

  exists(): boolean {
    return fs.existsSync(this.rolloutPath);
  }

  flush(): void {
    this.settleSeek();
    this.lineBuffer += this.decoder.end();
    // Process any remaining data in the line buffer
    if (this.lineBuffer.trim()) {
      try {
        const parsed = JSON.parse(this.lineBuffer.trim()) as CodexRolloutLine;
        this.parser.convertLine(parsed);
      } catch {
        // Not a complete line yet
      }
    }
    this.decoder = new StringDecoder('utf8');
  }

  getPosition(): number {
    return this.committedPosition;
  }

  seekTo(position: number): void {
    this.reset();
    this.filePosition = position;
    this.committedPosition = position;
    // The prefix's context is rebuilt on the next read, unless
    // restoreResumeState() supplies it first.
    if (position > 0) this.pendingSeek = position;
  }

  wasTruncated(): boolean {
    return this._wasTruncated;
  }

  /** The parser's continuation state (see `CodexRolloutParser.exportResumeState`). */
  getResumeState(): CodexRolloutResumeState {
    this.settleSeek();
    return this.parser.exportResumeState();
  }

  /**
   * Restores parser state from `getResumeState()`; after `seekTo()` this
   * replaces re-parsing the rollout up to that position.
   */
  restoreResumeState(state: unknown): boolean {
    if (!this.parser.importResumeState(state)) return false;
    this.pendingSeek = null;
    this.propagateParserState();
    return true;
  }

  /**
   * Rebuilds model, turn, and cumulative-token context for a pending
   * `seekTo()` position. The prefix is parsed only; its events are already
   * in the consumer snapshot.
   */
  private settleSeek(): void {
    const position = this.pendingSeek;
    if (position === null) return;
    this.reset();
    this.readNew(position);
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
  private dbStatus: ProviderRuntimeStatus = { available: false, kind: 'db_missing' };
  private readonly diagnostics: ProviderDiagnosticTracker;
  private dynamicContextWindowLimit: number | null = null;
  private lastRateLimitsData: CodexRateLimits | null = null;
  private lastTokenUsageData: TokenUsage | null = null;

  /** Dated rollout-directory listings reused across async enumerations. */
  private readonly directoryCache = new DirectoryListingCache();

  constructor(options: SessionProviderOptions = {}) {
    this.diagnostics = new ProviderDiagnosticTracker(this.id, options);
  }

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
    if (typeof db.getRuntimeStatus === 'function') {
      this.dbStatus = db.getRuntimeStatus();
    }
    return this.db;
  }

  private async ensureDbAsync(): Promise<CodexDatabase> {
    if (this.db) return this.db;
    return new CodexDatabase(getCodexHome());
  }

  /**
   * Cache an async-created database only after an operation proved it usable.
   * Sync paths treat a cached `db` as "open() succeeded", so adopting an
   * unproven instance would silently disable their file fallbacks.
   */
  private adoptDbIfAvailable(db: CodexDatabase): void {
    if (this.db || !db.getRuntimeStatus().available) return;
    this.db = db;
    this.dbInitialized = true;
  }

  getRuntimeStatus(): ProviderRuntimeStatus {
    const db = this.ensureDb();
    return db && typeof db.getRuntimeStatus === 'function' ? db.getRuntimeStatus() : this.dbStatus;
  }

  getLastOperationStatus(): ProviderOperationStatus {
    return this.diagnostics.getLastOperationStatus();
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
        this.recordDatabaseFallback('getSessionDirectory', true);
        return path.dirname(thread.rollout_path);
      }
    }
    const directory = getSessionsDir();
    this.recordDatabaseFallback('getSessionDirectory', true);
    return directory;
  }

  discoverSessionDirectory(workspacePath: string): string | null {
    // DB: find latest rollout directory for this workspace
    const db = this.ensureDb();
    if (db) {
      const thread = db.getMostRecentThread(workspacePath);
      if (thread?.rollout_path && fs.existsSync(thread.rollout_path)) {
        this.recordDatabaseFallback('discoverSessionDirectory', true);
        return path.dirname(thread.rollout_path);
      }
    }

    // File scan: look for any rollout file whose session_meta.cwd matches
    // (newest first; the cwd read is cached per path).
    const files = findRolloutFilesInConfiguredHomes();
    if (files.length === 0) {
      this.recordDatabaseFallback('discoverSessionDirectory', true);
      return null;
    }

    for (const file of files) {
      const cwd = readSessionCwd(file.path);
      if (cwd && cwdMatches(cwd, workspacePath)) {
        this.recordDatabaseFallback('discoverSessionDirectory', true);
        return path.dirname(file.path);
      }
    }

    // Fallback: return the most relevant base sessions dir if one exists
    const directory = getSessionsDir();
    this.recordDatabaseFallback('discoverSessionDirectory', true);
    return directory;
  }

  // --- Session discovery ---

  findActiveSession(workspacePath: string): string | null {
    // DB first
    const db = this.ensureDb();
    if (db) {
      const thread = db.getMostRecentThread(workspacePath);
      if (thread?.rollout_path && fs.existsSync(thread.rollout_path)) {
        this.recordDatabaseFallback('findActiveSession', true);
        return thread.rollout_path;
      }
    }

    // File scan fallback (newest first; cwd reads are cached per path)
    for (const file of findRolloutFilesInConfiguredHomes()) {
      const cwd = readSessionCwd(file.path);
      if (cwd && cwdMatches(cwd, workspacePath)) {
        this.recordDatabaseFallback('findActiveSession', true);
        return file.path;
      }
    }

    this.recordDatabaseFallback('findActiveSession', true);
    return null;
  }

  findAllSessions(workspacePath: string): string[] {
    // DB first
    const db = this.ensureDb();
    if (db) {
      const threads = db.getThreadsByCwd(workspacePath);
      const dbPaths = threads
        .filter((t) => t.rollout_path && fs.existsSync(t.rollout_path))
        .map((t) => t.rollout_path);
      if (dbPaths.length > 0) {
        this.recordDatabaseFallback('findAllSessions', true);
        return dbPaths;
      }
    }

    // File scan (newest first; cwd reads are cached per path)
    const sessions = findRolloutFilesInConfiguredHomes()
      .filter((f) => {
        const cwd = readSessionCwd(f.path);
        return cwd !== null && cwdMatches(cwd, workspacePath);
      })
      .map((f) => f.path);
    this.recordDatabaseFallback('findAllSessions', true);
    return sessions;
  }

  findSessionById(_workspacePath: string, sessionId: string): string | null {
    try {
      const found = findCodexRolloutFile(sessionId);
      this.recordDatabaseFallback('findSessionById', true);
      return found;
    } catch {
      this.recordDatabaseFallback('findSessionById', false);
      return null;
    }
  }

  /** Backward-compatible alias for findAllSessions. */
  findSessionFiles(workspacePath: string): string[] {
    return this.findAllSessions(workspacePath);
  }

  findSessionsInDirectory(dir: string): string[] {
    return findRolloutFiles(dir).map((f) => f.path);
  }

  listAllSessionFiles(): SessionFileInfo[] {
    const files = findRolloutFilesInConfiguredHomes();
    this.recordDatabaseFallback('listAllSessionFiles', true);
    return files;
  }

  async listSessionFilesAsync(
    workspacePath?: string,
    options: ListSessionFilesOptions = {},
  ): Promise<SessionFileInfo[]> {
    const results = await listCodexSessionFilesAsync(workspacePath, options, this.directoryCache);
    // Filesystem enumeration bypasses the database, so record that here as
    // the sync listing paths do; otherwise `getLastOperationStatus()` keeps
    // describing whichever operation ran before this one.
    this.recordDatabaseFallback('listSessionFilesAsync', true);
    return results;
  }

  /**
   * Resolve a recursive-watch event under a sessions root with one stat.
   * Rollouts are matched by name at any depth the walker would visit; a
   * dated directory appearing or vanishing needs a full walk.
   */
  async statWatchedSessionFile(
    root: string,
    relativePath: string,
    workspacePath?: string,
  ): Promise<WatchedSessionFile> {
    const segments = splitWatchedPath(relativePath);
    if (!segments) return { status: 'unknown' };
    const fullPath = path.join(root, ...segments);
    const name = segments[segments.length - 1];
    if (segments.length - 1 > DEFAULT_ROLLOUT_WALK_MAX_DEPTH) return { status: 'ignored' };
    if (!isRolloutFile(name)) {
      this.directoryCache.invalidate(fullPath);
      try {
        const stat = await fs.promises.stat(fullPath);
        return stat.isDirectory() ? { status: 'unknown' } : { status: 'ignored' };
      } catch {
        return { status: 'unknown' };
      }
    }
    const sessionId = extractSessionId(name);
    const stat = await this.directoryCache.refreshFile(fullPath);
    if (!stat || stat.sizeBytes <= 0) return { status: 'missing', path: fullPath, sessionId };
    const file: SessionFileInfo = {
      path: fullPath,
      mtime: new Date(stat.mtimeMs),
      sizeBytes: stat.sizeBytes,
      sessionId,
    };
    if (workspacePath) {
      const cwd = await readSessionCwdAsync(fullPath);
      if (!cwd || !cwdMatches(cwd, workspacePath)) return { status: 'ignored' };
      file.workspacePath = cwd;
    }
    return { status: 'present', file };
  }

  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
    const folders: ProjectFolderInfo[] = [];
    const seenCwds = new Map<string, ProjectFolderInfo>();

    // DB first
    const db = this.ensureDb();
    if (db) {
      const cwdStats = db.getAllDistinctCwds();
      const sessionsDir = getSessionsDir();
      for (const stat of cwdStats) {
        seenCwds.set(stat.cwd, {
          dir: sessionsDir,
          name: stat.cwd,
          encodedName: stat.cwd,
          sessionCount: stat.count,
          lastModified: new Date(stat.lastUpdated),
        });
      }
    }

    // File scan supplement. When the index answered, only rollouts written
    // after its last update can be missing from it, so older files are not
    // opened; the cwd read itself is cached per path either way.
    const indexedUpTo = db ? db.getDbMtime() : 0;
    for (const file of findRolloutFilesInConfiguredHomes()) {
      if (db && indexedUpTo > 0 && file.mtime.getTime() <= indexedUpTo) continue;
      const cwd = readSessionCwd(file.path);
      if (!cwd) continue;

      const existing = seenCwds.get(cwd);
      if (existing) {
        // Update mtime if newer
        if (file.mtime > existing.lastModified) {
          existing.lastModified = file.mtime;
        }
      } else {
        seenCwds.set(cwd, {
          dir: path.dirname(file.path),
          name: cwd,
          encodedName: cwd,
          sessionCount: 1,
          lastModified: file.mtime,
        });
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

    this.recordDatabaseFallback('getAllProjectFolders', true);
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

  /** Thread title or first user message from the SQLite index; null without it. */
  private extractSessionLabelFromDb(sessionPath: string): string | null {
    const db = this.ensureDb();
    if (!db) return null;
    const sessionId = this.getSessionId(sessionPath);
    const thread = db.getThread(sessionId);
    if (thread?.title) {
      this.recordDatabaseFallback('extractSessionLabel', true);
      return truncate(thread.title, 60);
    }
    if (thread?.first_user_message) {
      this.recordDatabaseFallback('extractSessionLabel', true);
      return truncate(thread.first_user_message, 60);
    }
    return null;
  }

  extractSessionLabel(sessionPath: string): string | null {
    const fromDb = this.extractSessionLabelFromDb(sessionPath);
    if (fromDb) return fromDb;

    // File fallback: parse first user message
    const label = extractFirstUserMessage(sessionPath);
    this.recordDatabaseFallback('extractSessionLabel', true);
    return label;
  }

  async extractSessionLabelsAsync(
    sessionPaths: readonly string[],
  ): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    const byId = new Map(
      sessionPaths.map((sessionPath) => [this.getSessionId(sessionPath), sessionPath]),
    );
    const db = await this.ensureDbAsync();
    const threads = await db.getThreadsByIdsAsync([...byId.keys()]);
    for (const thread of threads) {
      const sessionPath = byId.get(thread.id);
      if (!sessionPath) continue;
      const label = thread.title ?? thread.first_user_message;
      if (label) results.set(sessionPath, truncate(label, 60));
    }
    this.dbStatus = db.getRuntimeStatus();
    this.adoptDbIfAvailable(db);

    for (const sessionPath of sessionPaths) {
      if (!results.has(sessionPath)) {
        results.set(sessionPath, await extractFirstUserMessageAsync(sessionPath));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.recordDatabaseFallback('extractSessionLabelsAsync', true);
    return results;
  }

  // --- Data reading ---

  createReader(sessionPath: string): SessionReader {
    return new CodexReader(
      sessionPath,
      (limit, modelId) => {
        this.dynamicContextWindowLimit = limit;
        if (modelId) {
          // Fire-and-forget: persist so historical/static views keep this
          // tier-specific window instead of falling back to the catalog maximum.
          void recordObservedContextWindow(modelId, limit).catch(() => {
            /* non-fatal; the in-memory limit above still applies */
          });
        }
      },
      (limits) => {
        this.lastRateLimitsData = limits;
      },
      (usage) => {
        this.lastTokenUsageData = usage;
      },
    );
  }

  // --- Subagent support ---

  scanSubagents(_sessionDir: string, sessionId: string): SubagentStats[] {
    // Codex tracks forked sessions via forked_from_id in session_meta.
    // Use DB when available, fall back to filesystem scanning.
    const subagents: SubagentStats[] = [];

    // DB approach: spawned subagents (parent recorded in `threads.source`),
    // plus forked children on older schemas that carry `forked_from_id`.
    const db = this.ensureDb();
    if (db) {
      const seen = new Set<string>();
      const children = [
        ...db.getSpawnedChildThreads(sessionId),
        ...db.getThreadsByForkedFromId(sessionId),
      ].filter((thread) => !seen.has(thread.id) && seen.add(thread.id));
      for (const thread of children) {
        const built = cachedSubagentStats(thread.rollout_path, () =>
          this.buildSubagentStats(
            thread.id,
            thread.rollout_path,
            thread.title || thread.agent_nickname,
          ),
        );
        if (built) {
          subagents.push(
            thread.agent_role && !built.agentType
              ? { ...built, agentType: thread.agent_role }
              : built,
          );
        }
      }
      if (children.length > 0) return subagents;
    }

    // Filesystem fallback: scan recent rollout files for a matching
    // forked_from_id. The walk stops after the 50 newest-dated files instead
    // of enumerating the whole history and slicing afterwards.
    for (const file of findRolloutFilesInConfiguredHomes({ limit: 50 })) {
      const meta = readSessionMeta(file.path);
      if (
        meta &&
        (meta.forked_from_id === sessionId || spawnParentFromSource(meta.source) === sessionId)
      ) {
        const childId = extractSessionId(path.basename(file.path));
        // `source` is a plain string for top-level sessions but an object
        // (`{ subagent: { thread_spawn: … } }`) for spawned children.
        const description = typeof meta.source === 'string' ? meta.source : undefined;
        const stats = cachedSubagentStats(file.path, () =>
          this.buildSubagentStats(childId, file.path, description),
        );
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
            // Accumulate tokens from usage events (duplicate token_count events
            // are already dropped by the parser).
            const usage = extractNormalizedUsage(event);
            if (usage) addUsageToSubagent(stats, usage);
          }
        } catch {
          /* skip malformed lines */
        }
      }

      if (stats.startTime && stats.endTime) {
        stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();
      }
    } catch {
      /* skip unreadable files */
    }

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
          const snippet =
            (start > 0 ? '...' : '') +
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

  getWatchRoots(): string[] {
    return getSessionsDirs();
  }

  // --- Stats ---

  readSessionStats(sessionPath: string): SessionFileStats {
    // One reader pass computes stats and the label: the SQLite thread title is
    // used when the index is available, otherwise the first user prompt comes
    // from the events already read, so the rollout is never opened twice.
    return readSessionFileStats(this, sessionPath, {
      resolveLabel: () => this.extractSessionLabelFromDb(sessionPath),
    });
  }

  readSessionContextSnapshot(
    sessionPath: string,
    options: ReadSessionContextSnapshotOptions = {},
  ): SessionContextSnapshot {
    return readSessionContextSnapshot(this, sessionPath, options);
  }

  // --- Optional methods ---

  getContextWindowLimit(modelId?: string): number {
    // Prefer actual model_context_window reported by token_count events
    if (this.dynamicContextWindowLimit) return this.dynamicContextWindowLimit;
    return getModelContextWindowSize(modelId);
  }

  getCurrentUsageSnapshot(_sessionPath: string): TokenUsage | null {
    // Return the last token usage snapshot received via the CodexReader callback.
    // This is populated in real-time as token_count events arrive during active monitoring.
    return this.lastTokenUsageData;
  }

  computeContextSize(usage: TokenUsage): number {
    // Codex usage is normalized to the disjoint TokenUsage shape at the reader
    // boundary, so reconstruct the full prompt/context from uncached + cached.
    return usage.inputTokens + usage.cacheReadTokens;
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
    this.dbStatus = { available: false, kind: 'db_missing' };
    this.dynamicContextWindowLimit = null;
    this.lastRateLimitsData = null;
    this.lastTokenUsageData = null;
    this.directoryCache.invalidate();
  }

  private recordDatabaseFallback(operation: string, usable: boolean): void {
    if (!this.dbInitialized) {
      this.diagnostics.available(operation);
      return;
    }
    const status = this.getRuntimeStatus();
    const diagnostic = diagnosticFromRuntimeStatus(this.id, 'query', status);
    if (!diagnostic) {
      this.diagnostics.available(operation);
      return;
    }
    this.diagnostics.degraded(
      operation,
      status,
      {
        kind: diagnostic.kind,
        severity: diagnostic.severity,
        phase: diagnostic.phase,
        message: diagnostic.message,
      },
      usable,
    );
  }
}
