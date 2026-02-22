/**
 * Codex CLI session provider for the shared package.
 * Reads JSONL rollout files from ~/.codex/sessions/.
 * Ported from sidekick-vscode/src/services/providers/CodexSessionProvider.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexDatabase } from './codexDatabase';
import type { SessionProvider, SessionFileStats, SearchHit, ProjectFolderInfo, ProviderId } from './types';

function getCodexHome(): string {
  const envHome = process.env.CODEX_HOME;
  if (envHome) return envHome;
  return path.join(os.homedir(), '.codex');
}

function getSessionsDir(): string { return path.join(getCodexHome(), 'sessions'); }

function isRolloutFile(filename: string): boolean {
  return filename.startsWith('rollout-') && filename.endsWith('.jsonl');
}

function extractSessionId(filename: string): string {
  const base = path.basename(filename, '.jsonl');
  const parts = base.split('-');
  if (parts.length >= 6) {
    const possibleUuid = parts.slice(-5).join('-');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(possibleUuid)) {
      return possibleUuid;
    }
  }
  return base.replace(/^rollout-/, '');
}

function findRolloutFiles(dir: string): Array<{ path: string; mtime: Date }> {
  const results: Array<{ path: string; mtime: Date }> = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...findRolloutFiles(fullPath));
      else if (entry.isFile() && isRolloutFile(entry.name)) {
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size > 0) results.push({ path: fullPath, mtime: stats.mtime });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return results;
}

function readSessionMeta(rolloutPath: string): { cwd: string; id?: string } | null {
  try {
    const fd = fs.openSync(rolloutPath, 'r');
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
    fs.closeSync(fd);
    if (bytesRead === 0) return null;
    const text = buf.toString('utf-8', 0, bytesRead);
    const nlIdx = text.indexOf('\n');
    const firstLine = (nlIdx >= 0 ? text.substring(0, nlIdx) : text).trim();
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    if (parsed.type === 'session_meta') return parsed.payload;
  } catch { /* skip */ }
  return null;
}

function cwdMatches(sessionCwd: string, workspacePath: string): boolean {
  const ns = normalizePath(sessionCwd);
  const nw = normalizePath(workspacePath);
  return ns === nw || nw.startsWith(ns + path.sep) || ns.startsWith(nw + path.sep);
}

function normalizePath(input: string): string {
  try { return fs.realpathSync(input); }
  catch { return path.resolve(input); }
}

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxLen ? trimmed.substring(0, maxLen - 3) + '...' : trimmed;
}

function isSystemInjection(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('#');
}

export class CodexProvider implements SessionProvider {
  readonly id: ProviderId = 'codex';
  readonly displayName = 'Codex CLI';
  private db: CodexDatabase | null = null;
  private dbInitialized = false;

  private ensureDb(): CodexDatabase | null {
    if (this.dbInitialized) return this.db;
    this.dbInitialized = true;
    const db = new CodexDatabase(getCodexHome());
    if (db.isAvailable() && db.open()) this.db = db;
    return this.db;
  }

  findSessionFiles(workspacePath: string): string[] { return this.findAllSessions(workspacePath); }

  findAllSessions(workspacePath: string): string[] {
    const db = this.ensureDb();
    if (db) {
      const threads = db.getThreadsByCwd(workspacePath);
      const dbPaths = threads.filter(t => t.rollout_path && fs.existsSync(t.rollout_path)).map(t => t.rollout_path);
      if (dbPaths.length > 0) return dbPaths;
    }
    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) return [];
    const files = findRolloutFiles(sessionsDir);
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files.filter(f => {
      const meta = readSessionMeta(f.path);
      return meta && cwdMatches(meta.cwd, workspacePath);
    }).map(f => f.path);
  }

  getProjectsBaseDir(): string { return getSessionsDir(); }

  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
    const folders: ProjectFolderInfo[] = [];
    const seenCwds = new Map<string, ProjectFolderInfo>();
    const db = this.ensureDb();
    if (db) {
      const cwdStats = db.getAllDistinctCwds();
      for (const stat of cwdStats) {
        seenCwds.set(stat.cwd, {
          dir: getSessionsDir(), name: stat.cwd, encodedName: stat.cwd,
          sessionCount: stat.count, lastModified: new Date(stat.lastUpdated),
        });
      }
    }
    const sessionsDir = getSessionsDir();
    if (fs.existsSync(sessionsDir)) {
      const files = findRolloutFiles(sessionsDir);
      for (const file of files) {
        const meta = readSessionMeta(file.path);
        if (!meta?.cwd) continue;
        const existing = seenCwds.get(meta.cwd);
        if (existing) {
          if (file.mtime > existing.lastModified) existing.lastModified = file.mtime;
        } else {
          seenCwds.set(meta.cwd, {
            dir: path.dirname(file.path), name: meta.cwd, encodedName: meta.cwd,
            sessionCount: 1, lastModified: file.mtime,
          });
        }
      }
    }
    folders.push(...seenCwds.values());
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

  extractSessionLabel(sessionPath: string): string | null {
    const db = this.ensureDb();
    if (db) {
      const sessionId = extractSessionId(path.basename(sessionPath));
      const thread = db.getThread(sessionId);
      if (thread?.title) return truncate(thread.title, 60);
      if (thread?.first_user_message) return truncate(thread.first_user_message, 60);
    }
    // File fallback: parse first user message
    try {
      const fd = fs.openSync(sessionPath, 'r');
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
      fs.closeSync(fd);
      const text = buf.toString('utf-8', 0, bytesRead);
      const lines = text.split('\n').slice(0, 20);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'response_item' && parsed.payload?.role === 'user') {
            const content = parsed.payload.content;
            if (typeof content === 'string' && content.trim() && !isSystemInjection(content)) return truncate(content, 60);
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part.text?.trim() && !isSystemInjection(part.text)) return truncate(part.text, 60);
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return null;
  }

  searchInSession(sessionPath: string, query: string, maxResults: number): SearchHit[] {
    const results: SearchHit[] = [];
    const queryLower = query.toLowerCase();
    try {
      const content = fs.readFileSync(sessionPath, 'utf8');
      const lines = content.split('\n');
      const cwd = readSessionMeta(sessionPath)?.cwd || sessionPath;
      for (const line of lines) {
        if (results.length >= maxResults) break;
        if (!line.trim() || !line.toLowerCase().includes(queryLower)) continue;
        try {
          const parsed = JSON.parse(line);
          const text = extractSearchableText(parsed);
          if (!text) continue;
          const textLower = text.toLowerCase();
          const matchIdx = textLower.indexOf(queryLower);
          if (matchIdx < 0) continue;
          const start = Math.max(0, matchIdx - 40);
          const end = Math.min(text.length, matchIdx + query.length + 40);
          const snippet = (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
          results.push({
            sessionPath, line: snippet.replace(/\n/g, ' '),
            eventType: parsed.type, timestamp: parsed.timestamp || '', projectPath: cwd,
          });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return results;
  }

  dispose(): void { this.db?.close(); this.db = null; this.dbInitialized = false; }
}

function extractSearchableText(line: Record<string, unknown>): string {
  if (line.type === 'response_item') {
    const p = line.payload as Record<string, unknown>;
    if (p?.type === 'message') {
      const content = p.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((c: { text?: string }) => c.text || '').filter(Boolean).join(' ');
    }
    if (p?.type === 'function_call' && p.arguments) return p.arguments as string;
    if (p?.type === 'function_call_output' && p.output) return p.output as string;
  }
  if (line.type === 'event_msg') {
    const p = line.payload as Record<string, unknown>;
    if (p?.message) return p.message as string;
    if (p?.result) return p.result as string;
  }
  return '';
}
