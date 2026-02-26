/**
 * Public API for sidekick-shared.
 */

// Session Event Types (canonical, shared across VS Code extension and CLI)
export type {
  SessionEvent,
  ClaudeSessionEvent,
  MessageUsage,
  SessionMessage,
  TokenUsage,
  ToolCall,
  ToolAnalytics,
  TimelineEvent,
  PendingToolCall,
  TaskStatus as SessionTaskStatus,
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
  PermissionMode,
  PermissionModeChange,
} from './types/sessionEvent';

// OpenCode format types
export type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodePart,
  OpenCodeTextPart,
  OpenCodeReasoningPart,
  OpenCodeToolInvocationPart,
  OpenCodeCompactionPart,
  OpenCodeDbToolPart,
  OpenCodeStepStartPart,
  OpenCodeStepFinishPart,
  OpenCodePatchPart,
  OpenCodeSubtaskPart,
  OpenCodeAgentPart,
  OpenCodeFilePart,
  OpenCodeRetryPart,
  OpenCodeSnapshotPart,
  OpenCodeProject,
  DbProject as OpenCodeDbProject,
  DbSession as OpenCodeDbSession,
  DbMessage as OpenCodeDbMessage,
  DbPart as OpenCodeDbPart,
} from './types/opencode';

// Codex format types
export type {
  CodexRolloutLine,
  CodexSessionMeta,
  CodexResponseItem,
  CodexMessageItem,
  CodexContentPart,
  CodexReasoningItem,
  CodexFunctionCallItem,
  CodexFunctionCallOutputItem,
  CodexLocalShellCallItem,
  CodexWebSearchCallItem,
  CodexCustomToolCallItem,
  CodexCustomToolCallOutputItem,
  CodexCompacted,
  CodexTurnContext,
  CodexEventMsg,
  CodexEvent,
  CodexTurnStartedEvent,
  CodexTurnCompleteEvent,
  CodexTaskStartedEvent,
  CodexTaskCompleteEvent,
  CodexTurnAbortedEvent,
  CodexTokenCountEvent,
  CodexTokenUsage,
  CodexRateLimits,
  CodexAgentMessageEvent,
  CodexAgentReasoningEvent,
  CodexUserMessageEvent,
  CodexExecCommandBeginEvent,
  CodexExecCommandEndEvent,
  CodexMcpToolCallBeginEvent,
  CodexMcpToolCallEndEvent,
  CodexErrorEvent,
  CodexContextCompactedEvent,
  CodexPatchAppliedEvent,
  CodexBackgroundEvent,
  CodexGenericEvent,
  CodexDbThread,
  CodexReasoningSummary,
} from './types/codex';

// Persistence types
export type { PersistedTask, TaskPersistenceStore, TaskStatus } from './types/taskPersistence';
export { TASK_PERSISTENCE_SCHEMA_VERSION } from './types/taskPersistence';
export type { DecisionEntry, DecisionLogStore, DecisionSource } from './types/decisionLog';
export { DECISION_LOG_SCHEMA_VERSION } from './types/decisionLog';
export type { KnowledgeNote, KnowledgeNoteStore, KnowledgeNoteType, KnowledgeNoteSource, KnowledgeNoteStatus, KnowledgeNoteImportance } from './types/knowledgeNote';
export { KNOWLEDGE_NOTE_SCHEMA_VERSION, IMPORTANCE_DECAY_FACTORS, STALENESS_THRESHOLDS } from './types/knowledgeNote';
export type { HistoricalDataStore, DailyData, MonthlyData, AllTimeStats, TokenTotals, ModelUsageRecord, ToolUsageRecord, SessionSummary } from './types/historicalData';
export { HISTORICAL_DATA_SCHEMA_VERSION, createEmptyTokenTotals } from './types/historicalData';
export type { PersistedPlan, PersistedPlanStep, PlanHistoryStore, PlanStepStatus, PlanStatus, PlanSource, PlanStepComplexity } from './types/plan';
export { PLAN_SCHEMA_VERSION, MAX_PLANS_PER_PROJECT } from './types/plan';

// Paths
export { getConfigDir, getProjectDataPath, getGlobalDataPath, encodeWorkspacePath, getProjectSlug, getProjectSlugRaw } from './paths';

// Readers
export { readTasks } from './readers/tasks';
export type { ReadTasksOptions } from './readers/tasks';
export { readDecisions } from './readers/decisions';
export type { ReadDecisionsOptions } from './readers/decisions';
export { readNotes } from './readers/notes';
export type { ReadNotesOptions } from './readers/notes';
export { readHistory } from './readers/history';
export { readLatestHandoff } from './readers/handoff';
export { readPlans, getLatestPlan, writePlans, getPlanAnalytics, readClaudeCodePlanFiles } from './readers/plans';
export type { ReadPlansOptions, PlanAnalytics } from './readers/plans';

// Providers
export type { ProviderId, SessionProvider, SessionProviderBase, SessionFileStats, SessionFileInfo, SearchHit, ProjectFolderInfo, SessionReader } from './providers/types';
export { detectProvider, getAllDetectedProviders } from './providers/detect';
export { ClaudeCodeProvider } from './providers/claudeCode';
export { OpenCodeProvider } from './providers/openCode';
export { CodexProvider } from './providers/codex';

// Parsers — JSONL
export { JsonlParser, TRUNCATION_PATTERNS } from './parsers/jsonl';
export type { RawSessionEvent, JsonlParserCallbacks } from './parsers/jsonl';

// Parsers — OpenCode
export {
  normalizeToolName,
  normalizeToolInput,
  detectPlanModeFromText,
  convertOpenCodeMessage,
  parseDbMessageData,
  parseDbPartData,
} from './parsers/openCodeParser';

// Parsers — Codex
export { CodexRolloutParser, extractPatchFilePaths, normalizeCodexToolName, normalizeCodexToolInput } from './parsers/codexParser';

// Parsers — Subagent scanning
export { scanSubagentDir, extractTaskInfo } from './parsers/subagentScanner';

// Parsers — Session activity detection
export { detectSessionActivity } from './parsers/sessionActivityDetector';
export type { SessionActivityState, SessionActivityResult } from './parsers/sessionActivityDetector';

// Parsers — Session path resolution (Claude Code)
export {
  encodeWorkspacePath as encodeClaudeWorkspacePath,
  getSessionDirectory as getClaudeSessionDirectory,
  discoverSessionDirectory,
  findActiveSession as findActiveClaudeSession,
  findAllSessions as findAllClaudeSessions,
  findSessionsInDirectory,
  findSubdirectorySessionDirs,
  getMostRecentlyActiveSessionDir,
  decodeEncodedPath,
  getAllProjectFolders as getAllClaudeProjectFolders,
  resolveWorktreeMainRepo,
  discoverWorktreeSiblings,
  findAllSessionsWithWorktrees,
} from './parsers/sessionPathResolver';

// Parsers — Subagent traces
export { scanSubagentTraces } from './parsers/subagentTraceParser';
export type { SubagentTrace, SubagentTraceEvent } from './parsers/subagentTraceParser';

// Parsers — Debug log parsing
export {
  parseDebugLog,
  filterByLevel,
  collapseDuplicates,
  discoverDebugLogs,
} from './parsers/debugLogParser';
export type { DebugLogEntry, DebugLogFile, DebugLogLevel } from './parsers/debugLogParser';

// Database wrappers
export { OpenCodeDatabase } from './providers/openCodeDatabase';
export { CodexDatabase } from './providers/codexDatabase';

// Search
export { searchSessions } from './search/sessionSearch';
export type { SearchResult } from './search/sessionSearch';

// Context
export { composeContext } from './context/composer';
export type { Fidelity, ContextResult } from './context/composer';

// Plan Extraction
export { PlanExtractor, parsePlanMarkdown as parsePlanMarkdownShared, extractProposedPlan as extractProposedPlanShared } from './parsers/planExtractor';
export type { ExtractedPlan, ExtractedPlanStep } from './parsers/planExtractor';

// Changelog Parsing
export { parseChangelog } from './parsers/changelogParser';
export type { ChangelogEntry } from './parsers/changelogParser';

// Watchers
export type { FollowEvent, FollowEventType, SessionWatcher, SessionWatcherCallbacks } from './watchers/types';
export { createWatcher } from './watchers/factory';
export type { CreateWatcherOptions } from './watchers/factory';
export { toFollowEvents } from './watchers/eventBridge';

// Formatters
export { formatToolSummary } from './formatters/toolSummary';
export {
  isHardNoise,
  isHardNoiseFollowEvent,
  getSoftNoiseReason,
  classifyMessage,
  classifyFollowEvent,
  shouldMergeWithPrevious,
  classifyNoise,
} from './formatters/noiseClassifier';
export type { MessageClassification, NoiseResult } from './formatters/noiseClassifier';
export { formatSessionText, formatSessionMarkdown, formatSessionJson } from './formatters/sessionDump';
export type { SessionDumpOptions } from './formatters/sessionDump';

// Phrases
export { ALL_PHRASES, getRandomPhrase } from './phrases';

// Aggregation
export { EventAggregator } from './aggregation/EventAggregator';
export type { SerializedAggregatorState } from './aggregation/EventAggregator';
export { saveSnapshot, loadSnapshot, deleteSnapshot, isSnapshotValid, getSnapshotPath } from './aggregation/snapshot';
export type { SessionSnapshot } from './aggregation/snapshot';
export type {
  EventAggregatorOptions,
  AggregatedTokens,
  ModelUsageStats,
  BurnRateInfo,
  SubagentLifecycle,
  AggregatedMetrics,
} from './aggregation/types';
