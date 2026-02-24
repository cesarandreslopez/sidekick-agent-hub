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
import { JsonlParser, TRUNCATION_PATTERNS } from '../parsers/jsonl';
import type { RawSessionEvent } from '../parsers/jsonl';
import type { SessionEvent, SubagentStats } from '../types/sessionEvent';
import type {
  SessionProviderBase,
  SessionReader,
  SessionFileStats,
  SearchHit,
  ProjectFolderInfo,
  ProviderId,
} from './types';
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

/** Type guard for content blocks with a `type` string property */
function isTypedBlock(block: unknown): block is Record<string, unknown> & { type: string } {
  return block !== null && typeof block === 'object' && typeof (block as Record<string, unknown>).type === 'string';
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
 * Incremental JSONL reader for Claude Code session files.
 *
 * Tracks byte position in the file and uses JsonlParser for
 * streaming line-buffered parsing of new content.
 */
class ClaudeCodeReader implements SessionReader {
  private parser: JsonlParser<SessionEvent>;
  private filePosition = 0;
  private events: SessionEvent[] = [];
  private _wasTruncated = false;

  constructor(private readonly sessionPath: string) {
    this.parser = new JsonlParser<SessionEvent>({
      onEvent: (e) => this.events.push(e),
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
      }

      // No new content
      if (currentSize <= this.filePosition) {
        return [];
      }

      // Read new bytes from last position
      const fd = fs.openSync(this.sessionPath, 'r');
      const bufferSize = currentSize - this.filePosition;
      const buffer = Buffer.alloc(bufferSize);
      fs.readSync(fd, buffer, 0, bufferSize, this.filePosition);
      fs.closeSync(fd);

      const chunk = buffer.toString('utf-8');
      this.parser.processChunk(chunk);
      this.filePosition = currentSize;
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
    this._wasTruncated = false;
  }

  exists(): boolean {
    return fs.existsSync(this.sessionPath);
  }

  flush(): void {
    this.parser.flush();
  }

  getPosition(): number {
    return this.filePosition;
  }

  seekTo(position: number): void {
    this.filePosition = position;
    this.parser.reset();
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

      const chunk = buffer.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n');

      for (const line of lines) {
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
            const textBlock = content.find((block: unknown) =>
              isTypedBlock(block) &&
              block.type === 'text' &&
              typeof block.text === 'string' &&
              (block.text as string).trim().length > 0
            );
            if (textBlock && isTypedBlock(textBlock) && typeof textBlock.text === 'string') {
              text = (textBlock.text as string).trim();
            }
          }

          if (text && text.length > 0) {
            text = text.replace(/\s+/g, ' ');
            if (text.length > 60) {
              text = text.substring(0, 57) + '...';
            }
            return text;
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

  // --- Optional methods ---

  getContextWindowLimit(_modelId?: string): number {
    return 200_000;
  }

  // --- Lifecycle ---

  dispose(): void {
    // No resources to clean up
  }
}
