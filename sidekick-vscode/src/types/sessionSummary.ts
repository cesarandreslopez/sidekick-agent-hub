/**
 * @fileoverview Type definitions for session summary and richer dashboard panels.
 *
 * These types are consumed by the dashboard webview to render the Summary tab
 * and the enhanced collapsible panels in the Session tab.
 *
 * @module types/sessionSummary
 */

import type { ToolAnalyticsDisplay } from './dashboard';

/**
 * Individual task summary for the Session Summary view.
 */
export interface TaskSummaryItem {
  /** Task subject/title */
  subject: string;
  /** Task status */
  status: string;
  /** Duration in milliseconds */
  duration: number;
  /** Number of tool calls while this task was active */
  toolCallCount: number;
  /** Estimated cost attributed to this task */
  estimatedCost: number;
  /** Whether this task is a critical goal gate */
  isGoalGate?: boolean;
}

/**
 * File change item for the Session Summary view.
 */
export interface FileChangeItem {
  /** File path (shortened) */
  path: string;
  /** Lines added */
  additions: number;
  /** Lines deleted */
  deletions: number;
}

/**
 * Complete session summary data for the Summary tab.
 */
export interface SessionSummaryData {
  /** Session duration in milliseconds */
  duration: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Total estimated cost in USD */
  totalCost: number;
  /** Peak context window usage percentage */
  contextPeak: number;
  /** Number of API calls */
  apiCalls: number;
  /** Task summaries */
  tasks: TaskSummaryItem[];
  /** Task completion rate (0-1) */
  taskCompletionRate: number;
  /** Files changed during session */
  filesChanged: FileChangeItem[];
  /** Total unique files changed */
  totalFilesChanged: number;
  /** Total lines added */
  totalAdditions: number;
  /** Total lines deleted */
  totalDeletions: number;
  /** Cost breakdown by model */
  costByModel: { model: string; cost: number; percentage: number }[];
  /** Cost breakdown by tool */
  costByTool: { tool: string; estimatedCost: number; calls: number }[];
  /** Error summary */
  errors: { category: string; count: number; recovered: boolean }[];
  /** Recovery rate (0-1) */
  recoveryRate: number;
  /** AI-generated narrative (opt-in) */
  narrative?: string;
}

/**
 * Task performance data for the Task Performance panel.
 */
export interface TaskPerformanceData {
  /** Individual task details */
  tasks: {
    taskId: string;
    subject: string;
    status: string;
    duration: number;
    toolCallCount: number;
    blockedBy: string[];
    blocks: string[];
  }[];
  /** Overall completion rate (0-1) */
  completionRate: number;
  /** Average task duration in ms */
  avgDuration: number;
  /** Total tasks tracked */
  totalTasks: number;
  /** Completed tasks count */
  completedTasks: number;
  /** In-progress tasks count */
  inProgressTasks: number;
  /** Pending tasks count */
  pendingTasks: number;
}

/**
 * Cache effectiveness data for the Cache Effectiveness panel.
 */
export interface CacheEffectivenessData {
  /** Total cache read tokens */
  cacheReadTokens: number;
  /** Total cache write tokens */
  cacheWriteTokens: number;
  /** Total input tokens (non-cached) */
  totalInputTokens: number;
  /** Cache hit rate: cacheRead / (cacheRead + inputTokens) */
  cacheHitRate: number;
  /** Tokens saved by cache (cache reads that would have been full input) */
  estimatedTokensSaved: number;
  /** Cost saved vs full input pricing */
  estimatedCostSaved: number;
}

/**
 * Recovery pattern data for the Recovery Patterns panel.
 */
export interface RecoveryPatternData {
  /** Recovery patterns detected */
  patterns: {
    type: string;
    description: string;
    failedApproach: string;
    successfulApproach: string;
    occurrences: number;
  }[];
  /** Total errors in session */
  totalErrors: number;
  /** Total recoveries detected */
  totalRecoveries: number;
  /** Recovery rate (0-1) */
  recoveryRate: number;
}

/**
 * Advanced burn rate data for the Advanced Burn Rate panel.
 */
export interface AdvancedBurnRateData {
  /** Current rate in tokens/min */
  currentRate: number;
  /** Rate breakdown by model */
  rateByModel: { model: string; tokensPerMin: number }[];
  /** Projected quota exhaustion ISO timestamp, or null if safe */
  projectedQuotaExhaustion: string | null;
  /** Trend direction */
  trendDirection: 'increasing' | 'stable' | 'decreasing';
  /** Session duration in ms */
  sessionDuration: number;
}

/**
 * Extended tool efficiency data for the Tool Efficiency panel.
 */
export interface ToolEfficiencyData extends ToolAnalyticsDisplay {
  /** Estimated cost for this tool */
  estimatedCost: number;
  /** Failure rate (0-1) */
  failureRate: number;
  /** Average duration formatted as string */
  avgDurationFormatted: string;
  /** Cost per individual call */
  costPerCall: number;
}
