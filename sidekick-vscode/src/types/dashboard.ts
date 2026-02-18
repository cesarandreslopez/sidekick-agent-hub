/**
 * @fileoverview Type definitions for dashboard webview communication.
 *
 * This module defines message types for communication between the extension
 * and the dashboard webview, as well as the dashboard state structure.
 *
 * @module types/dashboard
 */

import type {
  SessionSummaryData,
  TaskPerformanceData,
  CacheEffectivenessData,
  RecoveryPatternData,
  AdvancedBurnRateData,
  ToolEfficiencyData
} from './sessionSummary';
import type { DecisionEntryDisplay } from './decisionLog';

/**
 * Session info for the session card navigator.
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
  /** First user prompt text (truncated to 60 chars), or null if unavailable */
  label: string | null;
  /** Whether the session was modified within the last 2 minutes */
  isActive: boolean;
}

/**
 * Group of sessions from a single project directory.
 */
export interface SessionGroup {
  /** Decoded human-readable project path (e.g., "/home/cal/code/myproject") */
  projectPath: string;
  /** Short display path with home dir replaced by ~ (e.g., "~/code/myproject") */
  displayPath: string;
  /** Proximity tier relative to the current workspace */
  proximity: 'current' | 'related' | 'other';
  /** Sessions in this project, sorted by modification time (most recent first) */
  sessions: SessionInfo[];
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
  /** Projected 5-hour utilization at reset time (percentage) */
  projectedFiveHour?: number;
  /** Projected 7-day utilization at reset time (percentage) */
  projectedSevenDay?: number;
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
  | { type: 'updateSessionProvider'; providerId: 'claude-code' | 'opencode' | 'codex'; displayName: string }
  | { type: 'updateSessionList'; groups: SessionGroup[]; isPinned: boolean; isUsingCustomPath?: boolean; customPathDisplay?: string | null }
  | { type: 'discoveryModeChange'; inDiscoveryMode: boolean }
  | { type: 'updateQuota'; quota: QuotaState }
  | { type: 'updateHistoricalData'; data: HistoricalSummary }
  | { type: 'historicalDataLoading'; loading: boolean }
  | { type: 'updateLatency'; latency: LatencyDisplay }
  | { type: 'showSuggestions'; suggestions: ClaudeMdSuggestionDisplay[] }
  | { type: 'suggestionsLoading'; loading: boolean }
  | { type: 'suggestionsError'; error: string }
  | { type: 'updateSessionSummary'; summary: SessionSummaryData }
  | { type: 'updateTaskPerformance'; data: TaskPerformanceData }
  | { type: 'updateCacheEffectiveness'; data: CacheEffectivenessData }
  | { type: 'updateRecoveryPatterns'; data: RecoveryPatternData }
  | { type: 'updateAdvancedBurnRate'; data: AdvancedBurnRateData }
  | { type: 'updateToolEfficiency'; data: ToolEfficiencyData[] }
  | { type: 'sessionNarrative'; narrative: string }
  | { type: 'narrativeLoading'; loading: boolean }
  | { type: 'narrativeError'; error: string }
  | { type: 'updateCompactions'; compactions: CompactionEventDisplay[] }
  | { type: 'updateContextAttribution'; attribution: ContextAttributionDisplay[] }
  | { type: 'sessionsLoading'; loading: boolean }
  | { type: 'notification'; title: string; body: string; severity: 'info' | 'warning' | 'error' }
  | { type: 'toolCallDetails'; toolName: string; calls: ToolCallDetailDisplay[] }
  | { type: 'syncEventLogState'; enabled: boolean }
  | { type: 'updateDecisions'; decisions: DecisionEntryDisplay[]; totalCount: number };

/**
 * Messages from webview to extension.
 *
 * These messages are sent by the webview to request data or signal state.
 */
export type DashboardWebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'requestStats' }
  | { type: 'selectSession'; sessionPath: string }
  | { type: 'setSessionProvider'; providerId: 'claude-code' | 'opencode' | 'codex' }
  | { type: 'refreshSessions' }
  | { type: 'togglePin' }
  | { type: 'browseSessionFolders' }
  | { type: 'clearCustomPath' }
  | { type: 'requestHistoricalData'; range: 'today' | 'week' | 'month' | 'all'; metric: string }
  | { type: 'drillDown'; timestamp: string; currentRange: string }
  | { type: 'drillUp' }
  | { type: 'importHistoricalData' }
  | { type: 'analyzeSession' }
  | { type: 'copySuggestion'; text: string }
  | { type: 'openClaudeMd' }
  | { type: 'openInstructionFile' }
  | { type: 'generateNarrative' }
  | { type: 'requestSessionSummary' }
  | { type: 'searchTimeline'; query: string }
  | { type: 'setTimelineFilter'; filters: TimelineFilterState }
  | { type: 'requestToolCallDetails'; toolName: string }
  | { type: 'toggleEventLog'; enabled: boolean }
  | { type: 'requestDecisions' }
  | { type: 'searchDecisions'; query: string }
  | { type: 'clearDecisions' }
  | { type: 'generateHandoff' };

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
  type: 'user_prompt' | 'tool_call' | 'tool_result' | 'error' | 'assistant_response' | 'compaction';
  /** Formatted time (e.g., "2:34 PM") */
  time: string;
  /** Event description */
  description: string;
  /** Whether this is an error event */
  isError?: boolean;
  /** Full text for expandable content (when truncated) */
  fullText?: string;
  /** Noise classification for filtering */
  noiseLevel?: 'user' | 'ai' | 'system' | 'noise';
  /** Whether this event is from a sidechain */
  isSidechain?: boolean;
  /** Context before compaction (for compaction events) */
  contextBefore?: number;
  /** Context after compaction (for compaction events) */
  contextAfter?: number;
  /** Tokens reclaimed by compaction */
  tokensReclaimed?: number;
}

/**
 * Compaction event formatted for display.
 */
export interface CompactionEventDisplay {
  /** Formatted time */
  time: string;
  /** Context before compaction (tokens) */
  contextBefore: number;
  /** Context after compaction (tokens) */
  contextAfter: number;
  /** Tokens reclaimed */
  tokensReclaimed: number;
  /** Percentage of context reclaimed */
  reclaimedPercent: number;
}

/**
 * Context attribution breakdown for display.
 */
export interface ContextAttributionDisplay {
  /** Category label */
  category: string;
  /** Token count */
  tokens: number;
  /** Percentage of total context */
  percent: number;
  /** CSS color for chart rendering */
  color: string;
}

/**
 * Data point for historical time-series display.
 */
export interface HistoricalDataPoint {
  /** Timestamp for this data point (ISO string or label like "2024-01-15") */
  timestamp: string;

  /** Display label for the x-axis */
  label: string;

  /** Input tokens for this period */
  inputTokens: number;

  /** Output tokens for this period */
  outputTokens: number;

  /** Cache write tokens for this period */
  cacheWriteTokens: number;

  /** Cache read tokens for this period */
  cacheReadTokens: number;

  /** Total estimated cost in USD */
  totalCost: number;

  /** Number of messages (API calls) */
  messageCount: number;

  /** Number of sessions in this period */
  sessionCount: number;
}

/**
 * Historical data summary for a time range.
 */
export interface HistoricalSummary {
  /** Time range type */
  range: 'today' | 'week' | 'month' | 'all';

  /** Granularity of data points */
  granularity: 'hourly' | 'daily' | 'monthly';

  /** Data points for the range */
  dataPoints: HistoricalDataPoint[];

  /** Aggregated totals for the range */
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
    messageCount: number;
    sessionCount: number;
  };
}

/**
 * CLAUDE.md suggestion formatted for display.
 *
 * Contains a single suggestion for improving CLAUDE.md based on
 * session analysis.
 */
export interface ClaudeMdSuggestionDisplay {
  /** Short descriptive title */
  title: string;

  /** What was observed in the session that led to this suggestion */
  observed: string;

  /** The exact text to add to CLAUDE.md */
  suggestion: string;

  /** Why this suggestion would help */
  reasoning: string;
}

/**
 * Response latency metrics formatted for display.
 *
 * Human-readable latency values for the dashboard UI.
 */
export interface LatencyDisplay {
  /** Average first token latency (e.g., "2.3s") */
  avgFirstToken: string;

  /** Maximum first token latency (e.g., "4.2s") */
  maxFirstToken: string;

  /** Most recent first token latency (e.g., "1.8s") */
  lastFirstToken: string;

  /** Average total response time (e.g., "5.1s") */
  avgTotal: string;

  /** Number of completed request-response cycles */
  cycleCount: number;

  /** Whether any latency data is available */
  hasData: boolean;
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

  /** Summary of file changes (additions/deletions) across all Write/Edit operations */
  fileChangeSummary?: {
    /** Number of unique files modified */
    totalFilesChanged: number;
    /** Total lines added */
    totalAdditions: number;
    /** Total lines deleted */
    totalDeletions: number;
  };

  /** Response latency metrics for display */
  latencyDisplay?: LatencyDisplay;

  /** Compaction events for display */
  compactions?: CompactionEventDisplay[];

  /** Context token attribution breakdown */
  contextAttribution?: ContextAttributionDisplay[];
}

/**
 * Individual tool call formatted for drill-down display.
 */
export interface ToolCallDetailDisplay {
  /** Formatted time */
  time: string;
  /** Tool context description */
  description: string;
  /** Duration in human-readable format */
  duration: string;
  /** Whether this call was an error */
  isError: boolean;
  /** Error message if applicable */
  errorMessage?: string;
}

/**
 * Timeline filter state for noise filtering.
 */
export interface TimelineFilterState {
  /** Show user messages */
  showUser: boolean;
  /** Show AI/assistant messages */
  showAi: boolean;
  /** Show system/noise messages */
  showSystem: boolean;
  /** Show sidechain events */
  showSidechain: boolean;
}
