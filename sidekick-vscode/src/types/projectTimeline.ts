/**
 * @fileoverview Type definitions for multi-session project timeline.
 *
 * Provides types for the chronological timeline webview showing all sessions
 * with annotations, expandable details, and drill-down.
 *
 * @module types/projectTimeline
 */

/**
 * Summary entry for a single session in the timeline.
 */
export interface TimelineSessionEntry {
  /** Session identifier */
  sessionId: string;

  /** Absolute path to session file */
  sessionPath: string;

  /** ISO 8601 start time */
  startTime: string;

  /** ISO 8601 end time (null if still active) */
  endTime: string | null;

  /** Duration in milliseconds */
  durationMs: number;

  /** Display label (derived from session file or provider) */
  label: string;

  /** Total tokens consumed */
  totalTokens: number;

  /** Estimated cost in USD */
  totalCost: number;

  /** Number of messages */
  messageCount: number;

  /** Number of tasks */
  taskCount: number;

  /** Number of errors */
  errorCount: number;

  /** Key files touched (max 10) */
  keyFiles: string[];

  /** Whether this is the currently active session */
  isCurrent: boolean;

  /** Whether the session is still in progress */
  isActive: boolean;

  /** Models used in this session */
  models: string[];
}

/**
 * Detailed data loaded on demand when a session is expanded.
 */
export interface TimelineSessionDetail {
  /** Session identifier */
  sessionId: string;

  /** Tasks with subjects and statuses */
  tasks: Array<{ subject: string; status: string }>;

  /** Error summaries */
  errors: Array<{ category: string; count: number; example: string }>;

  /** Tool usage breakdown */
  toolBreakdown: Array<{ tool: string; calls: number; failures: number }>;
}

/**
 * Time range filter for the timeline.
 */
export type TimelineRange = '24h' | '7d' | '30d' | 'all';

/**
 * Complete state for the project timeline webview.
 */
export interface ProjectTimelineState {
  /** Session entries to display */
  sessions: TimelineSessionEntry[];

  /** Currently selected time range */
  range: TimelineRange;

  /** Project display name */
  projectName: string;

  /** ISO 8601 timestamp of last data update */
  lastUpdated: string;
}

/**
 * Messages from extension to webview.
 */
export type ProjectTimelineMessage =
  | { type: 'updateTimeline'; state: ProjectTimelineState }
  | { type: 'sessionDetail'; detail: TimelineSessionDetail }
  | { type: 'loading'; loading: boolean }
  | { type: 'updatePhrase'; phrase: string }
  | { type: 'updateEmptyPhrase'; phrase: string };

/**
 * Messages from webview to extension.
 */
export type WebviewTimelineMessage =
  | { type: 'ready' }
  | { type: 'setRange'; range: TimelineRange }
  | { type: 'expandSession'; sessionId: string }
  | { type: 'openSession'; sessionPath: string }
  | { type: 'refresh' };
