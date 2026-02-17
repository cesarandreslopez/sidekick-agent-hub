/**
 * @fileoverview Read-only SQLite wrapper for Codex CLI's state database.
 *
 * Codex stores session metadata in ~/.codex/state.sqlite (optional).
 * This module provides typed, read-only access to thread data.
 *
 * Uses the `sqlite3` CLI tool for queries (same approach as OpenCodeDatabase).
 *
 * @module services/providers/CodexDatabase
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { CodexDbThread } from '../../types/codex';
import { log } from '../Logger';

/**
 * Read-only SQLite wrapper for the Codex state database.
 */
export class CodexDatabase {
  private readonly dbPath: string;
  private sqlite3Available: boolean | null = null;

  constructor(codexHome: string) {
    this.dbPath = path.join(codexHome, 'state.sqlite');
  }

  /** Whether the database file exists and is non-empty. */
  isAvailable(): boolean {
    try {
      if (!fs.existsSync(this.dbPath)) return false;
      const stats = fs.statSync(this.dbPath);
      return stats.size > 0;
    } catch {
      return false;
    }
  }

  /** Verify sqlite3 CLI is available. */
  open(): boolean {
    if (this.sqlite3Available !== null) return this.sqlite3Available;

    try {
      execFileSync('sqlite3', ['--version'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.sqlite3Available = true;
      log(`Codex database ready (sqlite3 CLI): ${this.dbPath}`);
      return true;
    } catch (error) {
      log(`sqlite3 CLI not available for Codex: ${error}`);
      this.sqlite3Available = false;
      return false;
    }
  }

  /** No-op for CLI-based access. */
  close(): void {
    // Each query spawns a fresh sqlite3 process
  }

  // --- Query helpers ---

  private query<T>(sql: string, params: (string | number)[] = []): T[] {
    if (!this.sqlite3Available) return [];

    let query = sql;
    for (const param of params) {
      if (typeof param === 'number') {
        query = query.replace('?', String(param));
      } else {
        const escaped = String(param).replace(/'/g, "''");
        query = query.replace('?', `'${escaped}'`);
      }
    }

    try {
      const result = execFileSync('sqlite3', ['-json', '-readonly', this.dbPath, query], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });

      const trimmed = result.trim();
      if (!trimmed) return [];
      return JSON.parse(trimmed) as T[];
    } catch (error) {
      const msg = String(error);
      if (!msg.includes('not an error')) {
        log(`CodexDatabase query error: ${msg.substring(0, 200)}`);
      }
      return [];
    }
  }

  private queryOne<T>(sql: string, params: (string | number)[] = []): T | null {
    const results = this.query<T>(sql, params);
    return results[0] ?? null;
  }

  // --- Thread queries ---

  /**
   * Find threads matching a workspace path (CWD).
   * Tries exact match first, then parent/child matching.
   */
  getThreadsByCwd(cwd: string): CodexDbThread[] {
    const normalized = normalizePath(cwd);

    // Exact match
    const exact = this.query<CodexDbThread>(
      'SELECT * FROM threads WHERE cwd = ? ORDER BY updated_at DESC',
      [normalized]
    );
    if (exact.length > 0) return exact;

    // Fuzzy: fetch all and do parent/child matching
    const all = this.query<CodexDbThread>('SELECT * FROM threads ORDER BY updated_at DESC');
    return all.filter(t => {
      const threadCwd = normalizePath(t.cwd);
      return threadCwd === normalized ||
        normalized.startsWith(threadCwd + path.sep) ||
        threadCwd.startsWith(normalized + path.sep);
    });
  }

  /** Get the most recently updated thread for a workspace. */
  getMostRecentThread(cwd: string): CodexDbThread | null {
    const threads = this.getThreadsByCwd(cwd);
    return threads[0] ?? null;
  }

  /** Get all distinct CWDs with session counts. */
  getAllDistinctCwds(): Array<{ cwd: string; count: number; lastUpdated: number }> {
    return this.query<{ cwd: string; count: number; lastUpdated: number }>(
      'SELECT cwd, COUNT(*) as count, MAX(updated_at) as lastUpdated FROM threads GROUP BY cwd ORDER BY lastUpdated DESC'
    );
  }

  /** Get a single thread by ID. */
  getThread(id: string): CodexDbThread | null {
    return this.queryOne<CodexDbThread>(
      'SELECT * FROM threads WHERE id = ?',
      [id]
    );
  }

  /** Get the database file's mtime (ms epoch). */
  getDbMtime(): number {
    try {
      return fs.statSync(this.dbPath).mtime.getTime();
    } catch {
      return 0;
    }
  }
}

/** Normalize a path using realpathSync, falling back to path.resolve. */
function normalizePath(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}
