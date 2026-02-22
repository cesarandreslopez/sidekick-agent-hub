/**
 * Claude Code session provider for the shared package.
 * Reads JSONL session files from ~/.claude/projects/.
 * Ported from sidekick-vscode/src/services/providers/ClaudeCodeSessionProvider.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonlParser, TRUNCATION_PATTERNS } from '../parsers/jsonl';
import type { RawSessionEvent } from '../parsers/jsonl';
import type { SessionProvider, SessionFileStats, SearchHit, ProjectFolderInfo, ProviderId } from './types';

function encodeWorkspacePath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/');
  return normalized.replace(/[:/_]/g, '-');
}

function decodeEncodedPath(encoded: string): string {
  const windowsDriveMatch = encoded.match(/^([A-Za-z])--(.*)/);
  if (windowsDriveMatch) {
    const drive = windowsDriveMatch[1];
    const rest = windowsDriveMatch[2];
    return `${drive}:/${rest.replace(/-/g, '/')}`;
  }
  if (encoded.startsWith('-')) {
    return '/' + encoded.substring(1).replace(/-/g, '/');
  }
  return encoded.replace(/-/g, '/');
}

function getProjectsBaseDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function discoverSessionDirectory(workspacePath: string): string | null {
  const projectsDir = getProjectsBaseDir();
  const encoded = encodeWorkspacePath(workspacePath);
  const computedDir = path.join(projectsDir, encoded);

  if (fs.existsSync(computedDir)) return computedDir;

  // Check for subdirectory sessions
  try {
    if (fs.existsSync(projectsDir)) {
      const encodedPrefix = encoded.toLowerCase();
      const allDirs = fs.readdirSync(projectsDir).filter(name => {
        try { return fs.statSync(path.join(projectsDir, name)).isDirectory(); }
        catch { return false; }
      });

      // Subdirectory matches
      const subDirMatches = allDirs.filter(dir => dir.toLowerCase().startsWith(encodedPrefix + '-'));
      if (subDirMatches.length > 0) {
        let bestDir: string | null = null;
        let bestMtime = 0;
        for (const dir of subDirMatches) {
          const fullDir = path.join(projectsDir, dir);
          try {
            const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.jsonl'));
            for (const file of files) {
              try {
                const mtime = fs.statSync(path.join(fullDir, file)).mtime.getTime();
                if (mtime > bestMtime) { bestMtime = mtime; bestDir = fullDir; }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
        if (bestDir) return bestDir;
      }

      // Basename matching fallback
      const normalizedWorkspace = workspacePath
        .replace(/\\/g, '/').replace(/:/g, '-').replace(/_/g, '-').replace(/\//g, '-').toLowerCase();
      for (const dir of allDirs) {
        if (dir.toLowerCase() === normalizedWorkspace) return path.join(projectsDir, dir);
      }
      const workspaceBasename = path.basename(workspacePath).replace(/_/g, '-').toLowerCase();
      for (const dir of allDirs) {
        const dirLower = dir.toLowerCase();
        if (dirLower.endsWith('-' + workspaceBasename) || dirLower === workspaceBasename) {
          return path.join(projectsDir, dir);
        }
      }
    }
  } catch { /* skip */ }

  return null;
}

function findAllSessionFiles(workspacePath: string): string[] {
  const sessionDir = discoverSessionDirectory(workspacePath);
  if (!sessionDir) return [];
  try {
    return fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(sessionDir, f);
        try {
          const stats = fs.statSync(fullPath);
          return { path: fullPath, mtime: stats.mtime.getTime(), size: stats.size };
        } catch { return null; }
      })
      .filter((f): f is { path: string; mtime: number; size: number } => f !== null && f.size > 0)
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.path);
  } catch { return []; }
}

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

export class ClaudeCodeProvider implements SessionProvider {
  readonly id: ProviderId = 'claude-code';
  readonly displayName = 'Claude Code';

  findSessionFiles(workspacePath: string): string[] {
    return findAllSessionFiles(workspacePath);
  }

  findAllSessions(workspacePath: string): string[] {
    return findAllSessionFiles(workspacePath);
  }

  getProjectsBaseDir(): string {
    return getProjectsBaseDir();
  }

  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
    const projectsDir = getProjectsBaseDir();
    const folders: ProjectFolderInfo[] = [];
    try {
      if (!fs.existsSync(projectsDir)) return [];
      const entries = fs.readdirSync(projectsDir);
      for (const entry of entries) {
        const fullPath = path.join(projectsDir, entry);
        try {
          if (!fs.statSync(fullPath).isDirectory()) continue;
          const sessionFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.jsonl'));
          let lastModified = new Date(0);
          let sessionCount = 0;
          for (const sf of sessionFiles) {
            try {
              const stats = fs.statSync(path.join(fullPath, sf));
              if (stats.size > 0) {
                sessionCount++;
                if (stats.mtime > lastModified) lastModified = stats.mtime;
              }
            } catch { /* skip */ }
          }
          folders.push({
            dir: fullPath,
            name: decodeEncodedPath(entry),
            encodedName: entry,
            sessionCount,
            lastModified,
          });
        } catch { /* skip */ }
      }

      const encodedWorkspace = workspacePath ? encodeWorkspacePath(workspacePath).toLowerCase() : null;
      folders.sort((a, b) => {
        if (encodedWorkspace) {
          const aEnc = a.encodedName.toLowerCase();
          const bEnc = b.encodedName.toLowerCase();
          const aExact = aEnc === encodedWorkspace;
          const bExact = bEnc === encodedWorkspace;
          if (aExact && !bExact) return -1;
          if (!aExact && bExact) return 1;
          const aSub = aEnc.startsWith(encodedWorkspace + '-');
          const bSub = bEnc.startsWith(encodedWorkspace + '-');
          if (aSub && !bSub) return -1;
          if (!aSub && bSub) return 1;
        }
        return b.lastModified.getTime() - a.lastModified.getTime();
      });
    } catch { /* skip */ }
    return folders;
  }

  readSessionStats(sessionPath: string): SessionFileStats {
    const sessionId = path.basename(sessionPath, '.jsonl');
    const projectDir = path.basename(path.dirname(sessionPath));
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
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }

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
          if (typeof content === 'string') text = content.trim();
          else if (Array.isArray(content)) {
            const textBlock = content.find((b: Record<string, unknown>) =>
              b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim().length > 0
            );
            if (textBlock) text = (textBlock.text as string).trim();
          }
          if (text && text.length > 0) {
            text = text.replace(/\s+/g, ' ');
            return text.length > 60 ? text.substring(0, 57) + '...' : text;
          }
        } catch { /* skip */ }
      }
      return null;
    } catch { return null; }
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
          const snippet = (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
          results.push({
            sessionPath,
            line: snippet.replace(/\n/g, ' '),
            eventType: event.type || 'unknown',
            timestamp: event.timestamp || '',
            projectPath,
          });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return results;
  }

  dispose(): void {}
}
