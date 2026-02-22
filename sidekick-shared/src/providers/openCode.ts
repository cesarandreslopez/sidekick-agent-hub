/**
 * OpenCode session provider for the shared package.
 * Ported from sidekick-vscode/src/services/providers/OpenCodeSessionProvider.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { OpenCodeDatabase } from './openCodeDatabase';
import type { SessionProvider, SessionFileStats, SearchHit, ProjectFolderInfo, ProviderId } from './types';

function getOpenCodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

function getStorageDir(): string { return path.join(getOpenCodeDataDir(), 'storage'); }

const DB_SESSION_PREFIX = 'db-sessions';

function resolveProjectId(workspacePath: string, db: OpenCodeDatabase | null): string | null {
  if (db) {
    const proj = db.findProjectByWorktree(workspacePath);
    if (proj) return proj.id;
  }
  // File-based fallback
  try {
    const projectDir = path.join(getStorageDir(), 'project');
    if (!fs.existsSync(projectDir)) return resolveProjectIdFromGit(workspacePath);
    const normalizedWs = normalizePath(workspacePath);
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const proj = JSON.parse(fs.readFileSync(path.join(projectDir, file), 'utf-8'));
        if (proj.path && normalizePath(proj.path) === normalizedWs) return proj.id;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return resolveProjectIdFromGit(workspacePath);
}

function resolveProjectIdFromGit(workspacePath: string): string | null {
  try {
    const hash = execSync('git rev-list --max-parents=0 HEAD', {
      cwd: workspacePath, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim().split('\n')[0];
    if (hash && /^[a-f0-9]+$/i.test(hash)) return hash;
  } catch { /* skip */ }
  return null;
}

function normalizePath(input: string): string {
  try { return fs.realpathSync(input); }
  catch { return path.resolve(input); }
}

export class OpenCodeProvider implements SessionProvider {
  readonly id: ProviderId = 'opencode';
  readonly displayName = 'OpenCode';
  private db: OpenCodeDatabase | null = null;
  private dbInitialized = false;

  private ensureDb(): OpenCodeDatabase | null {
    if (this.dbInitialized) return this.db;
    this.dbInitialized = true;
    const dataDir = getOpenCodeDataDir();
    const db = new OpenCodeDatabase(dataDir);
    if (db.isAvailable() && db.open()) this.db = db;
    return this.db;
  }

  findSessionFiles(workspacePath: string): string[] { return this.findAllSessions(workspacePath); }

  findAllSessions(workspacePath: string): string[] {
    const db = this.ensureDb();
    const projectId = resolveProjectId(workspacePath, db);
    if (!projectId) return [];
    if (db) {
      const sessions = db.getSessionsForProject(projectId);
      if (sessions.length > 0) {
        const dataDir = getOpenCodeDataDir();
        return sessions.map(s => path.join(dataDir, DB_SESSION_PREFIX, projectId, `${s.id}.json`));
      }
    }
    // File fallback
    const sessionDir = path.join(getStorageDir(), 'session', projectId);
    try {
      if (!fs.existsSync(sessionDir)) return [];
      return fs.readdirSync(sessionDir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(sessionDir, f))
        .sort((a, b) => {
          try { return fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime(); } catch { return 0; }
        });
    } catch { return []; }
  }

  getProjectsBaseDir(): string { return path.join(getStorageDir(), 'session'); }

  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
    const db = this.ensureDb();
    const folders: ProjectFolderInfo[] = [];
    if (db) {
      const projects = db.getAllProjects();
      const stats = db.getProjectSessionStats();
      const statsMap = new Map(stats.map(s => [s.projectId, s]));
      let currentProjectId: string | null = null;
      if (workspacePath) currentProjectId = resolveProjectId(workspacePath, db);
      const dataDir = getOpenCodeDataDir();
      for (const project of projects) {
        const projStats = statsMap.get(project.id);
        if (!projStats || projStats.sessionCount === 0) continue;
        folders.push({
          dir: path.join(dataDir, DB_SESSION_PREFIX, project.id),
          name: project.worktree || project.name || project.id,
          encodedName: project.id,
          sessionCount: projStats.sessionCount,
          lastModified: new Date(projStats.maxTimeUpdated),
        });
      }
      folders.sort((a, b) => {
        if (currentProjectId) {
          if (a.encodedName === currentProjectId) return -1;
          if (b.encodedName === currentProjectId) return 1;
        }
        return b.lastModified.getTime() - a.lastModified.getTime();
      });
      if (folders.length > 0) return folders;
    }
    return folders;
  }

  readSessionStats(sessionPath: string): SessionFileStats {
    const sessionId = path.basename(sessionPath, '.json');
    const db = this.ensureDb();
    let messageCount = 0;
    let startTime = '';
    let endTime = '';
    const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const modelUsage: Record<string, { calls: number; tokens: number }> = {};
    const toolUsage: Record<string, number> = {};
    let reportedCost = 0;

    if (db) {
      const messages = db.getMessagesForSession(sessionId);
      const parts = db.getPartsForSession(sessionId);
      for (const msg of messages) {
        try {
          const data = JSON.parse(msg.data) as Record<string, unknown>;
          const role = data.role as string;
          if (role === 'assistant' || role === 'user') messageCount++;
          const msgTokens = data.tokens as Record<string, unknown> | undefined;
          const cache = msgTokens?.cache as Record<string, unknown> | undefined;
          if (msgTokens) {
            tokens.input += (msgTokens.input as number) || 0;
            tokens.output += (msgTokens.output as number) || 0;
            tokens.cacheRead += (cache?.read as number) || 0;
            tokens.cacheWrite += (cache?.write as number) || 0;
          }
          if (data.cost) reportedCost += (data.cost as number) || 0;
          const modelId = (data.modelID as string) || 'unknown';
          if (role === 'assistant' && msgTokens) {
            if (!modelUsage[modelId]) modelUsage[modelId] = { calls: 0, tokens: 0 };
            modelUsage[modelId].calls++;
            modelUsage[modelId].tokens += ((msgTokens.input as number) || 0) + ((msgTokens.output as number) || 0);
          }
        } catch { /* skip */ }
        if (!startTime) startTime = new Date(msg.time_created).toISOString();
        endTime = new Date(msg.time_updated || msg.time_created).toISOString();
      }
      for (const part of parts) {
        try {
          const data = JSON.parse(part.data) as Record<string, unknown>;
          if (data.type === 'tool' || data.type === 'tool-invocation') {
            const toolName = (data.tool as string) || 'unknown';
            toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
          }
        } catch { /* skip */ }
      }
    }

    return {
      providerId: 'opencode',
      sessionId,
      filePath: sessionPath,
      label: this.extractSessionLabel(sessionPath),
      startTime,
      endTime,
      messageCount,
      tokens,
      modelUsage,
      toolUsage,
      compactionEstimate: 0,
      truncationCount: 0,
      reportedCost,
    };
  }

  extractSessionLabel(sessionPath: string): string | null {
    const db = this.ensureDb();
    const sessionId = path.basename(sessionPath, '.json');
    if (db) {
      const session = db.getSession(sessionId);
      if (session?.title) {
        const t = session.title.trim();
        return t.length > 60 ? t.substring(0, 57) + '...' : t;
      }
    }
    return null;
  }

  searchInSession(sessionPath: string, query: string, maxResults: number): SearchHit[] {
    const db = this.ensureDb();
    const sessionId = path.basename(sessionPath, '.json');
    const queryLower = query.toLowerCase();
    const results: SearchHit[] = [];
    if (db) {
      const parts = db.getPartsForSession(sessionId);
      for (const partRow of parts) {
        if (results.length >= maxResults) break;
        const dataStr = partRow.data;
        const matchIdx = dataStr.toLowerCase().indexOf(queryLower);
        if (matchIdx < 0) continue;
        const start = Math.max(0, matchIdx - 40);
        const end = Math.min(dataStr.length, matchIdx + query.length + 40);
        const snippet = (start > 0 ? '...' : '') + dataStr.substring(start, end) + (end < dataStr.length ? '...' : '');
        results.push({
          sessionPath,
          line: snippet.replace(/\n/g, ' '),
          eventType: 'unknown',
          timestamp: String(partRow.time_created),
          projectPath: sessionId,
        });
      }
    }
    return results;
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
    this.dbInitialized = false;
  }
}
