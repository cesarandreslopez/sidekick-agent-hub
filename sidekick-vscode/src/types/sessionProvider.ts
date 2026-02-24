/**
 * @fileoverview Session provider abstraction for multi-CLI agent support.
 *
 * Defines the interface that CLI agent providers (Claude Code, OpenCode, etc.)
 * must implement to integrate with SessionMonitor and its consumers.
 * Providers handle I/O and format-specific logic while SessionMonitor
 * retains all event processing, stats aggregation, and business logic.
 *
 * The base types (SessionReader, ProjectFolderInfo, SearchHit, SessionProviderBase)
 * are defined in sidekick-shared and re-exported here. The VS Code SessionProvider
 * interface extends SessionProviderBase with vscode.Disposable and optional
 * VS Code-specific methods.
 *
 * @module types/sessionProvider
 */

import type * as vscode from 'vscode';
import type { QuotaState } from './dashboard';

// Re-export shared types
export type {
  SessionReader,
  ProjectFolderInfo,
  SearchHit,
  SessionFileInfo,
  SessionFileStats,
  SessionProviderBase,
  ProviderId,
} from 'sidekick-shared/dist/providers/types';

// Re-export session event types used by providers
export type {
  ClaudeSessionEvent,
  ContextAttribution,
  SubagentStats,
  TokenUsage,
} from './claudeSession';

/**
 * Session provider interface for CLI agent integrations.
 *
 * Each supported CLI agent (Claude Code, OpenCode, etc.) implements this
 * interface to provide session discovery, file identification, and data reading.
 * SessionMonitor delegates all I/O to the provider and retains event processing.
 *
 * Extends SessionProviderBase from sidekick-shared with vscode.Disposable
 * and optional VS Code-specific methods.
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
  getAllProjectFolders(workspacePath?: string): import('sidekick-shared/dist/providers/types').ProjectFolderInfo[];

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
  createReader(sessionPath: string): import('sidekick-shared/dist/providers/types').SessionReader;

  // --- Subagent support ---

  /** Scans for subagent data associated with a session. */
  scanSubagents(sessionDir: string, sessionId: string): import('sidekick-shared/dist/types/sessionEvent').SubagentStats[];

  // --- Cross-session search ---

  /** Searches for text within a session file. */
  searchInSession(sessionPath: string, query: string, maxResults: number): import('sidekick-shared/dist/providers/types').SearchHit[];

  /** Gets the base projects directory path for cross-session search. */
  getProjectsBaseDir(): string;

  /** Get session metadata without filesystem access (for DB-backed providers). */
  getSessionMetadata?(sessionPath: string): { mtime: Date } | null;

  /** Gets the context window token limit for a model. Returns 200K by default. */
  getContextWindowLimit?(modelId?: string): number;

  /** Computes context window size from token usage. Provider-specific formula. */
  computeContextSize?(usage: import('sidekick-shared/dist/types/sessionEvent').TokenUsage): number;

  /** Gets latest assistant usage snapshot for an active session, if available. */
  getCurrentUsageSnapshot?(sessionPath: string): import('sidekick-shared/dist/types/sessionEvent').TokenUsage | null;

  /** Gets context attribution breakdown from provider data, if available. */
  getContextAttribution?(sessionPath: string): import('sidekick-shared/dist/types/sessionEvent').ContextAttribution | null;

  /** Gets subscription quota state from session data (e.g., Codex rate_limits). */
  getQuotaFromSession?(): QuotaState | null;
}
