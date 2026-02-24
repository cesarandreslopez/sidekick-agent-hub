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

  /** Get the most recently updated session for a project (excludes subagent child sessions). */
  getMostRecentSession(projectId: string): DbSession | null {
    return this.queryOne<DbSession>(
      'SELECT id, project_id, title, directory, time_created, time_updated FROM session WHERE project_id = ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 1',
      [projectId]
    );
  }

  /** Get child sessions (subagents) whose parent_id matches the given session ID. */
  getChildSessions(parentSessionId: string): DbSession[] {
    return this.query<DbSession>(
      'SELECT id, project_id, title, directory, time_created, time_updated FROM session WHERE parent_id = ? ORDER BY time_created ASC',
      [parentSessionId]
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

  /** Get specific messages for a session by message IDs. */
  getMessagesByIds(sessionId: string, messageIds: string[]): DbMessage[] {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(', ');
    return this.query<DbMessage>(
      `SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? AND id IN (${placeholders}) ORDER BY time_created ASC`,
      [sessionId, ...messageIds]
    );
  }

  /** Get messages newer than a given time_updated timestamp (ms epoch). */
  getMessagesNewerThan(sessionId: string, afterTimeUpdated: number): DbMessage[] {
    return this.query<DbMessage>(
      'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? AND time_updated > ? ORDER BY time_created ASC',
      [sessionId, afterTimeUpdated]
    );
  }

  /** Get the latest message time_updated for a session. */
  getLatestMessageTimeUpdated(sessionId: string): number {
    const row = this.queryOne<{ maxTimeUpdated: number }>(
      'SELECT COALESCE(MAX(time_updated), 0) AS maxTimeUpdated FROM message WHERE session_id = ?',
      [sessionId]
    );
    return row?.maxTimeUpdated ?? 0;
  }

  /** Get user message IDs that already have an assistant child message. */
  getProcessedUserMessageIds(sessionId: string, userMessageIds: string[]): string[] {
    if (userMessageIds.length === 0) return [];
    const placeholders = userMessageIds.map(() => '?').join(', ');
    const rows = this.query<{ parentId: string }>(
      `SELECT DISTINCT json_extract(data, '$.parentID') AS parentId
       FROM message
       WHERE session_id = ?
         AND json_extract(data, '$.role') = 'assistant'
         AND json_extract(data, '$.parentID') IN (${placeholders})`,
      [sessionId, ...userMessageIds]
    );
    return rows
      .map(r => r.parentId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  /** Get the latest assistant token usage row with non-zero context signal. */
  getLatestAssistantContextUsage(sessionId: string): {
    timeCreated: number;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  } | null {
    return this.queryOne<{
      timeCreated: number;
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
    }>(
      `SELECT
         time_created AS timeCreated,
         COALESCE(json_extract(data, '$.modelID'), 'unknown') AS modelId,
         COALESCE(json_extract(data, '$.tokens.input'), 0) AS inputTokens,
         COALESCE(json_extract(data, '$.tokens.output'), 0) AS outputTokens,
         COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS cacheReadTokens,
         COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cacheWriteTokens,
         COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS reasoningTokens
       FROM message
       WHERE session_id = ?
         AND json_extract(data, '$.role') = 'assistant'
         AND (
           COALESCE(json_extract(data, '$.tokens.input'), 0) > 0
           OR COALESCE(json_extract(data, '$.tokens.output'), 0) > 0
           OR COALESCE(json_extract(data, '$.tokens.cache.read'), 0) > 0
           OR COALESCE(json_extract(data, '$.tokens.cache.write'), 0) > 0
           OR COALESCE(json_extract(data, '$.tokens.reasoning'), 0) > 0
         )
       ORDER BY time_created DESC
       LIMIT 1`,
      [sessionId]
    );
  }

  /** Get all parts for a message. */
  getPartsForMessage(messageId: string): DbPart[] {
    return this.query<DbPart>(
      'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE message_id = ? ORDER BY time_created ASC',
      [messageId]
    );
  }

  /** Get all parts for a set of messages in one query. */
  getPartsForMessages(sessionId: string, messageIds: string[]): DbPart[] {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(', ');
    return this.query<DbPart>(
      `SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? AND message_id IN (${placeholders}) ORDER BY time_created ASC`,
      [sessionId, ...messageIds]
    );
  }

  getPartsForSession(sessionId: string): DbPart[] {
    return this.query<DbPart>(
      'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created ASC', [sessionId]
    );
  }

  /** Get parts newer than a given time_updated timestamp (ms epoch). */
  getPartsNewerThan(sessionId: string, afterTimeUpdated: number): DbPart[] {
    return this.query<DbPart>(
      'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? AND time_updated > ? ORDER BY time_created ASC',
      [sessionId, afterTimeUpdated]
    );
  }

  /** Get the latest part time_updated for a session. */
  getLatestPartTimeUpdated(sessionId: string): number {
    const row = this.queryOne<{ maxTimeUpdated: number }>(
      'SELECT COALESCE(MAX(time_updated), 0) AS maxTimeUpdated FROM part WHERE session_id = ?',
      [sessionId]
    );
    return row?.maxTimeUpdated ?? 0;
  }

  getProjectSessionStats(): Array<{ projectId: string; sessionCount: number; maxTimeUpdated: number }> {
    return this.query<{ projectId: string; sessionCount: number; maxTimeUpdated: number }>(
      'SELECT project_id AS projectId, COUNT(*) AS sessionCount, MAX(time_updated) AS maxTimeUpdated FROM session GROUP BY project_id'
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

function normalizePath(input: string): string {
  try { return fs.realpathSync(input); }
  catch { return path.resolve(input); }
}
