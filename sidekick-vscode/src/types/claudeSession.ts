/**
 * @fileoverview Re-exports canonical session event types from sidekick-shared.
 *
 * All session event types are now defined in sidekick-shared/src/types/sessionEvent.ts.
 * This file re-exports them for backward compatibility within the VS Code extension.
 *
 * @module types/claudeSession
 */

export type {
  MessageUsage,
  SessionMessage,
  SessionEvent as ClaudeSessionEvent,
  TokenUsage,
  ToolCall,
  ToolAnalytics,
  TimelineEvent,
  PendingToolCall,
  TaskStatus,
  TrackedTask,
  TaskState,
  SubagentStats,
  PendingUserRequest,
  ResponseLatency,
  LatencyStats,
  PlanStep,
  PlanState,
  SessionStats,
  CompactionEvent,
  TruncationEvent,
  ContextAttribution,
  TurnAttribution,
  ContextSizePoint,
} from 'sidekick-shared/dist/types/sessionEvent';
