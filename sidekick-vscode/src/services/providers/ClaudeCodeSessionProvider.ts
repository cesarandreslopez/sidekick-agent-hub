/**
 * @fileoverview Claude Code session provider.
 *
 * Wraps existing SessionPathResolver and JsonlParser functionality
 * behind the SessionProvider interface. This is the default provider
 * for monitoring Claude Code CLI sessions stored as JSONL files
 * in ~/.claude/projects/.
 *
 * @module services/providers/ClaudeCodeSessionProvider
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findActiveSession,
  findAllSessions,
  getSessionDirectory,
  discoverSessionDirectory,
  findSessionsInDirectory,
  getAllProjectFolders as getAllProjectFoldersRaw,
  encodeWorkspacePath,
  decodeEncodedPath
} from '../SessionPathResolver';
import { JsonlParser } from '../JsonlParser';
import { scanSubagentDir } from '../SubagentFileScanner';
import { log } from '../Logger';
import type { SessionProvider, SessionReader, ProjectFolderInfo, SearchHit } from '../../types/sessionProvider';
import type { ClaudeSessionEvent, SubagentStats } from '../../types/claudeSession';

/** Type guard for content blocks with a `type` string property */
function isTypedBlock(block: unknown): block is Record<string, unknown> & { type: string } {
  return block !== null && typeof block === 'object' && typeof (block as Record<string, unknown>).type === 'string';
}

/**
 * Incremental JSONL reader for Claude Code session files.
 *
 * Tracks byte position in the file and uses JsonlParser for
 * streaming line-buffered parsing of new content.
 */
class ClaudeCodeReader implements SessionReader {
  private parser: JsonlParser;
  private filePosition = 0;
  private events: ClaudeSessionEvent[] = [];
  private _wasTruncated = false;

  constructor(private readonly sessionPath: string) {
    this.parser = new JsonlParser({
      onEvent: (e) => this.events.push(e),
      onError: (err, line) => {
        log(`ClaudeCodeReader parse error: ${err.message} — line: ${line.substring(0, 80)}...`);
      }
    });
  }

  readNew(): ClaudeSessionEvent[] {
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
        log(`ClaudeCodeReader: file truncated (${this.filePosition} -> ${currentSize}), re-reading`);
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
      log(`ClaudeCodeReader: error reading: ${error}`);
    }

    return this.events;
  }

  readAll(): ClaudeSessionEvent[] {
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

  wasTruncated(): boolean {
    return this._wasTruncated;
  }
}

/**
 * Session provider for Claude Code CLI.
 *
 * Delegates path resolution to SessionPathResolver, parsing to JsonlParser,
 * and subagent scanning to SubagentFileScanner.
 */
export class ClaudeCodeSessionProvider implements SessionProvider {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';

  getSessionDirectory(workspacePath: string): string {
    return getSessionDirectory(workspacePath);
  }

  discoverSessionDirectory(workspacePath: string): string | null {
    return discoverSessionDirectory(workspacePath);
  }

  findActiveSession(workspacePath: string): string | null {
    return findActiveSession(workspacePath);
  }

  findAllSessions(workspacePath: string): string[] {
    return findAllSessions(workspacePath);
  }

  findSessionsInDirectory(dir: string): string[] {
    return findSessionsInDirectory(dir);
  }

  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
    const raw = getAllProjectFoldersRaw(workspacePath);
    return raw.map(f => ({
      dir: f.path,
      name: f.decodedPath,
      encodedName: f.encodedName,
      sessionCount: f.sessionCount,
      lastModified: f.lastModified
    }));
  }

  isSessionFile(filename: string): boolean {
    return filename.endsWith('.jsonl');
  }

  getSessionId(sessionPath: string): string {
    return path.basename(sessionPath, '.jsonl');
  }

  encodeWorkspacePath(workspacePath: string): string {
    return encodeWorkspacePath(workspacePath);
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

  createReader(sessionPath: string): SessionReader {
    return new ClaudeCodeReader(sessionPath);
  }

  scanSubagents(sessionDir: string, sessionId: string): SubagentStats[] {
    return scanSubagentDir(sessionDir, sessionId);
  }

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
        if (!line.trim()) continue;
        if (!line.toLowerCase().includes(queryLower)) continue;

        try {
          const event = JSON.parse(line);
          const text = extractSearchableText(event);
          if (!text) continue;

          const textLower = text.toLowerCase();
          if (!textLower.includes(queryLower)) continue;

          const matchIdx = textLower.indexOf(queryLower);
          const start = Math.max(0, matchIdx - 40);
          const end = Math.min(text.length, matchIdx + query.length + 40);
          const snippet = (start > 0 ? '...' : '') +
            text.substring(start, end) +
            (end < text.length ? '...' : '');

          results.push({
            sessionPath,
            line: snippet.replace(/\n/g, ' '),
            eventType: event.type || 'unknown',
            timestamp: event.timestamp || '',
            projectPath
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

  getContextWindowLimit(_modelId?: string): number {
    return 200_000;
  }

  dispose(): void {
    // No resources to clean up
  }
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
        if (b.input && typeof b.input === 'object') {
          parts.push(JSON.stringify(b.input));
        }
      }
    }
    return parts.join(' ');
  }

  return '';
}
