/**
 * @fileoverview Type definitions for dashboard webview communication.
 *
 * This module defines message types for communication between the extension
 * and the dashboard webview, as well as the dashboard state structure.
 *
 * @module types/dashboard
 */

/**
 * Session info for the session selector dropdown.
 */
export interface SessionInfo {
  /** Full path to the session file */
  path: string;
  /** Session filename (UUID without .jsonl) */
  filename: string;
  /** Last modified timestamp as ISO string */
  modifiedTime: string;
  /** Whether this is the currently monitored session */
  isCurrent: boolean;
}

/**
 * Quota data for a single time window (5-hour or 7-day).
 */
export interface QuotaWindow {
  /** Utilization percentage (0-100) */
  utilization: number;
  /** ISO timestamp when the quota resets */
  resetsAt: string;
}

/**
 * Complete quota state for Claude Max subscription.
 */
export interface QuotaState {
  /** 5-hour rolling quota */
  fiveHour: QuotaWindow;
  /** 7-day rolling quota */
  sevenDay: QuotaWindow;
  /** Whether quota data is available (false if no token or API key mode) */
  available: boolean;
  /** Error message if quota fetch failed */
  error?: string;
}

/**
 * Messages from extension to webview.
 *
 * These messages update the dashboard UI with session data.
 */
export type DashboardMessage =
  | { type: 'updateStats'; state: DashboardState }
  | { type: 'updateBurnRate'; burnRate: number; sessionStartTime: string | null }
  | { type: 'updateToolAnalytics'; analytics: ToolAnalyticsDisplay[] }
  | { type: 'updateTimeline'; events: TimelineEventDisplay[] }
  | { type: 'sessionStart'; sessionPath: string }
  | { type: 'sessionEnd' }
  | { type: 'updateSessionList'; sessions: SessionInfo[] }
  | { type: 'discoveryModeChange'; inDiscoveryMode: boolean }
  | { type: 'updateQuota'; quota: QuotaState };

/**
 * Messages from webview to extension.
 *
 * These messages are sent by the webview to request data or signal state.
 */
export type WebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'requestStats' }
  | { type: 'selectSession'; sessionPath: string }
  | { type: 'refreshSessions' };

/**
 * Model usage breakdown entry.
 *
 * Tracks usage statistics for a specific Claude model.
 */
export interface ModelBreakdownEntry {
  /** Model identifier (e.g., "claude-opus-4-20250514") */
  model: string;

  /** Number of API calls to this model */
  calls: number;

  /** Total tokens used by this model */
  tokens: number;

  /** Total cost for this model in USD */
  cost: number;
}

/**
 * Tool analytics formatted for display.
 */
export interface ToolAnalyticsDisplay {
  /** Tool name */
  name: string;
  /** Total calls (success + failure) */
  totalCalls: number;
  /** Success rate as percentage (0-100) */
  successRate: number;
  /** Average duration in milliseconds */
  avgDuration: number;
  /** Currently pending calls */
  pendingCount: number;
}

/**
 * Timeline event formatted for display.
 */
export interface TimelineEventDisplay {
  /** Event type for icon selection */
  type: 'user_prompt' | 'tool_call' | 'tool_result' | 'error';
  /** Formatted time (e.g., "2:34 PM") */
  time: string;
  /** Event description */
  description: string;
  /** Whether this is an error event */
  isError?: boolean;
}

/**
 * Dashboard state structure.
 *
 * Represents the complete state of the session analytics dashboard,
 * including token usage, costs, and model breakdown.
 */
export interface DashboardState {
  /** Total input tokens consumed */
  totalInputTokens: number;

  /** Total output tokens generated */
  totalOutputTokens: number;

  /** Total cache write tokens (1.25x input cost) */
  totalCacheWriteTokens: number;

  /** Total cache read tokens (0.1x input cost) */
  totalCacheReadTokens: number;

  /** Total estimated cost in USD */
  totalCost: number;

  /** Context window usage percentage (0-100) */
  contextUsagePercent: number;

  /** Per-model usage breakdown */
  modelBreakdown: ModelBreakdownEntry[];

  /** Whether a Claude Code session is currently active */
  sessionActive: boolean;

  /** ISO 8601 timestamp of last update */
  lastUpdated: string;

  /** Tool analytics for display */
  toolAnalytics: ToolAnalyticsDisplay[];

  /** Recent timeline events for display */
  timeline: TimelineEventDisplay[];

  /** Error details by type (with messages for foldable display) */
  errorDetails: { type: string; count: number; messages: string[] }[];
}
