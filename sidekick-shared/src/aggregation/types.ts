/**
 * Aggregated metrics output types for EventAggregator.
 * Re-exports canonical types from sessionEvent and defines aggregation-specific shapes.
 */

// Re-export canonical types consumers will need
export type {
  SessionEvent,
  ClaudeSessionEvent,
  MessageUsage,
  TokenUsage,
  ToolCall,
  ToolAnalytics,
  TimelineEvent,
  PendingToolCall,
  TrackedTask,
  TaskState,
  TaskStatus,
  SubagentStats,
  PlanState,
  PlanStep,
  CompactionEvent,
  TruncationEvent,
  ContextAttribution,
  TurnAttribution,
  ContextSizePoint,
  PendingUserRequest,
  ResponseLatency,
  LatencyStats,
  SessionStats,
} from '../types/sessionEvent';

import type {
  ContextAttribution,
  CompactionEvent,
  TruncationEvent,
  ToolAnalytics,
  TimelineEvent,
  TaskState,
  PlanState,
  LatencyStats,
} from '../types/sessionEvent';

/** Configuration options for EventAggregator. */
export interface EventAggregatorOptions {
  /** Maximum timeline events to retain (default 200). */
  timelineCap?: number;
  /** Maximum latency records to retain (default 100). */
  latencyCap?: number;
  /** Burn rate sliding window in ms (default 5 * 60_000). */
  burnWindowMs?: number;
  /** Burn rate sample interval in ms (default 10_000). */
  burnSampleMs?: number;
  /** Provider-specific context size computation (default: input + cacheWrite + cacheRead). */
  computeContextSize?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    reasoningTokens?: number;
  }) => number;
  /** Provider ID for timeline events. */
  providerId?: 'claude-code' | 'opencode' | 'codex';
  /** Read a plan file from disk (fallback when Edit tool is used instead of Write). */
  readPlanFile?: (path: string) => string | null;
}

/** Token accumulation totals (aggregation-specific, includes reportedCost). */
export interface AggregatedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reportedCost: number;
}

/** Per-model usage breakdown. */
export interface ModelUsageStats {
  model: string;
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cost: number;
}

/** Burn rate info. */
export interface BurnRateInfo {
  /** Current tokens per minute. */
  tokensPerMinute: number;
  /** Sampled burn rate points for charting. */
  points: number[];
  /** Number of samples in the window. */
  sampleCount: number;
}

/** Subagent lifecycle info (for tracking spawn/completion from tool events). */
export interface SubagentLifecycle {
  id: string;
  description: string;
  subagentType: string;
  spawnTime: string;
  completionTime?: string;
  status: 'running' | 'completed';
  durationMs?: number;
}

/** Full aggregated metrics snapshot. */
export interface AggregatedMetrics {
  sessionStartTime: string | null;
  lastEventTime: string | null;
  messageCount: number;
  eventCount: number;
  currentModel: string | null;
  providerId: string | null;

  tokens: AggregatedTokens;
  modelStats: ModelUsageStats[];

  currentContextSize: number;
  contextAttribution: ContextAttribution;
  compactionCount: number;
  compactionEvents: CompactionEvent[];
  truncationCount: number;
  truncationEvents: TruncationEvent[];

  toolStats: ToolAnalytics[];
  burnRate: BurnRateInfo;

  taskState: TaskState;
  subagents: SubagentLifecycle[];
  plan: PlanState | null;

  timeline: TimelineEvent[];
  latencyStats: LatencyStats | null;
}
