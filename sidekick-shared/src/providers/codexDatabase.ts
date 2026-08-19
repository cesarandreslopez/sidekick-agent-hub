/**
 * Read-only SQLite wrapper for Codex CLI's state database.
 * Ported from sidekick-vscode/src/services/providers/CodexDatabase.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import type { CodexDbThread } from '../types/codex';
import type { ProviderRuntimeStatus } from './types';

export class CodexDatabase {
  private readonly dbPath: string;
  private sqlite3Available: boolean | null = null;
  private runtimeStatus: ProviderRuntimeStatus | null = null;

  constructor(codexHome: string) {
    this.dbPath = findLatestStateDatabase(codexHome) ?? path.join(codexHome, 'state.sqlite');
  }

  isAvailable(): boolean {
    try {
      return fs.statSync(this.dbPath).size > 0;
    } catch {
      return false;
    }
  }

  open(): boolean {
    if (this.sqlite3Available !== null) return this.sqlite3Available;
    if (!this.isAvailable()) {
      this.sqlite3Available = false;
      this.runtimeStatus = { available: false, kind: 'db_missing' };
      return false;
    }
    try {
      execFileSync('sqlite3', ['--version'], {
        encoding: 'utf-8',
        timeout: 4000,
        killSignal: 'SIGKILL',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.sqlite3Available = true;
      this.runtimeStatus = { available: true, kind: 'available' };
      return true;
    } catch (error) {
      this.sqlite3Available = false;
      this.runtimeStatus = classifySqliteError(error);
      return false;
    }
  }

  getRuntimeStatus(): ProviderRuntimeStatus {
    if (this.runtimeStatus) return this.runtimeStatus;
    if (!this.isAvailable()) return { available: false, kind: 'db_missing' };
    return {
      available: false,
      kind: 'query_failed',
      message: 'Codex database has not been initialized yet.',
    };
  }

  close(): void {}

  private query<T>(sql: string, params: (string | number)[] = []): T[] {
    if (!this.sqlite3Available) return [];
    let paramIndex = 0;
    const query = sql.replace(/\?/g, () => {
      if (paramIndex >= params.length) return '?';
      const param = params[paramIndex++];
      if (typeof param === 'number') {
        if (!Number.isFinite(param)) return '0';
        return String(param);
      }
      const escaped = String(param).replace(/'/g, "''");
      return `'${escaped}'`;
    });
    try {
      const result = execFileSync('sqlite3', ['-json', '-readonly', this.dbPath, query], {
        encoding: 'utf-8',
        timeout: 4000,
        killSignal: 'SIGKILL',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
      const trimmed = result.trim();
      if (!trimmed) return [];
      return JSON.parse(trimmed) as T[];
    } catch (error) {
      this.runtimeStatus = {
        ...classifySqliteError(error, 'query_failed'),
        available: this.sqlite3Available === true,
      };
      return [];
    }
  }

  private async queryAsync<T>(sql: string, params: (string | number)[] = []): Promise<T[]> {
    if (!this.isAvailable()) {
      this.runtimeStatus = { available: false, kind: 'db_missing' };
      return [];
    }
    const query = bindSqlParams(sql, params);
    try {
      const result = await execSqlite(this.dbPath, query, 10 * 1024 * 1024);
      this.sqlite3Available = true;
      this.runtimeStatus = { available: true, kind: 'available' };
      const trimmed = result.trim();
      return trimmed ? (JSON.parse(trimmed) as T[]) : [];
    } catch (error) {
      this.sqlite3Available = false;
      this.runtimeStatus = classifySqliteError(error, 'query_failed');
      return [];
    }
  }

  private queryOne<T>(sql: string, params: (string | number)[] = []): T | null {
    return this.query<T>(sql, params)[0] ?? null;
  }

  getThreadsByCwd(cwd: string): CodexDbThread[] {
    const normalized = normalizePath(cwd);
    const exact = this.query<CodexDbThread>(
      'SELECT * FROM threads WHERE cwd = ? ORDER BY updated_at DESC',
      [normalized],
    );
    if (exact.length > 0) return exact;
    const all = this.query<CodexDbThread>('SELECT * FROM threads ORDER BY updated_at DESC');
    return all.filter((t) => {
      const threadCwd = normalizePath(t.cwd);
      return (
        threadCwd === normalized ||
        normalized.startsWith(threadCwd + path.sep) ||
        threadCwd.startsWith(normalized + path.sep)
      );
    });
  }

  getMostRecentThread(cwd: string): CodexDbThread | null {
    return this.getThreadsByCwd(cwd)[0] ?? null;
  }

  getAllDistinctCwds(): Array<{ cwd: string; count: number; lastUpdated: number }> {
    return this.query<{ cwd: string; count: number; lastUpdated: number }>(
      'SELECT cwd, COUNT(*) as count, MAX(updated_at) as lastUpdated FROM threads GROUP BY cwd ORDER BY lastUpdated DESC',
    );
  }

  getThread(id: string): CodexDbThread | null {
    return this.queryOne<CodexDbThread>('SELECT * FROM threads WHERE id = ?', [id]);
  }

  /** Resolve many thread ids with one non-blocking sqlite3 subprocess. */
  getThreadsByIdsAsync(ids: readonly string[]): Promise<CodexDbThread[]> {
    if (ids.length === 0) return Promise.resolve([]);
    const placeholders = ids.map(() => '?').join(', ');
    return this.queryAsync<CodexDbThread>(`SELECT * FROM threads WHERE id IN (${placeholders})`, [
      ...ids,
    ]);
  }

  /** Get all threads forked from a given session ID. */
  getThreadsByForkedFromId(parentId: string): CodexDbThread[] {
    return this.query<CodexDbThread>(
      'SELECT * FROM threads WHERE forked_from_id = ? ORDER BY created_at ASC',
      [parentId],
    );
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

function classifySqliteError(
  error: unknown,
  fallback: ProviderRuntimeStatus['kind'] = 'sqlite_blocked',
): ProviderRuntimeStatus {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return {
      available: false,
      kind: 'sqlite_missing',
      message: 'The sqlite3 executable was not found.',
    };
  }
  return {
    available: false,
    kind: fallback,
    message: error instanceof Error ? error.message : 'sqlite3 could not be executed.',
  };
}

function bindSqlParams(sql: string, params: readonly (string | number)[]): string {
  let paramIndex = 0;
  return sql.replace(/\?/g, () => {
    if (paramIndex >= params.length) return '?';
    const param = params[paramIndex++];
    if (typeof param === 'number') return Number.isFinite(param) ? String(param) : '0';
    return `'${String(param).replace(/'/g, "''")}'`;
  });
}

function execSqlite(dbPath: string, query: string, maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'sqlite3',
      ['-json', '-readonly', dbPath, query],
      {
        encoding: 'utf8',
        timeout: 4_000,
        killSignal: 'SIGKILL',
        maxBuffer,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function findLatestStateDatabase(codexHome: string): string | null {
  try {
    const entries = fs.readdirSync(codexHome, { withFileTypes: true });
    const candidates: Array<{ path: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^state(?:_\d+)?\.sqlite$/.test(entry.name)) continue;
      const dbPath = path.join(codexHome, entry.name);
      try {
        const stat = fs.statSync(dbPath);
        if (stat.size > 0) {
          candidates.push({ path: dbPath, mtime: stat.mtime.getTime() });
        }
      } catch {
        // Skip inaccessible candidates.
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

function normalizePath(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}
