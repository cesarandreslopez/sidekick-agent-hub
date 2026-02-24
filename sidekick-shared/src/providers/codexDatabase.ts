/**
 * Read-only SQLite wrapper for Codex CLI's state database.
 * Ported from sidekick-vscode/src/services/providers/CodexDatabase.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface CodexDbThread {
  id: string;
  rollout_path: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  title?: string;
  tokens_used?: number;
  first_user_message?: string;
}

export class CodexDatabase {
  private readonly dbPath: string;
  private sqlite3Available: boolean | null = null;

  constructor(codexHome: string) {
    this.dbPath = path.join(codexHome, 'state.sqlite');
  }

  isAvailable(): boolean {
    try {
      if (!fs.existsSync(this.dbPath)) return false;
      return fs.statSync(this.dbPath).size > 0;
    } catch { return false; }
  }

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
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
      });
      const trimmed = result.trim();
      if (!trimmed) return [];
      return JSON.parse(trimmed) as T[];
    } catch { return []; }
  }

  private queryOne<T>(sql: string, params: (string | number)[] = []): T | null {
    return this.query<T>(sql, params)[0] ?? null;
  }

  getThreadsByCwd(cwd: string): CodexDbThread[] {
    const normalized = normalizePath(cwd);
    const exact = this.query<CodexDbThread>('SELECT * FROM threads WHERE cwd = ? ORDER BY updated_at DESC', [normalized]);
    if (exact.length > 0) return exact;
    const all = this.query<CodexDbThread>('SELECT * FROM threads ORDER BY updated_at DESC');
    return all.filter(t => {
      const threadCwd = normalizePath(t.cwd);
      return threadCwd === normalized ||
        normalized.startsWith(threadCwd + path.sep) ||
        threadCwd.startsWith(normalized + path.sep);
    });
  }

  getMostRecentThread(cwd: string): CodexDbThread | null {
    return this.getThreadsByCwd(cwd)[0] ?? null;
  }

  getAllDistinctCwds(): Array<{ cwd: string; count: number; lastUpdated: number }> {
    return this.query<{ cwd: string; count: number; lastUpdated: number }>(
      'SELECT cwd, COUNT(*) as count, MAX(updated_at) as lastUpdated FROM threads GROUP BY cwd ORDER BY lastUpdated DESC'
    );
  }

  getThread(id: string): CodexDbThread | null {
    return this.queryOne<CodexDbThread>('SELECT * FROM threads WHERE id = ?', [id]);
  }

  /** Get the database file's mtime (ms epoch). Returns 0 if unavailable. */
  getDbMtime(): number {
    try {
      return fs.statSync(this.dbPath).mtime.getTime();
    } catch {
      return 0;
    }
  }
}

function normalizePath(input: string): string {
  try { return fs.realpathSync(input); }
  catch { return path.resolve(input); }
}
