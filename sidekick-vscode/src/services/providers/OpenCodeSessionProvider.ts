/**
 * @fileoverview OpenCode session provider.
 *
 * Implements SessionProvider for monitoring OpenCode CLI sessions.
 * Uses SQLite database as primary data source (opencode.db), with
 * file-based scanning as fallback for older OpenCode installations.
 *
 * OpenCode file storage layout (legacy):
 * - Base: $XDG_DATA_HOME/opencode/ or ~/.local/share/opencode/
 * - Sessions: storage/session/{projectID}/{sessionID}.json
 * - Messages: storage/message/{sessionID}/{messageID}.json
 * - Parts: storage/part/{messageID}/{partID}.json
 *
 * @module services/providers/OpenCodeSessionProvider
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { log } from '../Logger';
import { convertOpenCodeMessage, parseDbMessageData, parseDbPartData } from './OpenCodeMessageParser';
import { OpenCodeDatabase } from './OpenCodeDatabase';
import type { SessionProvider, SessionReader, ProjectFolderInfo, SearchHit } from '../../types/sessionProvider';
import type { ClaudeSessionEvent, ContextAttribution, SubagentStats, TokenUsage } from '../../types/claudeSession';
import type { OpenCodeSession, OpenCodeMessage, OpenCodePart, OpenCodeProject } from '../../types/opencode';

/**
 * Gets the OpenCode data directory.
 * Respects XDG_DATA_HOME if set, otherwise uses ~/.local/share/opencode/
 */
function getOpenCodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) {
    return path.join(xdg, 'opencode');
  }
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

/**
 * Gets the storage base directory within OpenCode's data dir.
 */
function getStorageDir(): string {
  return path.join(getOpenCodeDataDir(), 'storage');
}

/** Prefix for synthetic DB session paths */
const DB_SESSION_PREFIX = 'db-sessions';

/** Build a synthetic session path for a DB-backed session. */
function makeDbSessionPath(dataDir: string, projectId: string, sessionId: string): string {
  return path.join(dataDir, DB_SESSION_PREFIX, projectId, `${sessionId}.json`);
}

/** Check if a path is a synthetic DB session path. */
function isDbSessionPath(sessionPath: string): boolean {
  return sessionPath.includes(path.sep + DB_SESSION_PREFIX + path.sep);
}

/** Extract project ID from a synthetic DB session path. */
function extractProjectIdFromDbPath(sessionPath: string): string | null {
  const prefix = path.sep + DB_SESSION_PREFIX + path.sep;
  const idx = sessionPath.indexOf(prefix);
  if (idx < 0) return null;
  const rest = sessionPath.substring(idx + prefix.length);
  const slashIdx = rest.indexOf(path.sep);
  return slashIdx > 0 ? rest.substring(0, slashIdx) : null;
}

/** Extract role from a DB message row payload. */
function extractRoleFromDbMessage(row: { data: string }): 'user' | 'assistant' | 'system' | 'unknown' {
  try {
    const data = JSON.parse(row.data) as { role?: unknown };
    if (data.role === 'user' || data.role === 'assistant' || data.role === 'system') {
      return data.role;
    }
  } catch {
    // Ignore malformed payloads
  }
  return 'unknown';
}

/** Extract parent message ID from a DB message row payload. */
function extractParentIdFromDbMessage(row: { data: string }): string | null {
  try {
    const data = JSON.parse(row.data) as { parentID?: unknown };
    return typeof data.parentID === 'string' && data.parentID.length > 0
      ? data.parentID
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the OpenCode project ID for a workspace path.
 *
 * Tries DB first, then file-based project metadata, then git root commit hash.
 */
function resolveProjectId(workspacePath: string, db: OpenCodeDatabase | null): string | null {
  // Strategy 1: DB lookup
  if (db) {
    const dbProject = db.findProjectByWorktree(workspacePath);
    if (dbProject) return dbProject.id;
  }

  // Strategy 2: scan project files to find matching path
  return resolveProjectIdFromFiles(workspacePath);
}

function resolveProjectIdFromFiles(workspacePath: string): string | null {
  const normalizePath = (input: string): string => {
    try {
      return fs.realpathSync(input);
    } catch {
      return path.resolve(input);
    }
  };

  const workspaceResolved = normalizePath(workspacePath);

  try {
    const projectDir = path.join(getStorageDir(), 'project');
    if (!fs.existsSync(projectDir)) return resolveProjectIdFromGit(workspacePath);

    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.json'));
    const matches: Array<{ id: string; path: string }> = [];
    for (const file of files) {
      try {
        const project: OpenCodeProject = JSON.parse(
          fs.readFileSync(path.join(projectDir, file), 'utf-8')
        );
        if (project.path) {
          const projectPath = normalizePath(project.path);
          if (projectPath === workspaceResolved) {
            matches.push({ id: project.id, path: projectPath });
            continue;
          }
          if (workspaceResolved.startsWith(projectPath + path.sep)) {
            matches.push({ id: project.id, path: projectPath });
            continue;
          }
          if (projectPath.startsWith(workspaceResolved + path.sep)) {
            matches.push({ id: project.id, path: projectPath });
          }
        }
      } catch {
        // Skip malformed project files
      }
    }

    if (matches.length > 0) {
      matches.sort((a, b) => b.path.length - a.path.length);
      return matches[0].id;
    }
  } catch {
    // Can't read project directory
  }

  return resolveProjectIdFromGit(workspacePath);
}

function resolveProjectIdFromGit(workspacePath: string): string | null {
  try {
    const hash = execSync('git rev-list --max-parents=0 HEAD', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim().split('\n')[0];

    if (hash && /^[a-f0-9]+$/i.test(hash)) {
      return hash;
    }
  } catch {
    // Git not available or not a git repo
  }

  return null;
}

/**
 * Safely reads and parses a JSON file, returning null on failure.
 */
function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

// --- File-based reader (legacy fallback) ---

/**
 * Incremental reader for file-based OpenCode sessions.
 *
 * Tracks which message IDs have been seen and reads new messages
 * plus their parts on each readNew() call.
 */
class OpenCodeFileReader implements SessionReader {
  private seenMessages = new Map<string, { partIds: Set<string>; mtimeMs: number }>();
  private readonly storageBase: string;

  constructor(
    private readonly sessionId: string
  ) {
    this.storageBase = getStorageDir();
  }

  readNew(): ClaudeSessionEvent[] {
    const messageDir = path.join(this.storageBase, 'message', this.sessionId);

    if (!fs.existsSync(messageDir)) return [];

    let messageFiles: string[];
    try {
      messageFiles = fs.readdirSync(messageDir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    const newEvents: ClaudeSessionEvent[] = [];

    for (const file of messageFiles) {
      const msgId = path.basename(file, '.json');
      const messagePath = path.join(messageDir, file);

      const message = readJsonSafe<OpenCodeMessage>(messagePath);
      if (!message) continue;

      let messageMtimeMs = 0;
      try {
        messageMtimeMs = fs.statSync(messagePath).mtimeMs;
      } catch {
        messageMtimeMs = 0;
      }

      const partDir = path.join(this.storageBase, 'part', msgId);
      let parts: OpenCodePart[] = [];

      if (fs.existsSync(partDir)) {
        try {
          parts = fs.readdirSync(partDir)
            .filter(f => f.endsWith('.json'))
            .map(f => readJsonSafe<OpenCodePart>(path.join(partDir, f)))
            .filter((p): p is OpenCodePart => p !== null);
        } catch {
          // Skip unreadable part directories
        }
      }

      const partIds = new Set(parts.map(part => part.id));
      const previous = this.seenMessages.get(msgId);
      const isNewMessage = !previous;
      let hasNewParts = false;

      if (previous) {
        if (previous.mtimeMs !== messageMtimeMs) {
          hasNewParts = true;
        } else if (partIds.size !== previous.partIds.size) {
          hasNewParts = true;
        } else {
          for (const partId of partIds) {
            if (!previous.partIds.has(partId)) {
              hasNewParts = true;
              break;
            }
          }
        }
      }

      if (isNewMessage || hasNewParts) {
        newEvents.push(...convertOpenCodeMessage(message, parts));
        this.seenMessages.set(msgId, { partIds, mtimeMs: messageMtimeMs });
      }
    }

    // Sort by timestamp
    return newEvents.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  readAll(): ClaudeSessionEvent[] {
    this.reset();
    return this.readNew();
  }

  reset(): void {
    this.seenMessages.clear();
  }

  exists(): boolean {
    return fs.existsSync(path.join(this.storageBase, 'message', this.sessionId));
  }

  flush(): void {
    // No-op for JSON file reading
  }

  getPosition(): number {
    return this.seenMessages.size;
  }

  wasTruncated(): boolean {
    return false; // JSON files don't truncate
  }
}

// --- DB-backed reader ---

/**
 * Incremental reader for DB-backed OpenCode sessions.
 *
 * Uses time_updated timestamps to track which data has been seen,
 * querying only for newer messages/parts on each readNew() call.
 */
class OpenCodeDbReader implements SessionReader {
  private lastTimeUpdated = 0;
  private hasReadOnce = false;

  constructor(
    private readonly sessionId: string,
    private readonly db: OpenCodeDatabase
  ) {}

  readNew(): ClaudeSessionEvent[] {
    // On first call, load the full session history so that attaching to an
    // existing session populates the dashboard with all prior events.
    // This matches the behavior of OpenCodeFileReader and the Claude Code
    // JSONL reader where the first readNew() returns all existing data.
    if (!this.hasReadOnce) {
      this.hasReadOnce = true;
      return this.readAllInternal();
    }

    return this.readIncremental();
  }

  /**
   * Reads all messages and parts for the session, converting them to events.
   * Used for initial history load and readAll().
   */
  private readAllInternal(): ClaudeSessionEvent[] {
    const events: ClaudeSessionEvent[] = [];

    const messages = this.db.getMessagesForSession(this.sessionId);
    const parts = this.db.getPartsForSession(this.sessionId);

    if (messages.length === 0) {
      return [];
    }

    // Group parts by message_id
    const partsByMessage = new Map<string, typeof parts>();
    for (const part of parts) {
      const existing = partsByMessage.get(part.message_id);
      if (existing) {
        existing.push(part);
      } else {
        partsByMessage.set(part.message_id, [part]);
      }
    }

    // Sort messages by creation time
    messages.sort((a, b) => a.time_created - b.time_created);

    // Filter user messages that haven't been processed yet
    const userMessageIds = messages
      .filter(m => extractRoleFromDbMessage(m) === 'user')
      .map(m => m.id);
    const processedUserMessageIds = new Set(
      this.db.getProcessedUserMessageIds(this.sessionId, userMessageIds)
    );

    for (const msgRow of messages) {
      try {
        if (extractRoleFromDbMessage(msgRow) === 'user' && !processedUserMessageIds.has(msgRow.id)) {
          continue;
        }

        const message = parseDbMessageData(msgRow);
        const msgParts = (partsByMessage.get(msgRow.id) || []).map(row => {
          try { return parseDbPartData(row); }
          catch { return null; }
        }).filter((p): p is OpenCodePart => p !== null);

        events.push(...convertOpenCodeMessage(message, msgParts));
      } catch {
        // Skip malformed messages
      }
    }

    // Set cursor to max time_updated across all results
    let maxTimeUpdated = this.lastTimeUpdated;
    for (const m of messages) {
      if (m.time_updated > maxTimeUpdated) maxTimeUpdated = m.time_updated;
    }
    for (const p of parts) {
      if (p.time_updated > maxTimeUpdated) maxTimeUpdated = p.time_updated;
    }
    this.lastTimeUpdated = maxTimeUpdated;

    return events.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  /**
   * Reads only messages/parts newer than the last cursor position.
   * Used for subsequent polling calls after the initial history load.
   */
  private readIncremental(): ClaudeSessionEvent[] {
    const events: ClaudeSessionEvent[] = [];

    // Get messages and parts that are newer than what we've seen
    const messages = this.db.getMessagesNewerThan(this.sessionId, this.lastTimeUpdated);
    const parts = this.db.getPartsNewerThan(this.sessionId, this.lastTimeUpdated);

    if (messages.length === 0 && parts.length === 0) {
      return [];
    }

    // Build set of affected message IDs from both message and part changes
    const affectedMessageIds = new Set<string>(messages.map(m => m.id));
    for (const part of parts) {
      affectedMessageIds.add(part.message_id);
    }

    // If an assistant reply arrives, include its parent user message so
    // queued user prompts are surfaced only once they are actually processed.
    for (const msg of messages) {
      const parentId = extractParentIdFromDbMessage(msg);
      if (parentId) {
        affectedMessageIds.add(parentId);
      }
    }

    // Fetch missing message rows for part-only updates
    const messageMap = new Map(messages.map(m => [m.id, m]));
    const missingMessageIds = [...affectedMessageIds].filter(id => !messageMap.has(id));
    if (missingMessageIds.length > 0) {
      const missingRows = this.db.getMessagesByIds(this.sessionId, missingMessageIds);
      for (const row of missingRows) {
        messageMap.set(row.id, row);
      }

      const unresolved = missingMessageIds.filter(id => !messageMap.has(id));
      if (unresolved.length > 0) {
        // Keep cursor unchanged so we can retry on next polling cycle.
        return [];
      }
    }

    const targetMessages = [...messageMap.values()];
    const targetMessageIds = targetMessages.map(m => m.id);

    // Fetch complete part sets for all affected messages in one batched query
    const allParts = this.db.getPartsForMessages(this.sessionId, targetMessageIds);
    const partsByMessage = new Map<string, typeof allParts>();
    for (const part of allParts) {
      const existing = partsByMessage.get(part.message_id);
      if (existing) {
        existing.push(part);
      } else {
        partsByMessage.set(part.message_id, [part]);
      }
    }

    // Track max time_updated across all results
    let maxTimeUpdated = this.lastTimeUpdated;
    for (const m of messages) {
      if (m.time_updated > maxTimeUpdated) maxTimeUpdated = m.time_updated;
    }
    for (const p of parts) {
      if (p.time_updated > maxTimeUpdated) maxTimeUpdated = p.time_updated;
    }

    // Convert each message + its parts to events
    // Sort messages by creation time
    targetMessages.sort((a, b) => a.time_created - b.time_created);

    const userMessageIds = targetMessages
      .filter(m => extractRoleFromDbMessage(m) === 'user')
      .map(m => m.id);
    const processedUserMessageIds = new Set(
      this.db.getProcessedUserMessageIds(this.sessionId, userMessageIds)
    );

    for (const msgRow of targetMessages) {
      try {
        if (extractRoleFromDbMessage(msgRow) === 'user' && !processedUserMessageIds.has(msgRow.id)) {
          continue;
        }

        const message = parseDbMessageData(msgRow);
        const msgParts = (partsByMessage.get(msgRow.id) || []).map(row => {
          try { return parseDbPartData(row); }
          catch { return null; }
        }).filter((p): p is OpenCodePart => p !== null);

        events.push(...convertOpenCodeMessage(message, msgParts));
      } catch {
        // Skip malformed messages
      }
    }

    this.lastTimeUpdated = maxTimeUpdated;

    return events;
  }

  readAll(): ClaudeSessionEvent[] {
    this.reset();
    return this.readAllInternal();
  }

  reset(): void {
    this.lastTimeUpdated = 0;
    this.hasReadOnce = false;
  }

  exists(): boolean {
    // DB-backed sessions are durable rows rather than ephemeral files.
    // Treat transient sqlite timeout/read failures as "still exists" so
    // SessionMonitor does not flap into discovery mode.
    return true;
  }

  flush(): void {
    // No-op for DB reading
  }

  getPosition(): number {
    return this.lastTimeUpdated;
  }

  wasTruncated(): boolean {
    return false;
  }
}

// --- Main provider ---

/**
 * Session provider for OpenCode CLI.
 *
 * Uses SQLite database as primary data source, with file-based
 * scanning as fallback for older OpenCode installations.
 */
export class OpenCodeSessionProvider implements SessionProvider {
  readonly id = 'opencode' as const;
  readonly displayName = 'OpenCode';

  private db: OpenCodeDatabase | null = null;
  private dbInitialized = false;
  /** Cache of session metadata populated during listing */
  private sessionMetaCache = new Map<string, { title: string | null; timeUpdated: number }>();

  /** Lazy-initialize the database connection. */
  private ensureDb(): OpenCodeDatabase | null {
    if (this.dbInitialized) return this.db;
    this.dbInitialized = true;

    const dataDir = getOpenCodeDataDir();
    const db = new OpenCodeDatabase(dataDir);
    if (db.isAvailable() && db.open()) {
      this.db = db;
      log('OpenCode SQLite database connected');
    } else {
      log('OpenCode SQLite database not available, using file-based fallback');
    }
    return this.db;
  }

  getSessionDirectory(workspacePath: string): string {
    const db = this.ensureDb();
    const projectId = resolveProjectId(workspacePath, db);
    if (projectId) {
      // For DB sessions, return a synthetic directory path
      if (db) {
        return path.join(getOpenCodeDataDir(), DB_SESSION_PREFIX, projectId);
      }
      return path.join(getStorageDir(), 'session', projectId);
    }
    return path.join(getStorageDir(), 'session');
  }

  discoverSessionDirectory(workspacePath: string): string | null {
    const db = this.ensureDb();
    const projectId = resolveProjectId(workspacePath, db);
    if (!projectId) return null;

    // DB: check if project has sessions
    if (db) {
      const sessions = db.getSessionsForProject(projectId);
      if (sessions.length > 0) {
        return path.join(getOpenCodeDataDir(), DB_SESSION_PREFIX, projectId);
      }
    }

    // File fallback
    const dir = path.join(getStorageDir(), 'session', projectId);
    return fs.existsSync(dir) ? dir : null;
  }

  findActiveSession(workspacePath: string): string | null {
    const db = this.ensureDb();
    const projectId = resolveProjectId(workspacePath, db);
    if (!projectId) return null;

    // DB primary
    if (db) {
      const session = db.getMostRecentSession(projectId);
      if (session) {
        const syntheticPath = makeDbSessionPath(getOpenCodeDataDir(), projectId, session.id);
        this.sessionMetaCache.set(syntheticPath, {
          title: session.title,
          timeUpdated: session.time_updated,
        });
        return syntheticPath;
      }
    }

    // File fallback
    return this.findActiveSessionFromFiles(workspacePath, projectId);
  }

  private findActiveSessionFromFiles(_workspacePath: string, projectId: string): string | null {
    const sessionDir = path.join(getStorageDir(), 'session', projectId);
    if (!fs.existsSync(sessionDir)) return null;

    let bestPath: string | null = null;
    let bestMtime = 0;

    try {
      const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const fullPath = path.join(sessionDir, file);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size > 0 && stats.mtime.getTime() > bestMtime) {
            bestMtime = stats.mtime.getTime();
            bestPath = fullPath;
          }
        } catch {
          // Skip
        }
      }
    } catch {
      return null;
    }

    if (bestPath) {
      const sessionId = path.basename(bestPath, '.json');
      const messageDir = path.join(getStorageDir(), 'message', sessionId);

      if (fs.existsSync(messageDir)) {
        try {
          const messageFiles = fs.readdirSync(messageDir).filter(f => f.endsWith('.json'));
          for (const mf of messageFiles) {
            try {
              const mstat = fs.statSync(path.join(messageDir, mf));
              if (mstat.mtime.getTime() > bestMtime) {
                bestMtime = mstat.mtime.getTime();
              }
            } catch {
              // Skip
            }
          }
        } catch {
          // Skip
        }
      }
      return bestPath;
    }

    return null;
  }

  findAllSessions(workspacePath: string): string[] {
    const db = this.ensureDb();
    const projectId = resolveProjectId(workspacePath, db);
    if (!projectId) return [];

    // DB primary
    if (db) {
      const sessions = db.getSessionsForProject(projectId);
      if (sessions.length > 0) {
        const dataDir = getOpenCodeDataDir();
        return sessions.map(s => {
          const syntheticPath = makeDbSessionPath(dataDir, projectId, s.id);
          this.sessionMetaCache.set(syntheticPath, {
            title: s.title,
            timeUpdated: s.time_updated,
          });
          return syntheticPath;
        });
      }
    }

    // File fallback
    const sessionDir = path.join(getStorageDir(), 'session', projectId);
    return this.findSessionsInDirectoryFromFiles(sessionDir);
  }

  findSessionsInDirectory(dir: string): string[] {
    const db = this.ensureDb();

    // Check if this is a synthetic DB session directory
    if (db && dir.includes(path.sep + DB_SESSION_PREFIX + path.sep)) {
      const projectId = extractProjectIdFromDbPath(dir + path.sep + 'dummy.json');
      log(`findSessionsInDirectory: DB path match, extracted projectId=${projectId} from dir=${dir}`);
      if (projectId) {
        const sessions = db.getSessionsForProject(projectId);
        log(`findSessionsInDirectory: DB returned ${sessions.length} sessions for project ${projectId}`);
        const dataDir = getOpenCodeDataDir();
        return sessions.map(s => {
          const syntheticPath = makeDbSessionPath(dataDir, projectId, s.id);
          this.sessionMetaCache.set(syntheticPath, {
            title: s.title,
            timeUpdated: s.time_updated,
          });
          return syntheticPath;
        });
      }
    }

    // For a DB-backed directory path ending with the project ID,
    // try to extract project ID from dir name
    if (db) {
      const dirName = path.basename(dir);
      const sessions = db.getSessionsForProject(dirName);
      log(`findSessionsInDirectory: basename fallback, dirName=${dirName}, sessions=${sessions.length}`);
      if (sessions.length > 0) {
        const dataDir = getOpenCodeDataDir();
        return sessions.map(s => {
          const syntheticPath = makeDbSessionPath(dataDir, dirName, s.id);
          this.sessionMetaCache.set(syntheticPath, {
            title: s.title,
            timeUpdated: s.time_updated,
          });
          return syntheticPath;
        });
      }
    }

    // File fallback
    log(`findSessionsInDirectory: falling back to files for dir=${dir}`);
    return this.findSessionsInDirectoryFromFiles(dir);
  }

  private findSessionsInDirectoryFromFiles(dir: string): string[] {
    try {
      if (!fs.existsSync(dir)) return [];

      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const fullPath = path.join(dir, f);
          try {
            const stats = fs.statSync(fullPath);
            return { path: fullPath, mtime: stats.mtime.getTime(), size: stats.size };
          } catch {
            return null;
          }
        })
        .filter((f): f is { path: string; mtime: number; size: number } =>
          f !== null && f.size > 0
        )
        .sort((a, b) => b.mtime - a.mtime)
        .map(f => f.path);
    } catch {
      return [];
    }
  }

  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
    const db = this.ensureDb();
    const folders: ProjectFolderInfo[] = [];

    // DB primary
    if (db) {
      const projects = db.getAllProjects();
      const stats = db.getProjectSessionStats();
      const statsMap = new Map(stats.map(s => [s.projectId, s]));

      let currentProjectId: string | null = null;
      if (workspacePath) {
        currentProjectId = resolveProjectId(workspacePath, db);
      }

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

      // Sort: current project first, then by recency
      folders.sort((a, b) => {
        if (currentProjectId) {
          const aIsCurrent = a.encodedName === currentProjectId;
          const bIsCurrent = b.encodedName === currentProjectId;
          if (aIsCurrent && !bIsCurrent) return -1;
          if (!aIsCurrent && bIsCurrent) return 1;
        }
        return b.lastModified.getTime() - a.lastModified.getTime();
      });

      log(`getAllProjectFolders: ${folders.length} folders from DB, currentProjectId=${currentProjectId}`);
      for (const f of folders) {
        log(`  folder: name=${f.name}, encoded=${f.encodedName}, sessions=${f.sessionCount}, lastMod=${f.lastModified.toISOString()}`);
      }

      if (folders.length > 0) return folders;
    }

    // File fallback
    return this.getAllProjectFoldersFromFiles(workspacePath);
  }

  private getAllProjectFoldersFromFiles(workspacePath?: string): ProjectFolderInfo[] {
    const folders: ProjectFolderInfo[] = [];
    const sessionBase = path.join(getStorageDir(), 'session');

    try {
      if (!fs.existsSync(sessionBase)) return [];

      const projectIds = fs.readdirSync(sessionBase).filter(name => {
        try {
          return fs.statSync(path.join(sessionBase, name)).isDirectory();
        } catch {
          return false;
        }
      });

      const projectDir = path.join(getStorageDir(), 'project');
      const projectNames = new Map<string, string>();
      if (fs.existsSync(projectDir)) {
        try {
          for (const file of fs.readdirSync(projectDir).filter(f => f.endsWith('.json'))) {
            const proj = readJsonSafe<OpenCodeProject>(path.join(projectDir, file));
            if (proj) {
              projectNames.set(proj.id, proj.path || proj.name || proj.id);
            }
          }
        } catch {
          // Skip
        }
      }

      let currentProjectId: string | null = null;
      if (workspacePath) {
        currentProjectId = resolveProjectIdFromFiles(workspacePath);
      }

      for (const projectId of projectIds) {
        const projSessionDir = path.join(sessionBase, projectId);
        let sessionCount = 0;
        let lastModified = new Date(0);

        try {
          const sessions = fs.readdirSync(projSessionDir).filter(f => f.endsWith('.json'));
          for (const session of sessions) {
            try {
              const stats = fs.statSync(path.join(projSessionDir, session));
              if (stats.size > 0) {
                sessionCount++;
                if (stats.mtime > lastModified) {
                  lastModified = stats.mtime;
                }
              }
            } catch {
              // Skip
            }
          }
        } catch {
          continue;
        }

        folders.push({
          dir: projSessionDir,
          name: projectNames.get(projectId) || projectId,
          encodedName: projectId,
          sessionCount,
          lastModified
        });
      }

      folders.sort((a, b) => {
        if (currentProjectId) {
          const aIsCurrent = a.encodedName === currentProjectId;
          const bIsCurrent = b.encodedName === currentProjectId;
          if (aIsCurrent && !bIsCurrent) return -1;
          if (!aIsCurrent && bIsCurrent) return 1;
        }
        return b.lastModified.getTime() - a.lastModified.getTime();
      });
    } catch {
      // Skip
    }

    return folders;
  }

  isSessionFile(filename: string): boolean {
    return filename.endsWith('.json');
  }

  getSessionId(sessionPath: string): string {
    return path.basename(sessionPath, '.json');
  }

  encodeWorkspacePath(workspacePath: string): string {
    const db = this.ensureDb();
    return resolveProjectId(workspacePath, db) || workspacePath;
  }

  extractSessionLabel(sessionPath: string): string | null {
    const db = this.ensureDb();
    const sessionId = this.getSessionId(sessionPath);

    // Check metadata cache first
    const cached = this.sessionMetaCache.get(sessionPath);
    if (cached?.title) {
      return truncateTitle(cached.title);
    }

    // DB lookup
    if (db) {
      const session = db.getSession(sessionId);
      if (session?.title) {
        return truncateTitle(session.title);
      }
    }

    // File fallback
    return this.extractSessionLabelFromFiles(sessionPath, sessionId);
  }

  private extractSessionLabelFromFiles(sessionPath: string, sessionId: string): string | null {
    if (isDbSessionPath(sessionPath)) return null;

    const session = readJsonSafe<OpenCodeSession>(sessionPath);
    if (session?.title) {
      return truncateTitle(session.title);
    }

    const messageDir = path.join(getStorageDir(), 'message', sessionId);
    if (!fs.existsSync(messageDir)) return null;

    try {
      const files = fs.readdirSync(messageDir)
        .filter(f => f.endsWith('.json'))
        .slice(0, 5);

      for (const file of files) {
        const msg = readJsonSafe<OpenCodeMessage>(path.join(messageDir, file));
        if (msg?.role === 'user') {
          const partDir = path.join(getStorageDir(), 'part', msg.id);
          if (fs.existsSync(partDir)) {
            const partFiles = fs.readdirSync(partDir).filter(f => f.endsWith('.json'));
            for (const pf of partFiles) {
              const part = readJsonSafe<OpenCodePart>(path.join(partDir, pf));
              if (part?.type === 'text' && part.text.trim().length > 0) {
                let text = part.text.trim().replace(/\s+/g, ' ');
                if (text.length > 60) {
                  text = text.substring(0, 57) + '...';
                }
                return text;
              }
            }
          }
        }
      }
    } catch {
      // Skip
    }

    return null;
  }

  createReader(sessionPath: string): SessionReader {
    const db = this.ensureDb();
    const sessionId = this.getSessionId(sessionPath);

    // Use DB reader if available and session exists in DB
    if (db) {
      const session = db.getSession(sessionId);
      if (session) {
        return new OpenCodeDbReader(sessionId, db);
      }
    }

    // File fallback
    return new OpenCodeFileReader(sessionId);
  }

  scanSubagents(_sessionDir: string, sessionId: string): SubagentStats[] {
    const db = this.ensureDb();
    if (!db) return [];

    try {
      const parts = db.getPartsForSession(sessionId);
      const results: SubagentStats[] = [];

      for (const partRow of parts) {
        try {
          const data = JSON.parse(partRow.data) as Record<string, unknown>;
          if (data.type !== 'subtask') continue;

          results.push({
            agentId: partRow.id,
            agentType: (data.agent as string) || undefined,
            description: (data.description as string) || undefined,
            toolCalls: [],
            inputTokens: 0,
            outputTokens: 0,
            startTime: new Date(partRow.time_created),
          });
        } catch {
          // Skip malformed part data
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  searchInSession(sessionPath: string, query: string, maxResults: number): SearchHit[] {
    const db = this.ensureDb();
    const sessionId = this.getSessionId(sessionPath);
    const queryLower = query.toLowerCase();

    // DB primary
    if (db) {
      const dbSession = db.getSession(sessionId);
      if (dbSession) {
        return this.searchInSessionFromDb(db, sessionId, sessionPath, dbSession.project_id, queryLower, query, maxResults);
      }
    }

    // File fallback
    return this.searchInSessionFromFiles(sessionPath, sessionId, queryLower, query, maxResults);
  }

  private searchInSessionFromDb(
    db: OpenCodeDatabase, sessionId: string, sessionPath: string,
    projectId: string, queryLower: string, query: string, maxResults: number
  ): SearchHit[] {
    const results: SearchHit[] = [];

    try {
      const parts = db.getPartsForSession(sessionId);
      const messages = db.getMessagesForSession(sessionId);
      const messageMap = new Map(messages.map(m => [m.id, m]));

      for (const partRow of parts) {
        if (results.length >= maxResults) break;

        const dataStr = partRow.data;
        const dataLower = dataStr.toLowerCase();
        const matchIdx = dataLower.indexOf(queryLower);
        if (matchIdx < 0) continue;

        // Extract a snippet from the raw data
        const start = Math.max(0, matchIdx - 40);
        const end = Math.min(dataStr.length, matchIdx + query.length + 40);
        const snippet = (start > 0 ? '...' : '') +
          dataStr.substring(start, end) +
          (end < dataStr.length ? '...' : '');

        const msgRow = messageMap.get(partRow.message_id);
        const msgData = msgRow ? JSON.parse(msgRow.data) : {};

        results.push({
          sessionPath,
          line: snippet.replace(/\n/g, ' '),
          eventType: msgData.role || 'unknown',
          timestamp: String(partRow.time_created),
          projectPath: projectId,
        });
      }
    } catch {
      // Skip
    }

    return results;
  }

  private searchInSessionFromFiles(
    sessionPath: string, sessionId: string,
    queryLower: string, query: string, maxResults: number
  ): SearchHit[] {
    const results: SearchHit[] = [];
    const messageDir = path.join(getStorageDir(), 'message', sessionId);

    if (!fs.existsSync(messageDir)) return results;

    try {
      const session = readJsonSafe<OpenCodeSession>(sessionPath);
      const projectPath = session?.projectID || sessionId;

      const messageFiles = fs.readdirSync(messageDir).filter(f => f.endsWith('.json'));

      for (const file of messageFiles) {
        if (results.length >= maxResults) break;

        const msg = readJsonSafe<OpenCodeMessage>(path.join(messageDir, file));
        if (!msg) continue;

        const partDir = path.join(getStorageDir(), 'part', msg.id);
        if (!fs.existsSync(partDir)) continue;

        try {
          const partFiles = fs.readdirSync(partDir).filter(f => f.endsWith('.json'));
          for (const pf of partFiles) {
            if (results.length >= maxResults) break;

            const part = readJsonSafe<OpenCodePart>(path.join(partDir, pf));
            if (!part) continue;

            let text = '';
            if (part.type === 'text') text = part.text;
            else if (part.type === 'reasoning') text = part.text;
            else if (part.type === 'tool-invocation' && part.state.output) text = part.state.output;
            else if (part.type === 'tool' && part.state.output) text = part.state.output;

            if (!text) continue;

            const textLower = text.toLowerCase();
            const matchIdx = textLower.indexOf(queryLower);
            if (matchIdx < 0) continue;

            const start = Math.max(0, matchIdx - 40);
            const end = Math.min(text.length, matchIdx + query.length + 40);
            const snippet = (start > 0 ? '...' : '') +
              text.substring(start, end) +
              (end < text.length ? '...' : '');

            results.push({
              sessionPath,
              line: snippet.replace(/\n/g, ' '),
              eventType: msg.role,
              timestamp: String(msg.time.created),
              projectPath
            });
          }
        } catch {
          // Skip
        }
      }
    } catch {
      // Skip
    }

    return results;
  }

  getProjectsBaseDir(): string {
    return path.join(getStorageDir(), 'session');
  }

  getSessionMetadata(sessionPath: string): { mtime: Date } | null {
    // Check cache first
    const cached = this.sessionMetaCache.get(sessionPath);
    if (cached) {
      return { mtime: new Date(cached.timeUpdated) };
    }

    // DB lookup
    const db = this.ensureDb();
    if (db) {
      const sessionId = this.getSessionId(sessionPath);
      const session = db.getSession(sessionId);
      if (session) {
        this.sessionMetaCache.set(sessionPath, {
          title: session.title,
          timeUpdated: session.time_updated,
        });
        return { mtime: new Date(session.time_updated) };
      }
    }

    // Try filesystem for non-DB paths
    if (!isDbSessionPath(sessionPath)) {
      try {
        const stats = fs.statSync(sessionPath);
        return { mtime: stats.mtime };
      } catch {
        // File doesn't exist
      }
    }

    return null;
  }

  /**
   * Returns the latest assistant message's token snapshot for context window sizing.
   * Cumulative session totals are derived from readNew() events processed by SessionMonitor.
   */
  getCurrentUsageSnapshot(sessionPath: string): TokenUsage | null {
    const db = this.ensureDb();
    if (!db) return null;

    const sessionId = this.getSessionId(sessionPath);
    const snapshot = db.getLatestAssistantContextUsage(sessionId);
    if (!snapshot) return null;

    return {
      inputTokens: Number(snapshot.inputTokens) || 0,
      outputTokens: Number(snapshot.outputTokens) || 0,
      cacheWriteTokens: Number(snapshot.cacheWriteTokens) || 0,
      cacheReadTokens: Number(snapshot.cacheReadTokens) || 0,
      reasoningTokens: Number(snapshot.reasoningTokens) || 0,
      model: snapshot.modelId || 'unknown',
      timestamp: new Date(Number(snapshot.timeCreated) || Date.now()),
    };
  }

  computeContextSize(usage: TokenUsage): number {
    // Context = input tokens + cache tokens. Output and reasoning tokens
    // are the model's response, not part of the context window.
    return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  }

  getContextAttribution(sessionPath: string): ContextAttribution | null {
    const db = this.ensureDb();
    if (!db) return null;

    const sessionId = this.getSessionId(sessionPath);

    try {
      const messages = db.getMessagesForSession(sessionId);
      if (messages.length === 0) return null;

      const attribution: ContextAttribution = {
        systemPrompt: 0,
        userMessages: 0,
        assistantResponses: 0,
        toolInputs: 0,
        toolOutputs: 0,
        thinking: 0,
        other: 0,
      };

      // Accumulate input tokens by role. OpenCode messages store actual
      // token counts from the provider, so this is more accurate than
      // heuristic content estimation.
      for (const row of messages) {
        try {
          const data = JSON.parse(row.data) as Record<string, unknown>;
          const role = data.role as string;
          const tokens = data.tokens as Record<string, unknown> | undefined;
          const cache = tokens?.cache as Record<string, unknown> | undefined;

          // Context contribution = input + cacheWrite + cacheRead
          const input = (tokens?.input as number) || 0;
          const cacheRead = (cache?.read as number) || 0;
          const cacheWrite = (cache?.write as number) || 0;
          const reasoning = (tokens?.reasoning as number) || 0;
          const contextTokens = input + cacheRead + cacheWrite;

          if (contextTokens === 0) continue;

          if (role === 'user') {
            // User messages include prompts and tool results;
            // we can't distinguish without parsing parts, so attribute
            // to userMessages (tool outputs arrive as separate assistant
            // messages in OpenCode's model)
            attribution.userMessages += contextTokens;
          } else if (role === 'assistant') {
            // Attribute reasoning separately when available
            if (reasoning > 0) {
              attribution.thinking += reasoning;
              attribution.assistantResponses += contextTokens - reasoning;
            } else {
              attribution.assistantResponses += contextTokens;
            }
          } else if (role === 'system') {
            attribution.systemPrompt += contextTokens;
          } else {
            attribution.other += contextTokens;
          }
        } catch {
          // Skip malformed message data
        }
      }

      // Refine user attribution: scan parts to separate tool outputs
      // from user prompts for more accurate breakdown
      const parts = db.getPartsForSession(sessionId);
      let toolPartCount = 0;
      let userTextPartCount = 0;
      for (const partRow of parts) {
        try {
          const partData = JSON.parse(partRow.data) as Record<string, unknown>;
          const partType = partData.type as string;
          if (partType === 'tool' || partType === 'tool-invocation') {
            toolPartCount++;
          } else if (partType === 'text') {
            userTextPartCount++;
          }
        } catch {
          // Skip
        }
      }

      // If there are tool parts, redistribute user token attribution
      // between userMessages and toolOutputs proportionally
      const totalParts = toolPartCount + userTextPartCount;
      if (totalParts > 0 && toolPartCount > 0 && attribution.userMessages > 0) {
        const toolProportion = toolPartCount / totalParts;
        const toolTokens = Math.round(attribution.userMessages * toolProportion);
        attribution.toolOutputs += toolTokens;
        attribution.userMessages -= toolTokens;
      }

      const total = attribution.systemPrompt + attribution.userMessages +
        attribution.assistantResponses + attribution.toolInputs +
        attribution.toolOutputs + attribution.thinking + attribution.other;

      return total > 0 ? attribution : null;
    } catch {
      return null;
    }
  }

  getContextWindowLimit(modelId?: string): number {
    if (!modelId) return 200_000;
    const id = modelId.toLowerCase();

    // GPT-4.1 series: 1M context
    if (id.startsWith('gpt-4.1')) return 1_000_000;
    // GPT-5 series: 400K context
    if (id.startsWith('gpt-5')) return 400_000;
    // o1, o3, o4 series: 200K context
    if (id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 200_000;
    // GPT-4o / GPT-4 series: 128K context
    if (id.startsWith('gpt-4')) return 128_000;
    // Claude models: 200K context
    if (id.startsWith('claude')) return 200_000;
    // Gemini models: 1M context
    if (id.startsWith('gemini')) return 1_000_000;
    // DeepSeek models: 128K context
    if (id.startsWith('deepseek')) return 128_000;

    log(`getContextWindowLimit: unrecognized model "${modelId}", using default 200K`);
    return 200_000;
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
    this.dbInitialized = false;
    this.sessionMetaCache.clear();
  }
}

/** Truncate a title to 60 chars with ellipsis. */
function truncateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length > 60) {
    return trimmed.substring(0, 57) + '...';
  }
  return trimmed;
}
