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
import type { SessionProviderBase } from 'sidekick-shared';

// Re-export shared types
export type {
  SessionReader,
  ProjectFolderInfo,
  SearchHit,
  SessionFileInfo,
  SessionFileStats,
  SessionProviderBase,
  ProviderId,
} from 'sidekick-shared';

// Re-export session event types used by providers
export type { SessionEvent, ContextAttribution, SubagentStats, TokenUsage } from './claudeSession';

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
export interface SessionProvider extends SessionProviderBase, vscode.Disposable {
  dispose(): void;
  /** Gets subscription quota state from session data or provider APIs (e.g., Codex rate_limits, z.ai quota API). */
  getQuotaFromSession?(): QuotaState | null | Promise<QuotaState | null>;
}
