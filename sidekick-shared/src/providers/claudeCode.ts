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
import type {
  ReadSessionContextSnapshotOptions,
  SessionContextSnapshot,
} from '../context/sessionContext';
import { JsonlParser, TRUNCATION_PATTERNS } from '../parsers/jsonl';
import type { RawSessionEvent } from '../parsers/jsonl';
import type { SessionEvent, SubagentStats, TokenUsage } from '../types/sessionEvent';
import type {
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
} from './types';
import { ProviderDiagnosticTracker } from './diagnostics';
import {
  encodeWorkspacePath as encodeWsPath,
  getSessionDirectory as getSessionDir,
  discoverSessionDirectory as discoverSessionDir,
  findActiveSession as findActiveSessionPath,
  findAllSessions as findAllSessionPaths,
  findSessionsInDirectory as findSessionsInDir,
  decodeEncodedPath,
  getAllProjectFolders as getAllProjectFoldersRaw,
} from '../parsers/sessionPathResolver';
import { scanSubagentDir } from '../parsers/subagentScanner';
import { getModelContextWindowSize } from '../modelContext';
import { extractSessionEvents } from '../schemas/sessionEvent';
import { normalizeProviderUsage } from '../usageNormalization';

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
  private events: SessionEvent[] = [];
  private _wasTruncated = false;
  private decoder = new StringDecoder('utf8');

  constructor(private readonly sessionPath: string) {
    this.parser = new JsonlParser<unknown>({
      onEvent: (raw) => {
        for (const event of extractSessionEvents(raw)) {
          this.events.push(normalizeClaudeUsage(event));
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
        this.parser.reset();
        this.decoder = new StringDecoder('utf8');
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

      const chunk = this.decoder.write(buffer.subarray(0, bytesRead));
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
    this.parser.reset();
    this.decoder = new StringDecoder('utf8');
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
    return this.filePosition;
  }

  seekTo(position: number): void {
    this.filePosition = position;
    this.parser.reset();
    this.decoder = new StringDecoder('utf8');
  }

  wasTruncated(): boolean {
    return this._wasTruncated;
  }
}

function normalizeClaudeUsage(event: SessionEvent): SessionEvent {
  const message = event.message;
  const usage = message?.usage;
  if (!message || !usage) {
    return {
      ...event,
      providerMetadata: {
        ...event.providerMetadata,
        providerId: 'claude-code',
        source: 'claude-code-jsonl',
      },
    };
  }
  return {
    ...event,
    message: {
      ...message,
      normalizedUsage: normalizeProviderUsage({
        semantics: 'anthropic',
        provider: 'anthropic',
        source: 'claude-code-jsonl',
        model: message.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
        reasoningTokens: usage.reasoning_tokens,
        reasoningIncludedInOutput: false,
        reportedCostUsd: usage.reported_cost,
      }),
    },
    providerMetadata: {
      ...event.providerMetadata,
      providerId: 'claude-code',
      source: 'claude-code-jsonl',
    },
  };
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
      for (const sessionPath of this.findSessionsInDirectory(folder.dir)) {
        if (seen.has(sessionPath)) continue;
        seen.add(sessionPath);
        try {
          results.push({ path: sessionPath, mtime: fs.statSync(sessionPath).mtime });
        } catch {
          // Skip files that vanish between listing and stat.
        }
      }
    }
    this.recordHomeStatus('listAllSessionFiles');
    return results;
  }

  async listSessionFilesAsync(workspacePath?: string): Promise<SessionFileInfo[]> {
    const projectsRoot = this.getProjectsBaseDir();
    let projectEntries: fs.Dirent[] = [];
    try {
      projectEntries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    } catch {
      this.recordHomeStatus('listSessionFilesAsync');
      return [];
    }

    const encodedWorkspace = workspacePath ? encodeWsPath(workspacePath).toLowerCase() : null;
    const workspaceBasename = workspacePath
      ? path
          .basename(workspacePath)
          .replace(/[^a-zA-Z0-9]/g, '-')
          .toLowerCase()
      : null;
    const directories: string[] = [];
    for (const entry of projectEntries) {
      const directory = path.join(projectsRoot, entry.name);
      try {
        const stat = entry.isDirectory() ? null : await fs.promises.stat(directory);
        if (!entry.isDirectory() && !stat?.isDirectory()) continue;
      } catch {
        continue;
      }
      const name = entry.name.toLowerCase();
      if (
        encodedWorkspace &&
        name !== encodedWorkspace &&
        !name.startsWith(`${encodedWorkspace}-`) &&
        name !== workspaceBasename &&
        !name.endsWith(`-${workspaceBasename}`)
      ) {
        continue;
      }
      directories.push(directory);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const results: SessionFileInfo[] = [];
    for (const directory of directories) {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !this.isSessionFile(entry.name)) continue;
        const sessionPath = path.join(directory, entry.name);
        try {
          const stat = await fs.promises.stat(sessionPath);
          if (stat.size > 0) {
            results.push({
              path: sessionPath,
              mtime: stat.mtime,
              sizeBytes: stat.size,
              sessionId: this.getSessionId(sessionPath),
            });
          }
        } catch {
          // Skip files that vanish between discovery and stat.
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.recordHomeStatus('listSessionFilesAsync');
    return results.sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
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
    const sessionId = path.basename(sessionPath, '.jsonl');
    let messageCount = 0;
    let startTime = '';
    let endTime = '';
    const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const modelUsage: Record<string, { calls: number; tokens: number }> = {};
    const toolUsage: Record<string, number> = {};
    let compactionEstimate = 0;
    let truncationCount = 0;
    let reportedCost = 0;

    try {
      const content = fs.readFileSync(sessionPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const event = JSON.parse(trimmed) as RawSessionEvent;
          if (!startTime && event.timestamp) startTime = event.timestamp;
          if (event.timestamp) endTime = event.timestamp;

          if (event.type === 'assistant' && event.message?.usage) {
            messageCount++;
            const u = event.message.usage;
            tokens.input += u.input_tokens || 0;
            tokens.output += u.output_tokens || 0;
            tokens.cacheWrite += u.cache_creation_input_tokens || 0;
            tokens.cacheRead += u.cache_read_input_tokens || 0;
            if (u.reported_cost) reportedCost += u.reported_cost;

            const model = event.message.model || 'unknown';
            if (!modelUsage[model]) modelUsage[model] = { calls: 0, tokens: 0 };
            modelUsage[model].calls++;
            modelUsage[model].tokens += (u.input_tokens || 0) + (u.output_tokens || 0);

            // Check content for tool_use blocks
            if (Array.isArray(event.message.content)) {
              for (const block of event.message.content as Array<Record<string, unknown>>) {
                if (block.type === 'tool_use' && typeof block.name === 'string') {
                  toolUsage[block.name] = (toolUsage[block.name] || 0) + 1;
                }
              }
            }
          }

          if (event.type === 'user') messageCount++;

          if (event.type === 'summary') compactionEstimate++;

          // Check for truncation in tool results
          if (event.type === 'user' && Array.isArray(event.message?.content)) {
            for (const block of event.message.content as Array<Record<string, unknown>>) {
              if (block.type === 'tool_result' && typeof block.content === 'string') {
                for (const pattern of TRUNCATION_PATTERNS) {
                  if (pattern.regex.test(block.content as string)) {
                    truncationCount++;
                    break;
                  }
                }
              }
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip unreadable files
    }

    return {
      providerId: 'claude-code',
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
      truncationCount,
      reportedCost,
    };
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
