/**
 * Shared provider interface and types for session providers.
 *
 * SessionProviderBase is the expanded interface that both the VS Code extension
 * and CLI can use. The VS Code extension extends it with vscode.Disposable and
 * optional VS Code-specific methods.
 *
 * SessionProvider is the original simplified interface maintained for backward
 * compatibility with existing CLI code.
 */

import type { SessionEvent, SubagentStats, TokenUsage, ContextAttribution } from '../types/sessionEvent';

export type ProviderId = 'claude-code' | 'opencode' | 'codex';

export interface SearchHit {
  sessionPath: string;
  line: string;
  eventType: string;
  timestamp: string;
  projectPath: string;
}

export interface SessionFileInfo {
  /** Absolute path to the session file */
  path: string;
  /** Last modification time */
  mtime: Date;
  /** Optional human-readable label (e.g., first user prompt) */
  label?: string;
}

export interface SessionFileStats {
  providerId: ProviderId;
  sessionId: string;
  filePath: string;
  label: string | null;
  startTime: string;
  endTime: string;
  messageCount: number;
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  modelUsage: Record<string, { calls: number; tokens: number }>;
  toolUsage: Record<string, number>;
  compactionEstimate: number;
  truncationCount: number;
  reportedCost: number;
}

export interface ProjectFolderInfo {
  dir: string;
  name: string;
  encodedName: string;
  sessionCount: number;
  lastModified: Date;
}

/**
 * Incremental reader for session data.
 *
 * Abstracts the difference between JSONL incremental byte reading (Claude Code)
 * and DB-backed enumeration (OpenCode). Returns events in SessionEvent format.
 */
export interface SessionReader {
  /** Read new events since last call. */
  readNew(): SessionEvent[];
  /** Read all events from start. */
  readAll(): SessionEvent[];
  /** Reset read state (for truncation or re-read). */
  reset(): void;
  /** Whether the session source still exists. */
  exists(): boolean;
  /** Flush any buffered data. */
  flush(): void;
  /** Get current byte/file position for size tracking. */
  getPosition(): number;
  /** Seek to a specific position (byte offset for JSONL, timestamp for DB-backed). */
  seekTo(position: number): void;
  /** Check if file was truncated (size < position). */
  wasTruncated(): boolean;
}

/**
 * Expanded session provider interface (no VS Code dependencies).
 *
 * Includes all methods needed by both VS Code extension and CLI.
 * The VS Code extension wraps this with `vscode.Disposable` and
 * optional VS Code-specific methods.
 */
export interface SessionProviderBase {
  /** Unique provider identifier */
  readonly id: ProviderId;
  /** Human-readable display name */
  readonly displayName: string;

  // --- Path resolution ---

  /** Gets the expected session directory for a workspace (may not exist). */
  getSessionDirectory(workspacePath: string): string;

  /** Discovers the actual session directory using multiple strategies. Returns null if not found. */
  discoverSessionDirectory(workspacePath: string): string | null;

  // --- Session discovery ---

  /** Finds the most recently active session file for a workspace. */
  findActiveSession(workspacePath: string): string | null;

  /** Finds all session files for a workspace, sorted by mtime (most recent first). */
  findAllSessions(workspacePath: string): string[];

  /** Finds all session files in a specific directory. */
  findSessionsInDirectory(dir: string): string[];

  /** Gets all project folders with session data. */
  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[];

  // --- File identification ---

  /** Tests whether a filename is a session file for this provider. */
  isSessionFile(filename: string): boolean;

  /** Extracts a session ID from a session file path. */
  getSessionId(sessionPath: string): string;

  /** Encodes a workspace path to the provider's directory naming scheme. */
  encodeWorkspacePath(workspacePath: string): string;

  /** Extracts a human-readable label from a session file (e.g., first user prompt). */
  extractSessionLabel(sessionPath: string): string | null;

  // --- Data reading ---

  /** Creates an incremental reader for a session file. */
  createReader(sessionPath: string): SessionReader;

  // --- Subagent support ---

  /** Scans for subagent data associated with a session. */
  scanSubagents(sessionDir: string, sessionId: string): SubagentStats[];

  // --- Cross-session search ---

  /** Searches for text within a session file. */
  searchInSession(sessionPath: string, query: string, maxResults: number): SearchHit[];

  /** Gets the base projects directory path for cross-session search. */
  getProjectsBaseDir(): string;

  // --- Stats ---

  /** Reads aggregated stats for a session file. */
  readSessionStats(sessionPath: string): SessionFileStats;

  // --- Optional methods ---

  /** Get session metadata without filesystem access (for DB-backed providers). */
  getSessionMetadata?(sessionPath: string): { mtime: Date } | null;

  /** Gets the context window token limit for a model. Returns 200K by default. */
  getContextWindowLimit?(modelId?: string): number;

  /** Computes context window size from token usage. Provider-specific formula. */
  computeContextSize?(usage: TokenUsage): number;

  /** Gets latest assistant usage snapshot for an active session, if available. */
  getCurrentUsageSnapshot?(sessionPath: string): TokenUsage | null;

  /** Gets context attribution breakdown from provider data, if available. */
  getContextAttribution?(sessionPath: string): ContextAttribution | null;

  // --- Lifecycle ---

  /** Release resources. */
  dispose(): void;
}

/**
 * Original simplified session provider interface.
 * Maintained for backward compatibility with existing CLI and shared code.
 */
export interface SessionProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  findSessionFiles(workspacePath: string): string[];
  findAllSessions(workspacePath: string): string[];
  getProjectsBaseDir(): string;
  readSessionStats(sessionPath: string): SessionFileStats;
  extractSessionLabel(sessionPath: string): string | null;
  searchInSession(sessionPath: string, query: string, maxResults: number): SearchHit[];
  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[];
  dispose(): void;
}
