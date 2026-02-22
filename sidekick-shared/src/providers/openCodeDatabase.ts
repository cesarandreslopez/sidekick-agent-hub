/**
 * Read-only SQLite wrapper for OpenCode's database.
 * Ported from sidekick-vscode/src/services/providers/OpenCodeDatabase.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface DbProject { id: string; worktree: string; name: string | null; time_created: number; time_updated: number; }
export interface DbSession { id: string; project_id: string; title: string; directory: string; time_created: number; time_updated: number; }
export interface DbMessage { id: string; session_id: string; time_created: number; time_updated: number; data: string; }
export interface DbPart { id: string; message_id: string; session_id: string; time_created: number; time_updated: number; data: string; }

export class OpenCodeDatabase {
  private readonly dbPath: string;
  private sqlite3Available: boolean | null = null;

  constructor(dataDir: string) {
    this.dbPath = path.join(dataDir, 'opencode.db');
  }

  isAvailable(): boolean { return fs.existsSync(this.dbPath); }

  open(): boolean {
    if (this.sqlite3Available !== null) return this.sqlite3Available;
    try {
      execFileSync('sqlite3', ['--version'], { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
      this.sqlite3Available = true;
      return true;
    } catch {
      this.sqlite3Available = false;
      return false;
    }
  }

  close(): void {}

  private query<T>(sql: string, params: (string | number)[] = []): T[] {
    if (!this.sqlite3Available) return [];
    let query = sql;
    for (const param of params) {
      if (typeof param === 'number') query = query.replace('?', String(param));
      else {
        const escaped = String(param).replace(/'/g, "''");
        query = query.replace('?', `'${escaped}'`);
      }
    }
    try {
      const result = execFileSync('sqlite3', ['-json', '-readonly', this.dbPath, query], {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024,
      });
      const trimmed = result.trim();
      if (!trimmed) return [];
      return JSON.parse(trimmed) as T[];
    } catch { return []; }
  }

  private queryOne<T>(sql: string, params: (string | number)[] = []): T | null {
    const results = this.query<T>(sql, params);
    return results[0] ?? null;
  }

  findProjectByWorktree(workspacePath: string): DbProject | null {
    const normalized = normalizePath(workspacePath);
    const exact = this.queryOne<DbProject>('SELECT id, worktree, name, time_created, time_updated FROM project WHERE worktree = ?', [normalized]);
    if (exact) return exact;
    const all = this.query<DbProject>('SELECT id, worktree, name, time_created, time_updated FROM project');
    const matches: Array<DbProject & { pathLen: number }> = [];
    for (const proj of all) {
      const projPath = normalizePath(proj.worktree);
      if (projPath === normalized) return proj;
      if (normalized.startsWith(projPath + path.sep) || projPath.startsWith(normalized + path.sep)) {
        matches.push({ ...proj, pathLen: projPath.length });
      }
    }
    if (matches.length > 0) { matches.sort((a, b) => b.pathLen - a.pathLen); return matches[0]; }
    return null;
  }

  getAllProjects(): DbProject[] {
    return this.query<DbProject>('SELECT id, worktree, name, time_created, time_updated FROM project');
  }

  getSessionsForProject(projectId: string): DbSession[] {
    return this.query<DbSession>(
      'SELECT id, project_id, title, directory, time_created, time_updated FROM session WHERE project_id = ? AND parent_id IS NULL ORDER BY time_updated DESC', [projectId]
    );
  }

  getSession(sessionId: string): DbSession | null {
    return this.queryOne<DbSession>('SELECT id, project_id, title, directory, time_created, time_updated FROM session WHERE id = ?', [sessionId]);
  }

  getMessagesForSession(sessionId: string): DbMessage[] {
    return this.query<DbMessage>(
      'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created ASC', [sessionId]
    );
  }

  getPartsForSession(sessionId: string): DbPart[] {
    return this.query<DbPart>(
      'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created ASC', [sessionId]
    );
  }

  getProjectSessionStats(): Array<{ projectId: string; sessionCount: number; maxTimeUpdated: number }> {
    return this.query<{ projectId: string; sessionCount: number; maxTimeUpdated: number }>(
      'SELECT project_id AS projectId, COUNT(*) AS sessionCount, MAX(time_updated) AS maxTimeUpdated FROM session GROUP BY project_id'
    );
  }
}

function normalizePath(input: string): string {
  try { return fs.realpathSync(input); }
  catch { return path.resolve(input); }
}
