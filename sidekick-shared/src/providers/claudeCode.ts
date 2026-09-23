/**
 * Claude Code session provider for the shared package.
 * Reads JSONL session files from ~/.claude/projects/.
 *
 * Implements the full SessionProviderBase interface with incremental
 * reading via ClaudeCodeReader, subagent scanning, and cross-session search.
 *
 * Ported from sidekick-vscode/src/services/providers/ClaudeCodeSessionProvider.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { readSessionContextSnapshot } from '../context/sessionContext';
import { readSessionFileStats } from '../sessionStats';
import type {
  ReadSessionContextSnapshotOptions,
  SessionContextSnapshot,
} from '../context/sessionContext';
import { JsonlParser } from '../parsers/jsonl';
import { ClaudeUsageDeduper, normalizeClaudeUsage } from '../usage/claudeUsageDedupe';
import type { RawSessionEvent } from '../parsers/jsonl';
import type { SessionEvent, SubagentStats, TokenUsage } from '../types/sessionEvent';
import type {
  ListSessionFilesOptions,
  SessionProviderBase,
  SessionReader,
  SessionFileInfo,
  SessionFileStats,
  SearchHit,
  ProjectFolderInfo,
  ProviderId,
  ProviderOperationStatus,
  ProviderRuntimeStatus,
  SessionProviderOptions,
  WatchedSessionFile,
} from './types';
import { ProviderDiagnosticTracker } from './diagnostics';
import { DirectoryListingCache, splitWatchedPath } from './directoryListingCache';
import {
  encodeWorkspacePath as encodeWsPath,
  getSessionDirectory as getSessionDir,
  discoverSessionDirectory as discoverSessionDir,
  findActiveSession as findActiveSessionPath,
  findAllSessions as findAllSessionPaths,
  findSessionsInDirectory as findSessionsInDir,
  decodeEncodedPath,
  getAllProjectFolders as getAllProjectFoldersRaw,
  findSessionFilesWithStats,
} from '../parsers/sessionPathResolver';
import { scanSubagentDir } from '../parsers/subagentScanner';
import { getModelContextWindowSize } from '../modelContext';
import { extractSessionEvents } from '../schemas/sessionEvent';

/** Type guard for content blocks with a `type` string property */
function isTypedBlock(block: unknown): block is Record<string, unknown> & { type: string } {
  return (
    block !== null &&
    typeof block === 'object' &&
    typeof (block as Record<string, unknown>).type === 'string'
  );
}

/**
 * Extracts searchable text from a session event object.
 */
function extractSearchableText(event: Record<string, unknown>): string {
  const content = (event.message as Record<string, unknown>)?.content;
  if (!content) return '';

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') parts.push(b.text as string);
        if (typeof b.thinking === 'string') parts.push(b.thinking as string);
        if (typeof b.content === 'string') parts.push(b.content as string);
        if (b.input && typeof b.input === 'object') parts.push(JSON.stringify(b.input));
      }
    }
    return parts.join(' ');
  }

  return '';
}

/**
 * Project-directory filter for a workspace: the encoded workspace path, a
 * worktree suffix of it, or a directory ending in the workspace's basename.
 * Without a workspace every directory matches.
 */
function workspaceDirectoryFilter(workspacePath?: string): (directoryName: string) => boolean {
  if (!workspacePath) return () => true;
  const encodedWorkspace = encodeWsPath(workspacePath).toLowerCase();
  const workspaceBasename = path
    .basename(workspacePath)
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase();
  return (directoryName) => {
    const name = directoryName.toLowerCase();
    return (
      name === encodedWorkspace ||
      name.startsWith(`${encodedWorkspace}-`) ||
      name === workspaceBasename ||
      name.endsWith(`-${workspaceBasename}`)
    );
  };
}

function extractClaudeLabelFromPrefix(chunk: string): string | null {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type !== 'user') continue;
      const content = event.message?.content;
      if (!content) continue;
      let text: string | null = null;
      if (typeof content === 'string') {
        text = content.trim();
      } else if (Array.isArray(content)) {
        const textBlock = content.find(
          (block: unknown) =>
            isTypedBlock(block) &&
            block.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.trim().length > 0,
        );
        if (textBlock && isTypedBlock(textBlock) && typeof textBlock.text === 'string') {
          text = textBlock.text.trim();
        }
      }
      if (text) {
        const compact = text.replace(/\s+/g, ' ');
        return compact.length > 60 ? compact.substring(0, 57) + '...' : compact;
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return null;
}

/**
 * Incremental JSONL reader for Claude Code session files.
 *
 * Tracks byte position in the file and uses JsonlParser for
 * streaming line-buffered parsing of new content.
 */
class ClaudeCodeReader implements SessionReader {
  private parser: JsonlParser<unknown>;
  private filePosition = 0;
  /** Cursor after the last complete line, safe to persist across restarts. */
  private committedPosition = 0;
  private events: SessionEvent[] = [];
  private _wasTruncated = false;
  private decoder = new StringDecoder('utf8');
  /** Split lines of one response repeat its usage; count each response once. */
  private readonly usageDeduper: ClaudeUsageDeduper;

  constructor(
    private readonly sessionPath: string,
    usageDeduper?: ClaudeUsageDeduper,
  ) {
    this.usageDeduper = usageDeduper ?? new ClaudeUsageDeduper();
    this.parser = new JsonlParser<unknown>({
      onEvent: (raw) => {
        for (const event of extractSessionEvents(raw)) {
          this.events.push(this.usageDeduper.apply(normalizeClaudeUsage(event)));
        }
      },
      onError: (_err, _line) => {
        // Silently skip parse errors — no logging framework dependency
      },
    });
  }

  readNew(): SessionEvent[] {
    this.events = [];
    this._wasTruncated = false;

    try {
      if (!fs.existsSync(this.sessionPath)) {
        return [];
      }

      const stats = fs.statSync(this.sessionPath);
      const currentSize = stats.size;

      // Handle truncation
      if (currentSize < this.filePosition) {
        this._wasTruncated = true;
        this.filePosition = 0;
        this.committedPosition = 0;
        this.parser.reset();
        this.decoder = new StringDecoder('utf8');
        this.usageDeduper.reset();
      }

      // No new content
      if (currentSize <= this.filePosition) {
        return [];
      }

      // Read new bytes from last position
      const fd = fs.openSync(this.sessionPath, 'r');
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
      this.parser.processChunk(chunk);
      this.filePosition += bytesRead;
    } catch (error) {
      console.error(`ClaudeCodeReader: error reading ${this.sessionPath}: ${error}`);
    }

    return this.events;
  }

  readAll(): SessionEvent[] {
    this.reset();
    return this.readNew();
  }

  reset(): void {
    this.filePosition = 0;
    this.committedPosition = 0;
    this.parser.reset();
    this.decoder = new StringDecoder('utf8');
    this.usageDeduper.reset();
    this._wasTruncated = false;
  }

  exists(): boolean {
    return fs.existsSync(this.sessionPath);
  }

  flush(): void {
    const finalChunk = this.decoder.end();
    if (finalChunk) this.parser.processChunk(finalChunk);
    this.parser.flush();
    this.decoder = new StringDecoder('utf8');
  }

  getPosition(): number {
    return this.committedPosition;
  }

  seekTo(position: number): void {
    this.filePosition = position;
    this.committedPosition = position;
    this.parser.reset();
    this.decoder = new StringDecoder('utf8');
  }

  wasTruncated(): boolean {
    return this._wasTruncated;
  }
}

/**
 * Session provider for Claude Code CLI.
 *
 * Implements the full SessionProviderBase interface, delegating path
 * resolution to sessionPathResolver, parsing to JsonlParser, and
 * subagent scanning to subagentScanner.
 */
export class ClaudeCodeProvider implements SessionProviderBase {
  readonly id: ProviderId = 'claude-code';
  readonly displayName = 'Claude Code';

  private readonly diagnostics: ProviderDiagnosticTracker;

  /** Runtime-reported context window limit (overrides static map when set). */
  private dynamicContextWindowLimit: number | null = null;

  /** Project-directory listings reused across async enumerations. */
  private readonly directoryCache = new DirectoryListingCache();

  constructor(options: SessionProviderOptions = {}) {
    this.diagnostics = new ProviderDiagnosticTracker(this.id, options);
  }

  // --- Path resolution ---

  getSessionDirectory(workspacePath: string): string {
    return getSessionDir(workspacePath);
  }

  discoverSessionDirectory(workspacePath: string): string | null {
    return discoverSessionDir(workspacePath);
  }

  // --- Session discovery ---

  findActiveSession(workspacePath: string): string | null {
    return findActiveSessionPath(workspacePath);
  }

  findAllSessions(workspacePath: string): string[] {
    return findAllSessionPaths(workspacePath);
  }

  findSessionById(workspacePath: string, sessionId: string): string | null {
    const normalizedId = sessionId.trim();
    if (!normalizedId || path.basename(normalizedId) !== normalizedId) return null;
    try {
      const directories = new Set<string>();
      directories.add(this.getSessionDirectory(workspacePath));
      const discovered = this.discoverSessionDirectory(workspacePath);
      if (discovered) directories.add(discovered);
      for (const folder of this.getAllProjectFolders(workspacePath)) directories.add(folder.dir);

      for (const directory of directories) {
        const direct = path.join(directory, `${normalizedId}.jsonl`);
        try {
          if (fs.statSync(direct).isFile()) {
            this.diagnostics.available('findSessionById');
            return direct;
          }
        } catch {
          // Continue with directory-shaped lookup for worktree layouts.
        }
        const match = this.findSessionsInDirectory(directory).find(
          (candidate) => this.getSessionId(candidate) === normalizedId,
        );
        if (match) {
          this.diagnostics.available('findSessionById');
          return match;
        }
      }
      this.recordHomeStatus('findSessionById');
      return null;
    } catch {
      this.recordHomeStatus('findSessionById');
      return null;
    }
  }

  /** Backward-compatible alias for findAllSessions. */
  findSessionFiles(workspacePath: string): string[] {
    return this.findAllSessions(workspacePath);
  }

  findSessionsInDirectory(dir: string): string[] {
    return findSessionsInDir(dir);
  }

  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
    return getAllProjectFoldersRaw(workspacePath);
  }

  listAllSessionFiles(): SessionFileInfo[] {
    const results: SessionFileInfo[] = [];
    const seen = new Set<string>();
    for (const folder of this.getAllProjectFolders()) {
      // The directory listing already stat'ed each file; reuse it instead of
      // stat'ing every session a second time.
      for (const file of findSessionFilesWithStats(folder.dir)) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        results.push({ path: file.path, mtime: file.mtime, sizeBytes: file.sizeBytes });
      }
    }
    this.recordHomeStatus('listAllSessionFiles');
    return results;
  }

  /**
   * Enumerate session files across project directories through the
   * directory cache: one stat per project directory, a readdir only for
   * directories whose mtime changed, and a stat only for files new to a
   * changed directory (or recently modified, with `revalidateRecent`).
   *
   * With `limit`, directories are visited newest-mtime first and the walk
   * stops once the remaining directories are older than the newest `limit`
   * files found. A directory's mtime ignores appends, so a cold limited walk
   * can miss a long-running session in an old directory until its next watch
   * event; `since` filters files and shares the caveat.
   */
  async listSessionFilesAsync(
    workspacePath?: string,
    options: ListSessionFilesOptions = {},
  ): Promise<SessionFileInfo[]> {
    const projectsRoot = this.getProjectsBaseDir();
    if (options.stats) {
      options.stats.directoriesListed ??= 0;
      options.stats.directoriesStatted ??= 0;
      options.stats.filesStatted ??= 0;
    }
    const root = await this.directoryCache.listDirectory(projectsRoot, () => false, {
      revalidateRecent: options.revalidateRecent,
      stats: options.stats,
    });
    if (!root) {
      this.recordHomeStatus('listSessionFilesAsync');
      return [];
    }

    const limit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? Math.max(0, Math.floor(options.limit))
        : null;
    if (limit === 0) {
      this.recordHomeStatus('listSessionFilesAsync');
      return [];
    }
    const since =
      options.since !== undefined && Number.isFinite(options.since) ? options.since : null;
    const matchesWorkspace = workspaceDirectoryFilter(workspacePath);

    const candidates: Array<{ directory: string; stat: fs.Stats }> = [];
    let sinceYield = 0;
    for (const name of root.subdirectories) {
      if (!matchesWorkspace(name)) continue;
      const directory = path.join(projectsRoot, name);
      try {
        const stat = await fs.promises.stat(directory);
        if (options.stats) {
          options.stats.directoriesStatted = (options.stats.directoriesStatted ?? 0) + 1;
        }
        if (stat.isDirectory()) candidates.push({ directory, stat });
      } catch {
        continue;
      }
      if (++sinceYield >= 50) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (limit !== null) candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

    const byNewest = (left: SessionFileInfo, right: SessionFileInfo): number =>
      right.mtime.getTime() - left.mtime.getTime();
    const results: SessionFileInfo[] = [];
    let cutoffMs: number | null = null;
    for (const candidate of candidates) {
      if (limit !== null && cutoffMs !== null && candidate.stat.mtimeMs < cutoffMs) break;
      const listing = await this.directoryCache.listDirectory(
        candidate.directory,
        (name) => this.isSessionFile(name),
        {
          dirStat: candidate.stat,
          revalidateRecent: options.revalidateRecent,
          stats: options.stats,
        },
      );
      if (!listing) continue;
      for (const [name, stat] of listing.files) {
        if (stat.sizeBytes <= 0) continue;
        if (since !== null && stat.mtimeMs < since) continue;
        const sessionPath = path.join(candidate.directory, name);
        results.push({
          path: sessionPath,
          mtime: new Date(stat.mtimeMs),
          sizeBytes: stat.sizeBytes,
          sessionId: this.getSessionId(sessionPath),
        });
      }
      if (limit !== null && results.length >= limit) {
        results.sort(byNewest);
        results.length = limit;
        cutoffMs = results[limit - 1].mtime.getTime();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.recordHomeStatus('listSessionFilesAsync');
    results.sort(byNewest);
    return limit !== null && results.length > limit ? results.slice(0, limit) : results;
  }

  /**
   * Resolve a recursive-watch event under the projects root with one stat.
   * Sessions live exactly one directory below the root; deeper paths are
   * subagent transcripts and are ignored. A path at the root itself is a
   * project directory appearing or vanishing, which needs a full listing.
   */
  async statWatchedSessionFile(
    root: string,
    relativePath: string,
    workspacePath?: string,
  ): Promise<WatchedSessionFile> {
    const segments = splitWatchedPath(relativePath);
    if (!segments) return { status: 'unknown' };
    if (segments.length > 2) return { status: 'ignored' };
    const fullPath = path.join(root, ...segments);
    if (segments.length === 1) {
      this.directoryCache.invalidate(fullPath);
      try {
        const stat = await fs.promises.stat(fullPath);
        return stat.isDirectory() ? { status: 'unknown' } : { status: 'ignored' };
      } catch {
        return { status: 'unknown' };
      }
    }
    const [directoryName, fileName] = segments;
    if (!this.isSessionFile(fileName)) return { status: 'ignored' };
    if (!workspaceDirectoryFilter(workspacePath)(directoryName)) return { status: 'ignored' };
    const sessionId = this.getSessionId(fullPath);
    const stat = await this.directoryCache.refreshFile(fullPath);
    if (!stat || stat.sizeBytes <= 0) return { status: 'missing', path: fullPath, sessionId };
    return {
      status: 'present',
      file: {
        path: fullPath,
        mtime: new Date(stat.mtimeMs),
        sizeBytes: stat.sizeBytes,
        sessionId,
      },
    };
  }

  // --- File identification ---

  isSessionFile(filename: string): boolean {
    return filename.endsWith('.jsonl');
  }

  getSessionId(sessionPath: string): string {
    return path.basename(sessionPath, '.jsonl');
  }

  encodeWorkspacePath(workspacePath: string): string {
    return encodeWsPath(workspacePath);
  }

  extractSessionLabel(sessionPath: string): string | null {
    try {
      const fd = fs.openSync(sessionPath, 'r');
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
      fs.closeSync(fd);

      if (bytesRead === 0) return null;

      return extractClaudeLabelFromPrefix(buffer.toString('utf-8', 0, bytesRead));
    } catch {
      return null;
    }
  }

  async extractSessionLabelsAsync(
    sessionPaths: readonly string[],
  ): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    for (const sessionPath of sessionPaths) {
      let handle: fs.promises.FileHandle | null = null;
      try {
        handle = await fs.promises.open(sessionPath, 'r');
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        results.set(
          sessionPath,
          extractClaudeLabelFromPrefix(buffer.toString('utf8', 0, bytesRead)),
        );
      } catch {
        results.set(sessionPath, null);
      } finally {
        await handle?.close().catch(() => undefined);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return results;
  }

  // --- Data reading ---

  createReader(sessionPath: string): SessionReader {
    return new ClaudeCodeReader(sessionPath);
  }

  // --- Subagent support ---

  scanSubagents(sessionDir: string, sessionId: string): SubagentStats[] {
    return scanSubagentDir(sessionDir, sessionId);
  }

  // --- Cross-session search ---

  searchInSession(sessionPath: string, query: string, maxResults: number): SearchHit[] {
    const results: SearchHit[] = [];
    const queryLower = query.toLowerCase();

    try {
      const content = fs.readFileSync(sessionPath, 'utf8');
      const lines = content.split('\n');
      const projectDir = path.basename(path.dirname(sessionPath));
      const projectPath = decodeEncodedPath(projectDir);

      for (const line of lines) {
        if (results.length >= maxResults) break;
        if (!line.trim() || !line.toLowerCase().includes(queryLower)) continue;

        try {
          const event = JSON.parse(line);
          const text = extractSearchableText(event);
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
            eventType: event.type || 'unknown',
            timestamp: event.timestamp || '',
            projectPath,
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
    return path.join(os.homedir(), '.claude', 'projects');
  }

  getWatchRoots(): string[] {
    return [this.getProjectsBaseDir()];
  }

  // --- Stats ---

  readSessionStats(sessionPath: string): SessionFileStats {
    // One reader pass through the shared aggregator: cache-inclusive per-model
    // totals, cost with provenance, a tool success/failure split, and the label
    // from the first user prompt in the events already read.
    return readSessionFileStats(this, sessionPath);
  }

  readSessionContextSnapshot(
    sessionPath: string,
    options: ReadSessionContextSnapshotOptions = {},
  ): SessionContextSnapshot {
    return readSessionContextSnapshot(this, sessionPath, options);
  }

  // --- Optional methods ---

  getRuntimeStatus(): ProviderRuntimeStatus {
    try {
      fs.accessSync(this.getProjectsBaseDir(), fs.constants.R_OK);
      return { available: true, kind: 'available' };
    } catch {
      return {
        available: false,
        kind: 'home_unavailable',
        message: 'Claude Code session home is unavailable.',
      };
    }
  }

  getLastOperationStatus(): ProviderOperationStatus {
    return this.diagnostics.getLastOperationStatus();
  }

  getContextWindowLimit(modelId?: string): number {
    if (this.dynamicContextWindowLimit) return this.dynamicContextWindowLimit;
    return getModelContextWindowSize(modelId);
  }

  /** Set a runtime-reported context window limit (overrides static map). */
  setDynamicContextWindowLimit(limit: number): void {
    this.dynamicContextWindowLimit = limit;
  }

  /**
   * Returns the latest assistant message's token usage snapshot.
   *
   * Reads the session JSONL file backwards to find the most recent assistant
   * message with usage data, avoiding the need to parse the entire file.
   */
  getCurrentUsageSnapshot(sessionPath: string): TokenUsage | null {
    try {
      if (!fs.existsSync(sessionPath)) return null;

      // Read the last portion of the file to find the most recent assistant message
      const stats = fs.statSync(sessionPath);
      const readSize = Math.min(stats.size, 64 * 1024); // Last 64KB
      const fd = fs.openSync(sessionPath, 'r');
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
      fs.closeSync(fd);

      const chunk = buffer.toString('utf-8');
      const lines = chunk.split('\n').reverse();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;

        try {
          const event = JSON.parse(trimmed) as RawSessionEvent;
          if (event.type === 'assistant' && event.message?.usage) {
            const u = event.message.usage;
            return {
              inputTokens: u.input_tokens || 0,
              outputTokens: u.output_tokens || 0,
              cacheWriteTokens: u.cache_creation_input_tokens || 0,
              cacheReadTokens: u.cache_read_input_tokens || 0,
              model: event.message.model || 'unknown',
              timestamp: new Date(event.timestamp || Date.now()),
              reportedCost: u.reported_cost,
            };
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

  // --- Lifecycle ---

  dispose(): void {
    this.dynamicContextWindowLimit = null;
    this.directoryCache.invalidate();
  }

  private recordHomeStatus(operation: string): void {
    const status = this.getRuntimeStatus();
    if (status.available) {
      this.diagnostics.available(operation);
      return;
    }
    this.diagnostics.degraded(operation, status, {
      kind: 'home_unavailable',
      severity: 'info',
      phase: 'enumerate',
      message: status.message ?? 'Claude Code session home is unavailable.',
    });
  }
}
