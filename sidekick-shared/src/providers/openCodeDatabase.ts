/**
 * Read-only SQLite wrapper for OpenCode's database.
 * Ported from sidekick-vscode/src/services/providers/OpenCodeDatabase.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface DbProject { id: string; worktree: string; name: string | null; sandboxes: string[]; time_created: number; time_updated: number; }
export interface DbSession { id: string; project_id: string; title: string; directory: string; time_created: number; time_updated: number; }
export interface DbMessage { id: string; session_id: string; time_created: number; time_updated: number; data: string; }
export interface DbPart { id: string; message_id: string; session_id: string; time_created: number; time_updated: number; data: string; }
type DbProjectRow = Omit<DbProject, 'sandboxes'> & { sandboxes?: string | null };

export interface OpenCodeDbRuntimeStatus {
  available: boolean;
  kind: 'available' | 'db_missing' | 'sqlite_missing' | 'sqlite_blocked' | 'query_failed';
  message?: string;
}

export class OpenCodeDatabase {
  private readonly dbPath: string;
  private runtimeStatus: OpenCodeDbRuntimeStatus | null = null;

  constructor(dataDir: string) {
    this.dbPath = path.join(dataDir, 'opencode.db');
  }

  isAvailable(): boolean { return fs.existsSync(this.dbPath); }

  getRuntimeStatus(): OpenCodeDbRuntimeStatus {
    if (this.runtimeStatus) return this.runtimeStatus;
    if (!this.isAvailable()) {
      this.runtimeStatus = { available: false, kind: 'db_missing' };
      return this.runtimeStatus;
    }
    return { available: false, kind: 'query_failed', message: 'OpenCode database has not been initialized yet.' };
  }

  open(): boolean {
    if (this.runtimeStatus) return this.runtimeStatus.available;
    if (!this.isAvailable()) {
      this.runtimeStatus = { available: false, kind: 'db_missing' };
      return false;
    }
    try {
      execFileSync('sqlite3', ['--version'], { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
      this.runtimeStatus = { available: true, kind: 'available' };
      return true;
    } catch (error) {
      this.runtimeStatus = toRuntimeStatus(error);
      return false;
    }
  }

  close(): void {}

  private query<T>(sql: string, params: (string | number)[] = []): T[] {
    if (!this.open()) return [];
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
      this.runtimeStatus = { available: true, kind: 'available' };
      const trimmed = result.trim();
      if (!trimmed) return [];
      return JSON.parse(trimmed) as T[];
    } catch (error) {
      this.runtimeStatus = toRuntimeStatus(error, 'query_failed');
      return [];
    }
  }

  private queryOne<T>(sql: string, params: (string | number)[] = []): T | null {
    const results = this.query<T>(sql, params);
    return results[0] ?? null;
  }

  findProjectByWorktree(workspacePath: string): DbProject | null {
    const normalized = normalizePath(workspacePath);
    const all = this.getAllProjects();

    let best: DbProject | null = null;
    let bestScore = -1;

    for (const project of all) {
      const worktreeScore = pathMatchScore(project.worktree, normalized);
      if (worktreeScore > bestScore) {
        best = project;
        bestScore = worktreeScore;
      }
      for (const sandbox of project.sandboxes) {
        const sandboxScore = pathMatchScore(sandbox, normalized);
        if (sandboxScore > bestScore) {
          best = project;
          bestScore = sandboxScore;
        }
      }
    }

    return bestScore >= 0 ? best : null;
  }

  findProjectBySessionDirectory(workspacePath: string): DbProject | null {
    const normalized = normalizePath(workspacePath);
    const sessions = this.query<DbSession>(
      'SELECT id, project_id, title, directory, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC'
    );

    let bestProjectId: string | null = null;
    let bestScore = -1;
    for (const session of sessions) {
      const score = pathMatchScore(session.directory, normalized);
      if (score > bestScore) {
        bestProjectId = session.project_id;
        bestScore = score;
      }
    }

    if (!bestProjectId) return null;
    return this.getAllProjects().find(project => project.id === bestProjectId) ?? null;
  }

  getAllProjects(): DbProject[] {
    return this.query<DbProjectRow>('SELECT id, worktree, name, sandboxes, time_created, time_updated FROM project')
      .map(project => ({
        ...project,
        sandboxes: parseStringArray(project.sandboxes),
      }));
  }

  hasProject(projectId: string): boolean {
    return this.queryOne<{ id: string }>('SELECT id FROM project WHERE id = ? LIMIT 1', [projectId]) !== null;
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

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).map(normalizePath)
      : [];
  } catch {
    return [];
  }
}

function normalizeForCompare(input: string): string {
  const normalized = normalizePath(input);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathMatchScore(candidate: string, workspacePath: string): number {
  if (!candidate) return -1;
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedWorkspace = normalizeForCompare(workspacePath);

  if (normalizedCandidate === normalizedWorkspace) return 10_000 + normalizedCandidate.length;

  const candidatePrefix = normalizedCandidate.endsWith(path.sep)
    ? normalizedCandidate
    : normalizedCandidate + path.sep;
  const workspacePrefix = normalizedWorkspace.endsWith(path.sep)
    ? normalizedWorkspace
    : normalizedWorkspace + path.sep;

  if (normalizedWorkspace.startsWith(candidatePrefix)) return 5_000 + normalizedCandidate.length;
  if (normalizedCandidate.startsWith(workspacePrefix)) return 1_000 + normalizedCandidate.length;

  return -1;
}

function toRuntimeStatus(error: unknown, fallback: OpenCodeDbRuntimeStatus['kind'] = 'sqlite_missing'): OpenCodeDbRuntimeStatus {
  if (isErrno(error, 'ENOENT')) {
    return { available: false, kind: 'sqlite_missing', message: 'sqlite3 executable not found in PATH.' };
  }
  if (isErrno(error, 'EPERM') || isErrno(error, 'EACCES')) {
    return { available: false, kind: 'sqlite_blocked', message: 'sqlite3 exists but could not be executed.' };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { available: false, kind: fallback, message };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}
