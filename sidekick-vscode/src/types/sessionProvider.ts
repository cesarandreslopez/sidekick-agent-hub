/**
 * @fileoverview Session provider abstraction for multi-CLI agent support.
 *
 * Defines the interface that CLI agent providers (Claude Code, OpenCode, etc.)
 * must implement to integrate with SessionMonitor and its consumers.
 * Providers handle I/O and format-specific logic while SessionMonitor
 * retains all event processing, stats aggregation, and business logic.
 *
 * @module types/sessionProvider
 */

import type * as vscode from 'vscode';
import type { ClaudeSessionEvent, ContextAttribution, SubagentStats, TokenUsage } from './claudeSession';
import type { QuotaState } from './dashboard';

/**
 * Information about a single session file.
 */
export interface SessionFileInfo {
  /** Absolute path to the session file */
  path: string;
  /** Last modification time */
  mtime: Date;
  /** Optional human-readable label (e.g., first user prompt) */
  label?: string;
}

/**
 * Information about a project folder containing sessions.
 */
export interface ProjectFolderInfo {
  /** Absolute path to the session directory */
  dir: string;
  /** Human-readable project name or decoded path */
  name: string;
  /** Raw encoded directory name (for reliable comparison) */
  encodedName?: string;
  /** Number of session files in this directory */
  sessionCount: number;
  /** Most recent session modification time */
  lastModified: Date;
}

/**
 * A single search hit within a session file.
 */
export interface SearchHit {
  /** Path to the session file */
  sessionPath: string;
  /** The matching line or text snippet */
  line: string;
  /** Event type of the match */
  eventType: string;
  /** Timestamp of the matching event */
  timestamp: string;
  /** Decoded project path */
  projectPath: string;
}

/**
 * Incremental reader for session data.
 *
 * Abstracts the difference between JSONL incremental byte reading (Claude Code)
 * and JSON file enumeration (OpenCode). Returns events in ClaudeSessionEvent format.
 */
export interface SessionReader {
  /** Read new events since last call. */
  readNew(): ClaudeSessionEvent[];
  /** Read all events from start. */
  readAll(): ClaudeSessionEvent[];
  /** Reset read state (for truncation or re-read). */
  reset(): void;
  /** Whether the session source still exists. */
  exists(): boolean;
  /** Flush any buffered data. */
  flush(): void;
  /** Get current byte/file position for size tracking. */
  getPosition(): number;
  /** Check if file was truncated (size < position). */
  wasTruncated(): boolean;
}

/**
 * Session provider interface for CLI agent integrations.
 *
 * Each supported CLI agent (Claude Code, OpenCode, etc.) implements this
 * interface to provide session discovery, file identification, and data reading.
 * SessionMonitor delegates all I/O to the provider and retains event processing.
 */
export interface SessionProvider extends vscode.Disposable {
  /** Unique provider identifier */
  readonly id: 'claude-code' | 'opencode' | 'codex';
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

  /** Gets subscription quota state from session data (e.g., Codex rate_limits). */
  getQuotaFromSession?(): QuotaState | null;
}
