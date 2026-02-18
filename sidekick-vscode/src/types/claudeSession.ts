/**
 * @fileoverview Type definitions for Claude Code session events.
 *
 * This module defines types for parsing and working with Claude Code session
 * JSONL files located in ~/.claude/projects/. These types enable monitoring
 * token usage, tool calls, and session statistics from active Claude Code sessions.
 *
 * @module types/claudeSession
 */

/**
 * Token usage data from Claude API messages.
 *
 * Represents the usage field in assistant message events,
 * tracking input/output tokens and prompt caching metrics.
 */
export interface MessageUsage {
  /** Number of input tokens consumed */
  input_tokens: number;

  /** Number of output tokens generated */
  output_tokens: number;

  /** Number of tokens written to cache (1.25x input cost) */
  cache_creation_input_tokens?: number;

  /** Number of tokens read from cache (0.1x input cost) */
  cache_read_input_tokens?: number;

  /** Cost reported by the provider (used by OpenCode) */
  reported_cost?: number;

  /** Number of reasoning/thinking tokens (used by OpenCode) */
  reasoning_tokens?: number;
}

/**
 * Message object within session events.
 *
 * Contains role, model, and usage information for user/assistant messages.
 */
export interface SessionMessage {
  /** Message role (user, assistant, etc.) */
  role: string;

  /** Optional message identifier (for deduplication) */
  id?: string;

  /** Model identifier (e.g., "claude-opus-4-20250514") */
  model?: string;

  /** Token usage statistics (only present in assistant messages) */
  usage?: MessageUsage;

  /** Message content (may be string or structured content) */
  content?: unknown;
}

/**
 * Claude Code session event from JSONL log files.
 *
 * Events are logged as newline-delimited JSON in session files.
 * Each event represents a single interaction in the Claude Code session.
 */
export interface ClaudeSessionEvent {
  /** Event type discriminator */
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'summary';

  /** Message data containing role, model, usage */
  message: SessionMessage;

  /** ISO 8601 timestamp of event */
  timestamp: string;

  /** Whether this is a subagent/sidechain event */
  isSidechain?: boolean;

  /** Tool use details (when type is 'tool_use') */
  tool?: {
    name: string;
    input: Record<string, unknown>;
  };

  /** Tool result details (when type is 'tool_result') */
  result?: {
    tool_use_id: string;
    output?: unknown;
    is_error?: boolean;
  };
}

/**
 * Normalized token usage with model information.
 *
 * Provides a standardized view of token consumption with camelCase
 * naming and explicit model tracking for cost calculation.
 */
export interface TokenUsage {
  /** Number of input tokens consumed */
  inputTokens: number;

  /** Number of output tokens generated */
  outputTokens: number;

  /** Number of tokens written to cache */
  cacheWriteTokens: number;

  /** Number of tokens read from cache */
  cacheReadTokens: number;

  /** Model identifier used for this operation */
  model: string;

  /** When this usage occurred */
  timestamp: Date;

  /** Cost reported by the provider (bypasses local pricing calculation) */
  reportedCost?: number;

  /** Number of reasoning/thinking tokens */
  reasoningTokens?: number;
}

/**
 * Tool invocation record.
 *
 * Tracks tool calls made during the session for analysis
 * of extension behavior and usage patterns.
 */
export interface ToolCall {
  /** Tool name (e.g., "Read", "Write", "Bash") */
  name: string;

  /** Provider-specific tool name before canonical normalization (if available) */
  rawName?: string;

  /** Provider ID that emitted this tool call */
  providerId?: string;

  /** Tool input parameters */
  input: Record<string, unknown>;

  /** When the tool was called */
  timestamp: Date;

  /** How long the tool took to execute (milliseconds) */
  duration?: number;

  /** True if this call failed (is_error from tool_result) */
  isError?: boolean;

  /** Truncated error message if the call failed */
  errorMessage?: string;

  /** Error category (permission, not_found, timeout, syntax, exit_code, tool_error, other) */
  errorCategory?: string;
}

/**
 * Analytics for a specific tool type.
 *
 * Tracks success/failure rates and timing across all calls
 * to a particular tool (e.g., Read, Write, Bash).
 */
export interface ToolAnalytics {
  /** Tool name (e.g., "Read", "Write", "Bash") */
  name: string;

  /** Number of successful completions */
  successCount: number;

  /** Number of failed completions (is_error: true) */
  failureCount: number;

  /** Total duration across all calls (milliseconds) */
  totalDuration: number;

  /** Number of completed calls (has result) */
  completedCount: number;

  /** Number of pending calls (no result yet) */
  pendingCount: number;
}

/**
 * Entry for session activity timeline.
 *
 * Represents a single event in the chronological session history.
 */
export interface TimelineEvent {
  /** Event type for display categorization */
  type: 'user_prompt' | 'tool_call' | 'tool_result' | 'error' | 'session_start' | 'session_end' | 'assistant_response' | 'compaction';

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Human-readable description */
  description: string;

  /** Noise classification for filtering */
  noiseLevel?: 'user' | 'ai' | 'system' | 'noise';

  /** Whether this event is from a sidechain/subagent */
  isSidechain?: boolean;

  /** Optional metadata for filtering/display */
  metadata?: {
    model?: string;
    toolName?: string;
    isError?: boolean;
    tokenCount?: number;
    fullText?: string;
    /** Context tokens before compaction */
    contextBefore?: number;
    /** Context tokens after compaction */
    contextAfter?: number;
    /** Tokens reclaimed by compaction */
    tokensReclaimed?: number;
  };
}

/**
 * Pending tool call awaiting result.
 *
 * Used internally to correlate tool_use with tool_result.
 */
export interface PendingToolCall {
  /** Tool use ID for correlation */
  toolUseId: string;

  /** Tool name */
  name: string;

  /** When the tool was called */
  startTime: Date;
}

/**
 * Task status values matching Claude Code's task management.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/**
 * Tracked task from TaskCreate/TaskUpdate/TaskGet/TaskList tools.
 *
 * Represents a task in the session's task list, tracking its lifecycle
 * and associated tool calls made while the task was in progress.
 */
export interface TrackedTask {
  /** Unique task identifier assigned by Claude Code */
  taskId: string;

  /** Brief task title (from TaskCreate subject) */
  subject: string;

  /** Detailed task description */
  description?: string;

  /** Current task status */
  status: TaskStatus;

  /** When the task was created */
  createdAt: Date;

  /** When the task was last updated */
  updatedAt: Date;

  /** Present continuous form shown while task is in_progress */
  activeForm?: string;

  /** Task IDs that this task is blocked by */
  blockedBy: string[];

  /** Task IDs that this task blocks */
  blocks: string[];

  /** Tool calls made while this task was in_progress */
  associatedToolCalls: ToolCall[];

  /** Whether this task represents a subagent spawn (Task tool) */
  isSubagent?: boolean;

  /** Subagent type (e.g. "Explore", "Plan", "Bash") */
  subagentType?: string;

  /** Tool use ID for correlating spawn with completion */
  toolUseId?: string;
}

/**
 * Task state tracking for a session or subagent.
 *
 * Maintains the collection of tasks and tracks which task is currently active.
 */
export interface TaskState {
  /** Map of task IDs to tracked tasks */
  tasks: Map<string, TrackedTask>;

  /** Currently active task ID (most recently set to in_progress) */
  activeTaskId: string | null;
}

/**
 * Statistics for a subagent spawned via the Task tool.
 *
 * Tracks subagent identity and its tool calls for mind map visualization.
 */
export interface SubagentStats {
  /** Unique agent identifier (from filename, e.g., "a55af98") */
  agentId: string;

  /** Agent type (e.g., "Explore", "Plan", "Bash") */
  agentType?: string;

  /** Short description from Task tool input */
  description?: string;

  /** All tool calls made by this subagent */
  toolCalls: ToolCall[];

  /** Task state for this subagent */
  taskState?: TaskState;

  /** Total input tokens consumed by this subagent */
  inputTokens: number;

  /** Total output tokens generated by this subagent */
  outputTokens: number;

  /** Timestamp when subagent started (first event) */
  startTime?: Date;

  /** Timestamp when subagent ended (last event) */
  endTime?: Date;

  /** Duration in milliseconds */
  durationMs?: number;
}

/**
 * Pending user request awaiting assistant response.
 *
 * Tracks timing from when a user prompt is sent until the first
 * assistant response with content is received.
 */
export interface PendingUserRequest {
  /** Timestamp when the user request was sent */
  timestamp: Date;

  /** Whether the first response has been received */
  firstResponseReceived: boolean;

  /** Timestamp when the first response was received */
  firstResponseTimestamp?: Date;

  /** Time to first token in milliseconds */
  firstTokenLatencyMs?: number;
}

/**
 * Response latency for a single request-response cycle.
 *
 * Captures timing data for a complete user prompt → assistant response cycle.
 */
export interface ResponseLatency {
  /** Time to first token in milliseconds */
  firstTokenLatencyMs: number;

  /** Total time from request to final response in milliseconds */
  totalResponseTimeMs: number;

  /** Timestamp when the user request was sent */
  requestTimestamp: Date;
}

/**
 * Aggregated latency statistics.
 *
 * Provides summary metrics for response latency across the session.
 */
export interface LatencyStats {
  /** Recent latency measurements (capped at 100) */
  recentLatencies: ResponseLatency[];

  /** Average first token latency in milliseconds */
  avgFirstTokenLatencyMs: number;

  /** Maximum first token latency in milliseconds */
  maxFirstTokenLatencyMs: number;

  /** Average total response time in milliseconds */
  avgTotalResponseTimeMs: number;

  /** Most recent first token latency in milliseconds */
  lastFirstTokenLatencyMs: number | null;

  /** Number of completed request-response cycles */
  completedCycles: number;
}

/**
 * A single step in a plan extracted from plan mode.
 */
export interface PlanStep {
  /** Step identifier (e.g., "step-0", "step-1") */
  id: string;

  /** Step text/description */
  description: string;

  /** Current step status */
  status: 'pending' | 'in_progress' | 'completed';

  /** Optional phase grouping (from markdown headers) */
  phase?: string;
}

/**
 * State of a plan extracted from plan mode.
 *
 * Captures the structured plan content from Claude Code's EnterPlanMode/ExitPlanMode,
 * OpenCode's proposed_plan blocks, or Codex's UpdatePlan tool calls.
 */
export interface PlanState {
  /** Whether plan mode is currently active */
  active: boolean;

  /** Extracted plan steps */
  steps: PlanStep[];

  /** Plan title (from first H1/H2 header) */
  title?: string;

  /** When plan mode was entered */
  enteredAt?: Date;

  /** When plan mode was exited */
  exitedAt?: Date;

  /** Which provider generated the plan */
  source: 'claude-code' | 'opencode' | 'codex';
}

/**
 * Aggregated statistics for a Claude Code session.
 *
 * Provides rollup metrics for token consumption, model usage,
 * and tool activity across an entire session.
 */
export interface SessionStats {
  /** Total input tokens across all messages */
  totalInputTokens: number;

  /** Total output tokens across all messages */
  totalOutputTokens: number;

  /** Total cache write tokens across all messages */
  totalCacheWriteTokens: number;

  /** Total cache read tokens across all messages */
  totalCacheReadTokens: number;

  /** Number of messages processed */
  messageCount: number;

  /** All tool calls made during session */
  toolCalls: ToolCall[];

  /** Per-model usage breakdown */
  modelUsage: Map<string, { calls: number; tokens: number; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }>;

  /** When the session was last updated */
  lastUpdated: Date;

  /** Per-tool analytics */
  toolAnalytics: Map<string, ToolAnalytics>;

  /** Session timeline (most recent first, capped at 100) */
  timeline: TimelineEvent[];

  /** Error count by type */
  errorDetails: Map<string, string[]>;

  /** Current context window size (from most recent assistant message) */
  currentContextSize: number;

  /** Most recently observed model ID for context window estimation */
  lastModelId?: string;

  /** Recent token usage events for burn rate calculation (timestamp, tokens) */
  recentUsageEvents: Array<{ timestamp: Date; tokens: number }>;

  /** When the session started (first event timestamp) */
  sessionStartTime: Date | null;

  /** Task tracking state for the session */
  taskState?: TaskState;

  /** Plan state extracted from plan mode */
  planState?: PlanState;

  /** Response latency statistics */
  latencyStats?: LatencyStats;

  /** Compaction events that occurred during the session */
  compactionEvents?: CompactionEvent[];

  /** Estimated context token attribution by content category */
  contextAttribution?: ContextAttribution;

  /** Total cost reported by the provider (when available, e.g., OpenCode) */
  totalReportedCost?: number;
}

/**
 * Record of a context compaction event.
 *
 * Compaction occurs when the context window fills up and Claude Code
 * summarizes the conversation to reclaim space. Tracks the before/after
 * token counts to show how much context was lost.
 */
export interface CompactionEvent {
  /** When the compaction occurred */
  timestamp: Date;

  /** Context window size before compaction (tokens) */
  contextBefore: number;

  /** Context window size after compaction (tokens) */
  contextAfter: number;

  /** Tokens reclaimed (contextBefore - contextAfter) */
  tokensReclaimed: number;
}

/**
 * Categories for context token attribution.
 *
 * Breaks down where context budget is being spent.
 */
export interface ContextAttribution {
  /** Tokens from system prompts (CLAUDE.md, skills, etc.) */
  systemPrompt: number;

  /** Tokens from user messages/prompts */
  userMessages: number;

  /** Tokens from assistant responses */
  assistantResponses: number;

  /** Tokens from tool inputs (tool_use blocks) */
  toolInputs: number;

  /** Tokens from tool outputs (tool_result blocks) */
  toolOutputs: number;

  /** Tokens from thinking/reasoning blocks */
  thinking: number;

  /** Unclassified tokens */
  other: number;
}
