/**
 * Public API for sidekick-shared.
 */

export {
  normalizeProviderUsage,
  extractNormalizedUsage,
  calculateNormalizedUsageCost,
} from './usageNormalization';
export type {
  UsageProvider,
  UsageSemantics,
  UsageNormalizationProvenance,
  ProviderUsageInput,
  AnthropicUsageInput,
  OpenAIUsageInput,
  SidekickUsageInput,
  NormalizedUsage,
  PricingProvenance,
  NormalizedUsageCostInput,
  NormalizedUsageCost,
} from './usageNormalization';
export {
  summarizeTokens,
  sumTokenTotals,
  TOKEN_CONTEXT_LABEL,
  TOKEN_TOTAL_LABEL,
} from './tokenSummary';
export type { TokenSummary, TokenTotalsLike } from './tokenSummary';
export { estimateTextTokens, estimateSerializedTokens } from './tokenEstimation';
export type {
  ExactTokenCounterContext,
  ExactTokenCounter,
  TokenEstimationMethod,
  TokenEstimationConfidence,
  TokenEstimationOptions,
  TokenEstimate,
} from './tokenEstimation';
export { projectSessionTranscript } from './transcript';
export type {
  TranscriptFidelity,
  TranscriptSourceProvenance,
  CanonicalTranscriptBlock,
  CanonicalTranscriptMessage,
  CanonicalToolCall,
  CanonicalTranscriptUsageTotals,
  CanonicalSessionTranscript,
  ProjectSessionTranscriptOptions,
} from './transcript';
export { listRecentSessions, readSessionTranscript } from './sessionTranscripts';
export type { ProviderSessionIndex, ListRecentSessionsOptions } from './sessionTranscripts';
export {
  ObservedSessionCollector,
  observedSessionSourceFromProvider,
  fileFingerprint,
  fileFingerprintParts,
} from './observedSessionCollector';
export type {
  KnownObservedSessionFingerprint,
  ObservedSessionChange,
  ObservedSessionChangeBatch,
  ObservedSessionChangeType,
  ObservedSessionReference,
  ObservedSessionFingerprintParts,
  ObservedSessionSourceSubscribeOptions,
  ObservedSessionSubscribeOptions,
  ObservedSessionCollectionSource,
  ProviderObservedSessionCollectionSource,
  ObservedSessionDiagnosticKind,
  ObservedSessionDiagnosticPhase,
  ObservedSessionDiagnosticSeverity,
  ObservedSessionDiagnostic,
  ObservedSessionCollection,
  ObservedSessionCollectorOptions,
} from './observedSessionCollector';

// Session Event Types (canonical, shared across VS Code extension and CLI)
export type {
  SessionEvent,
  ClaudeSessionEvent,
  MessageUsage,
  SessionMessage,
  SessionEventBase,
  MessageSessionEvent,
  UserSessionEvent,
  AssistantSessionEvent,
  SummarySessionEvent,
  SystemSessionEvent,
  ToolUseSessionEvent,
  ToolResultSessionEvent,
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
export { isAggregateCodexLimit } from './types/codex';

// Persistence types
export type { PersistedTask, TaskPersistenceStore, TaskStatus } from './types/taskPersistence';
export { TASK_PERSISTENCE_SCHEMA_VERSION, normalizeTaskStatus } from './types/taskPersistence';
export type { DecisionEntry, DecisionLogStore, DecisionSource } from './types/decisionLog';
export { DECISION_LOG_SCHEMA_VERSION } from './types/decisionLog';
export type {
  KnowledgeNote,
  KnowledgeNoteStore,
  KnowledgeNoteType,
  KnowledgeNoteSource,
  KnowledgeNoteStatus,
  KnowledgeNoteImportance,
} from './types/knowledgeNote';
export {
  KNOWLEDGE_NOTE_SCHEMA_VERSION,
  IMPORTANCE_DECAY_FACTORS,
  STALENESS_THRESHOLDS,
} from './types/knowledgeNote';
export type {
  HistoricalDataStore,
  DailyData,
  HourlyData,
  MonthlyData,
  AllTimeStats,
  TokenTotals,
  ModelUsageRecord,
  ToolUsageRecord,
  SessionSummary,
  SessionHistoryRecord,
} from './types/historicalData';
export {
  HISTORICAL_DATA_SCHEMA_VERSION,
  HISTORICAL_SESSION_RETENTION_LIMIT,
  createEmptyTokenTotals,
  createEmptyDataStore,
} from './types/historicalData';
export type {
  PersistedPlan,
  PersistedPlanStep,
  PlanHistoryStore,
  PlanStepStatus,
  PlanStatus,
  PlanSource,
  PlanStepComplexity,
} from './types/plan';
export { PLAN_SCHEMA_VERSION, MAX_PLANS_PER_PROJECT } from './types/plan';

// Paths
export {
  CONFIG_DIR_ENV_VAR,
  getConfigDir,
  getConfigDirOverride,
  getDefaultConfigDir,
  setConfigDir,
  getProjectDataPath,
  getGlobalDataPath,
  encodeWorkspacePath,
  getProjectSlug,
  getProjectSlugRaw,
  resolveProjectIdentity,
} from './paths';
export type { ProjectIdentity } from './paths';
export { migrateLegacyProjectStores } from './projectMigration';

// Readers
export { readTasks } from './readers/tasks';
export type { ReadTasksOptions } from './readers/tasks';
export { readDecisions } from './readers/decisions';
export type { ReadDecisionsOptions } from './readers/decisions';
export { readNotes } from './readers/notes';
export type { ReadNotesOptions } from './readers/notes';
export { readHistory } from './readers/history';
export { readLatestHandoff } from './readers/handoff';
export {
  readPlans,
  getLatestPlan,
  writePlans,
  getPlanAnalytics,
  readClaudeCodePlanFiles,
} from './readers/plans';
export type { ReadPlansOptions, PlanAnalytics } from './readers/plans';

// Atomic persistence writers
export {
  atomicWriteJson,
  atomicWriteJsonSync,
  atomicWriteFileSync,
  updateJsonStoreAtomic,
  updateJsonStoreAtomicSync,
  withFileLockSync,
} from './writers/atomic';
export { addTask, completeTask } from './writers/tasks';
export { addDecision, decisionFingerprint } from './writers/decisions';
export { addNote } from './writers/notes';
export { renderHandoffUrlTemplate } from './handoffUrl';
export type { HandoffUrlIdentifiers } from './handoffUrl';

// Providers
export type {
  ProviderId,
  SessionProvider,
  SessionProviderBase,
  SessionFileStats,
  SessionFileInfo,
  SearchHit,
  ProjectFolderInfo,
  SessionReader,
  SessionProviderOptions,
  ProviderOperationStatus,
  SessionProviderDiagnostic,
  SessionProviderDiagnosticKind,
  SessionProviderDiagnosticPhase,
  SessionProviderDiagnosticSeverity,
  ProviderRuntimeStatus,
} from './providers/types';
export { SESSION_PROVIDER_IDS } from './providers/types';
export { createSessionProviders } from './providers/factory';
export type {
  CreateSessionProvidersOptions,
  CreateSessionProvidersResult,
} from './providers/factory';
export {
  createProviderSessionAdapterV1,
  derivePendingUserRequestV1,
} from './types/observedSessionV1';
export type {
  ObservationProvenanceV1,
  ObservedAgentSessionV1,
  ObservedValueV1,
  PendingUserRequestV1,
  ProviderCapabilitiesV1,
  ProviderSessionAdapterV1,
  ProviderSessionAdapterV1Options,
  SessionEvidenceRefV1,
} from './types/observedSessionV1';
export {
  _resetProviderDetectionCache,
  detectProvider,
  getAllDetectedProviders,
} from './providers/detect';
export { ClaudeCodeProvider } from './providers/claudeCode';
export { OpenCodeProvider, getOpenCodeDataDir } from './providers/openCode';
export { CodexProvider, findCodexRolloutFile } from './providers/codex';
export type { FindCodexRolloutFileOptions } from './providers/codex';

// Parsers — JSONL
export { JsonlParser, TRUNCATION_PATTERNS } from './parsers/jsonl';
export type { RawSessionEvent, JsonlParserCallbacks, JsonlParserOptions } from './parsers/jsonl';

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
export {
  CodexRolloutParser,
  extractPatchFilePaths,
  normalizeCodexToolName,
  normalizeCodexToolInput,
} from './parsers/codexParser';

// Parsers — Subagent scanning
export { scanSubagentDir, extractTaskInfo } from './parsers/subagentScanner';

// Parsers — Session activity detection
export {
  detectSessionActivity,
  refreshSessionActivityState,
} from './parsers/sessionActivityDetector';
export type {
  SessionActivityState,
  SessionActivityResult,
} from './parsers/sessionActivityDetector';

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

// Parsers — MCP tool names
export { parseMcpToolName } from './parsers/mcpToolName';
export type { McpToolNameParts } from './parsers/mcpToolName';

// Parsers — Codex native history
export { readCodexHistory } from './parsers/codexHistory';
export type { CodexHistoryEntry, ReadCodexHistoryOptions } from './parsers/codexHistory';

// Session previews (bounded, stat-first)
export {
  listSessionPreviews,
  listSessionPreviewsAsync,
  readSessionPreview,
  readSessionPreviewAsync,
} from './sessionPreviews';
export type {
  AsyncSessionPreviewOptions,
  ListSessionPreviewsAsyncOptions,
  ListSessionPreviewsOptions,
  ReadSessionPreviewAsyncOptions,
  ReadSessionPreviewOptions,
  SessionPreview,
  SessionPreviewListResult,
  SessionPreviewReadResult,
} from './sessionPreviews';

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
export { FilterEngine } from './search/advancedFilter';
export type {
  FilterMode,
  FilterState,
  HighlightFormat as FilterHighlightFormat,
} from './search/advancedFilter';

// Context
export { composeContext } from './context/composer';
export type { Fidelity, ContextResult } from './context/composer';
export {
  buildSessionContextSnapshot,
  calculateSessionContextPressure,
  createSessionContextProjector,
  readSessionContextSnapshot,
} from './context/sessionContext';
export type {
  BuildSessionContextSnapshotOptions,
  ReadSessionContextSnapshotOptions,
  SessionContextCapabilities,
  SessionContextLayerBreakdown,
  SessionContextPressure,
  SessionContextProjector,
  SessionContextSnapshot,
  SessionContextSource,
  SessionContextSourceType,
} from './context/sessionContext';

// Assistant turn projection
export {
  assistantTurnEventsFromSessionEvents,
  extractTurnSubagents,
  isAssistantTurnSubagentTool,
  reasoningSummary,
  segmentAssistantTurn,
} from './turns/assistantTurn';
export type {
  AssistantTurnEvent,
  AssistantTurnEventType,
  AssistantTurnProcess,
  AssistantTurnProcessStep,
  AssistantTurnProjection,
  AssistantTurnSubagent,
  AssistantTurnSubagentStatus,
  AssistantTurnTimelineItem,
  AssistantTurnToolRef,
  ExtractTurnSubagentsOptions,
  ReasoningSummary,
  SegmentAssistantTurnOptions,
} from './turns/assistantTurn';

// Plan Extraction
export {
  PlanExtractor,
  parsePlanMarkdown as parsePlanMarkdownShared,
  extractProposedPlan as extractProposedPlanShared,
} from './parsers/planExtractor';
export type { ExtractedPlan, ExtractedPlanStep } from './parsers/planExtractor';

// Changelog Parsing
export { parseChangelog } from './parsers/changelogParser';
export type { ChangelogEntry } from './parsers/changelogParser';

// Watchers
export type {
  FollowEvent,
  FollowEventType,
  SessionWatcher,
  SessionWatcherCallbacks,
} from './watchers/types';
export { createWatcher } from './watchers/factory';
export type { CreateWatcherOptions } from './watchers/factory';
export { toFollowEvents } from './watchers/eventBridge';
export { createJsonlTail } from './watchers/jsonlTail';
export type { JsonlTail, JsonlTailBatch, JsonlTailOptions } from './watchers/jsonlTail';

// Formatters
export {
  addLocalDays,
  formatDurationMs,
  formatLocalDateKey,
  formatTokenCount,
  parseLocalDateKey,
} from './formatting';
export type { FormatDurationMsOptions, FormatTokenCountOptions } from './formatting';
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
export {
  formatSessionText,
  formatSessionMarkdown,
  formatSessionJson,
} from './formatters/sessionDump';
export type { SessionDumpOptions } from './formatters/sessionDump';
export {
  highlight as highlightEvent,
  clearHighlightCache,
  HIGHLIGHT_CSS,
} from './formatters/eventHighlighter';
export type { HighlightFormat } from './formatters/eventHighlighter';

// Phrases
export { ALL_PHRASES, PHRASE_CATEGORIES, getRandomPhrase } from './phrases';
export type { PhraseCategory } from './phrases';

// Aggregation
export { EventAggregator, parseTodoDependencies } from './aggregation/EventAggregator';
export { SessionMonitor } from './sessionMonitor';
export type { SessionMonitorOptions, SessionMonitorSubscribeOptions } from './sessionMonitor';
export type { SerializedAggregatorState } from './aggregation/EventAggregator';
export {
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
  isSnapshotValid,
  pruneSnapshots,
  MAX_SNAPSHOT_FILES,
  getSnapshotPath,
} from './aggregation/snapshot';
export type { SessionSnapshot } from './aggregation/snapshot';
export type {
  EventAggregatorOptions,
  AggregatedCostProvenance,
  AggregatedTokens,
  ModelUsageStats,
  BurnRateInfo,
  SubagentLifecycle,
  AggregatedMetrics,
  FrequencyMetric,
  PatternMetric,
  HeatmapBucketMetric,
  ErrorRollup,
  ErrorRollupEntry,
  ErrorBucketMetric,
} from './aggregation/types';
export {
  ERROR_HISTORY_SCHEMA_VERSION,
  MAX_ERROR_HISTORY_SESSIONS,
  appendErrorHistory,
  getTopFailingTools,
  readErrorHistory,
} from './errorHistory';
export type { ErrorHistorySessionRecord, ErrorHistoryStore, TopFailingTool } from './errorHistory';

// Aggregation — analytics engines
export { FrequencyTracker } from './aggregation/FrequencyTracker';
export type { FrequencyEntry, SerializedFrequencyState } from './aggregation/FrequencyTracker';
export { HeatmapTracker } from './aggregation/HeatmapTracker';
export type { HeatmapBucket, SerializedHeatmapState } from './aggregation/HeatmapTracker';
export { PatternExtractor } from './aggregation/PatternExtractor';
export type { PatternCluster, SerializedPatternState } from './aggregation/PatternExtractor';
export { calculateQualityTrend, scoreSessionQuality } from './analytics/qualityScore';
export type {
  QualityFactorContribution,
  QualityFactorId,
  SessionQualityScore,
  QualityTrend,
} from './analytics/qualityScore';
export { calculateCodeImpact } from './analytics/codeImpact';
export type { CodeImpact, ModelCostInput } from './analytics/codeImpact';
export { classifyCostProvenance, describeCostProvenance } from './aggregation/costProvenance';
export type { AggregatedCostProvenanceInput } from './aggregation/costProvenance';
export { calculateCompactionLedger, formatCompactionLedger } from './analytics/compactionLedger';
export type { CompactionLedger } from './analytics/compactionLedger';

// Report — HTML session report generation
export {
  generateHtmlReport,
  parseTranscript,
  parseTranscriptFromEvents,
  openInBrowser,
} from './report';
export type { TranscriptContentBlock, TranscriptEntry, HtmlReportOptions } from './report';

// Credential I/O (platform-aware: Keychain on macOS, file on Linux/Windows)
export { readActiveCredentials, writeActiveCredentials } from './credentialIO';

// Credentials
export { readClaudeMaxCredentials, readClaudeMaxAccessTokenSync } from './credentials';
export type { ClaudeMaxCredentials } from './credentials';

// Accounts
export { ensureDefaultAccounts } from './ensureDefaultAccounts';
export type {
  EnsureDefaultAccountStatus,
  EnsureDefaultAccountsOptions,
  EnsureDefaultAccountsResult,
} from './ensureDefaultAccounts';
export {
  readAccountRegistry,
  writeAccountRegistry,
  readActiveClaudeAccount,
  addCurrentAccount,
  switchToAccount,
  resolveActiveClaudeHome,
  applyActiveClaudeToLiveHome,
  reconcileClaudeAuthState,
  removeAccount,
  listAccounts,
  getActiveAccount,
  resolveActiveClaudeAccount,
  isMultiAccountEnabled,
} from './accounts';
export type {
  AccountEntry,
  AccountRegistry,
  ActiveAccountInfo,
  AccountManagerResult,
} from './accounts';
export {
  beginAccountLogin,
  getAccountLoginStatus,
  getAccountLoginStatusAsync,
  finalizeAccountLogin,
  finalizeAccountLoginAsync,
  spawnAccountLogin,
  switchAccount,
  switchAccountAsync,
  listAllAccounts,
  resolveClaudeLoginCommand,
} from './accountManager';
export type {
  AccountLoginCommand,
  AccountLoginState,
  AccountLoginStatus,
  BeginAccountLoginResult,
  FinalizeAccountLoginOptions,
  ListAllAccountsResult,
  SpawnAccountLoginOptions,
} from './accountManager';
export {
  getAccountsDir,
  readSavedAccountRegistry,
  writeSavedAccountRegistry,
  listSavedAccountProfiles,
  getActiveSavedAccount,
  upsertSavedAccountProfile,
  setActiveSavedAccount,
  replaceSavedAccountProfiles,
  removeSavedAccountProfile,
} from './accountRegistry';
export type {
  AccountProviderId,
  AccountIdentityMetadata,
  ResolvedActiveAccount,
  SavedAccountProfile,
  SavedAccountRegistry,
} from './accountRegistry';
export { ACCOUNT_PROVIDER_IDS } from './accountRegistry';
export { getActiveAccountStatus } from './accountStatus';
export type {
  ActiveAccountStatus,
  ActiveAccountStatusOptions,
  ActiveProviderAccountStatus,
} from './accountStatus';
export { onAccountsChanged } from './accountChanges';
export type { AccountsChangedEvent, OnAccountsChangedOptions } from './accountChanges';
export {
  getClaudeProfilesDir,
  getClaudeProfileHome,
  claudeKeychainSuffix,
  claudeKeychainService,
  isClaudeProfileAuthenticated,
  readClaudeProfileIdentity,
} from './claudeProfiles';
export type { ClaudeProfileIdentity } from './claudeProfiles';
export {
  getCodexProfilesDir,
  getCodexProfileHome,
  getCodexMonitoringHomes,
  getSystemCodexHome,
  listCodexAccounts,
  getActiveCodexAccount,
  resolveActiveCodexAccount,
  resolveSidekickCodexHome,
  getCodexExecutionEnv,
  prepareCodexAccount,
  prepareCodexAccountAsync,
  finalizeCodexAccount,
  finalizeCodexAccountAsync,
  switchToCodexAccount,
  switchToCodexAccountAsync,
  removeCodexAccount,
} from './codexProfiles';
export type { CodexAccountManagerResult } from './codexProfiles';
export {
  setTerminalActiveProfile,
  installShellHook,
  uninstallShellHook,
  isShellHookInstalled,
  writeLauncher,
  removeLauncher,
} from './terminalSync';
export { DEFAULT_AUTO_SWITCH_CONFIG, decideAutoSwitch, AutoSwitchController } from './autoSwitch';
export type {
  AutoSwitchActiveAccount,
  AutoSwitchCandidate,
  AutoSwitchConfig,
  AutoSwitchControllerOptions,
  AutoSwitchDecision,
  AutoSwitchTransitionEvent,
} from './autoSwitch';

// Quota
export {
  FIVE_HOUR_WINDOW_MS,
  QUOTA_PROVIDER_IDS,
  SEVEN_DAY_WINDOW_MS,
  fetchQuota,
  projectQuotaWindow,
  withQuotaProjections,
} from './quota';
export type {
  CodexResetCredit,
  CodexResetCreditsSnapshot,
  QuotaProjectionInput,
  QuotaProviderId,
  QuotaWindow,
  QuotaState,
} from './quota';
export { describeQuotaFailure } from './quotaPresentation';
export type { QuotaFailureDescriptor } from './quotaPresentation';
export { QuotaPoller } from './quotaPoller';
export type { QuotaPollerOptions } from './quotaPoller';
export { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
export type { QuotaSnapshotRecord } from './quotaSnapshots';
export { resolveQuota } from './quotaResolver';
export type {
  QuotaResolution,
  QuotaResolveProviderId,
  ResolveQuotaOptions,
  ResolvedQuota,
} from './quotaResolver';
export {
  classifyQuotaFreshness,
  formatQuotaAge,
  QUOTA_AGING_MAX_AGE_MS,
  QUOTA_FRESH_MAX_AGE_MS,
} from './quota';
export type { QuotaFreshness } from './quota';
export {
  DEFAULT_QUOTA_THRESHOLDS,
  describeQuotaThresholdAlert,
  evaluateQuotaThresholds,
} from './quotaThresholds';
export type {
  QuotaAlertMemory,
  QuotaThresholdAlert,
  QuotaThresholdConfig,
  QuotaThresholdEvaluation,
  QuotaThresholdWindow,
} from './quotaThresholds';
export {
  parseClaudeStatuslinePayload,
  quotaFromStatuslinePayload,
} from './statusline/claudeStatuslinePayload';
export type {
  ClaudeStatuslinePayload,
  ClaudeStatuslineRateLimitWindow,
  QuotaFromStatuslineOptions,
} from './statusline/claudeStatuslinePayload';
export {
  appendQuotaHistorySample,
  readQuotaHistoryRange,
  readQuotaHistoryDailyBuckets,
  pruneQuotaHistory,
  getWorkspaceIdFromPath,
} from './quotaHistory';
export type {
  QuotaHistorySample,
  QuotaHistoryAppendOptions,
  QuotaHistoryRangeOptions,
  QuotaHistoryDailyBucket,
  QuotaHistoryRuntimeProvider,
} from './quotaHistory';
export {
  fetchCodexResetCreditsFromApi,
  fetchCodexQuotaFromApi,
  quotaFromCodexRateLimits,
  readLatestCodexQuotaFromRollouts,
  resolveCodexQuota,
  resolveCodexQuotaFromLocalSources,
} from './codexQuota';
export type {
  CodexQuotaApiOptions,
  CodexQuotaCreditsSnapshot,
  CodexQuotaResolveOptions,
  CodexQuotaResolveSource,
} from './codexQuota';
export { CodexQuotaWatcher } from './codexQuotaWatcher';
export type { CodexQuotaWatcherOptions } from './codexQuotaWatcher';
export {
  fetchZaiQuotaFromApi,
  quotaStateFromZaiQuotaLimitPayload,
  readZaiCredentials,
  resolveZaiQuota,
} from './zaiQuotaApi';
export type {
  ReadZaiCredentialsOptions,
  ZaiCredentialSource,
  ZaiCredentials,
  ZaiPlatform,
  ZaiQuotaApiOptions,
  ZaiQuotaResolveOptions,
} from './zaiQuotaApi';
export { MultiProviderQuotaService } from './multiProviderQuotaService';
export type { MultiProviderQuotaServiceOptions } from './multiProviderQuotaService';
export { RUNTIME_QUOTA_PROVIDER_IDS } from './providerQuota';
export type { ProviderQuotaMap, ProviderQuotaState, RuntimeQuotaProvider } from './providerQuota';
export type { QuotaSnapshotProviderId } from './quotaSnapshots';
export { BurnRateCalculator, estimateTimeToQuota } from './statusline/BurnRateCalculator';
export { formatStatusline, selectStatuslineAccount } from './statusline/formatter';
export type { StatuslineInput, StatuslineSelection } from './statusline/formatter';

// Model Context
export {
  getModelContextWindowSize,
  resolveModelContextWindow,
  DEFAULT_CONTEXT_WINDOW,
} from './modelContext';
export type {
  ModelCatalogMatch,
  ModelContextWindowProvenance,
  ModelContextWindowSource,
  ResolvedModelContextWindow,
} from './modelContext';

// Model Info & Pricing
export {
  parseModelId,
  getModelPricing,
  resolveModelPricing,
  getModelInfo,
  calculateCost,
  calculateCostWithPricing,
  calculateCostWithProvenance,
  mergeCostSources,
  shortModelName,
  getModelDisplayInfo,
  compareModelIds,
  sortModelIds,
  formatCost,
  MODEL_PROVIDER_IDS,
} from './modelInfo';
export type {
  ModelPricing,
  CostTokenUsage,
  CostSource,
  CostProvenanceInput,
  CostWithProvenance,
  ModelInfo,
  ModelProvider,
  ParsedModelId,
  ModelDisplayInfo,
  ModelPricingMatch,
  ModelPricingProvenance,
  ModelPricingSource,
  ResolvedModelPricing,
} from './modelInfo';

export {
  exportResolvedModelCatalog,
  importResolvedModelCatalog,
  registerModelAlias,
  resolveModelAlias,
  RESOLVED_MODEL_CATALOG_SCHEMA_VERSION,
} from './modelCatalog';
export type {
  ImportResolvedModelCatalogResult,
  ResolvedModelCatalogEntry,
  ResolvedModelCatalogSnapshot,
} from './modelCatalog';

// Pricing Catalog (LiteLLM hydration) — Node-only. Safe for extension host
// and CLI; do NOT import from browser bundles (webviews).
export {
  hydratePricingCatalog,
  normalizeLiteLlmCatalog,
  normalizeLiteLlmContextWindows,
  LITELLM_CATALOG_URL,
} from './pricingCatalog';
export type { HydrateOptions, HydrateResult } from './pricingCatalog';

// Observed context windows (provider-reported, persisted) — Node-only.
export {
  loadObservedContextWindows,
  recordObservedContextWindow,
  getObservedContextWindowPath,
} from './observedContextWindows';
export type {
  ObservedContextWindowOptions,
  ObservedContextWindowStore,
} from './observedContextWindows';

// Extractors — per-event token usage and tool call extraction
export { extractTokenUsage } from './extractors/tokenUsage';
// Extractors — actionable session assets. Node-only: safe for CLI and
// extension-host code, not for browser/webview bundles.
export { extractUrls, extractFilePaths, extractCommands } from './extractors/sessionAssets';
export type {
  AssetAgent,
  ExtractedAsset,
  ExtractedAssetProvenance,
  ExtractedAssetType,
  ExtractedAssets,
  SourceAssets,
} from './extractors/sessionAssets';
export { readClaudeAssets, claudeSessions } from './extractors/sources/claudeAssets';
export { readCodexAssets, codexSessions } from './extractors/sources/codexAssets';
export { gatherAssetsForCwd } from './extractors/gatherAssets';
export { categorizeError, extractErrorMessage } from './extractors/errorTaxonomy';
export type { ErrorCategory } from './extractors/errorTaxonomy';
export { extractToolCall, extractToolCalls, ToolCallTracker } from './extractors/toolCall';
export type { GatherAssetsOptions, GatherAssetsResult } from './extractors/gatherAssets';

// Schemas — Zod runtime validation for session events
export {
  messageUsageSchema,
  sessionMessageSchema,
  sessionEventSchema,
  permissionModeSchema,
  extractSessionEvents,
} from './schemas/sessionEvent';

// Schemas — Zod runtime validation for quota / provider quota / peak hours
export {
  quotaWindowSchema,
  quotaStateSchema,
  quotaFailureKindSchema,
  quotaProviderIdSchema,
  quotaSourceSchema,
  codexResetCreditSchema,
  codexResetCreditsSnapshotSchema,
  peakHoursStateSchema,
  quotaFailureDescriptorSchema,
  runtimeQuotaProviderSchema,
  providerQuotaStateSchema,
  claudeProviderQuotaStateSchema,
  codexProviderQuotaStateSchema,
  zaiProviderQuotaStateSchema,
  providerQuotaMapSchema,
} from './schemas/quota';

// Schemas — Zod runtime validation for quota history
export {
  quotaHistoryRuntimeProviderSchema,
  quotaHistorySampleSchema,
  quotaHistoryDailyBucketSchema,
} from './schemas/quotaHistory';

// Schemas — Zod runtime validation for account status
export {
  activeProviderAccountStatusSchema,
  activeAccountStatusSchema,
} from './schemas/accountStatus';
export {
  accountProviderIdSchema,
  accountManagerResultSchema,
  beginAccountLoginResultSchema,
  accountLoginStatusSchema,
  accountEntrySchema,
  savedAccountProfileSchema,
  listAllAccountsResultSchema,
} from './schemas/accountManager';
export {
  assistantTurnEventSchema,
  assistantTurnEventTypeSchema,
  assistantTurnNarrationStepSchema,
  assistantTurnProcessSchema,
  assistantTurnProcessStepSchema,
  assistantTurnProjectionSchema,
  assistantTurnReasoningTimelineItemSchema,
  assistantTurnSubagentSchema,
  assistantTurnSubagentStatusSchema,
  assistantTurnTimelineItemSchema,
  assistantTurnToolGroupStepSchema,
  assistantTurnToolRefSchema,
} from './schemas/assistantTurn';

// Provider Status
export { fetchProviderStatus, fetchOpenAIStatus } from './providerStatus';
export type { ProviderStatusState } from './providerStatus';

// Shared diagnostics / health report
export { formatHealthReport, getSessionDiagnostics, runDoctor } from './doctor';
export type {
  DeprecatedSetting,
  DoctorOptions,
  HealthCheck,
  HealthCheckStatus,
  HealthReport,
  SessionDiagnostics,
} from './doctor';

// Peak Hours (PromoClock — third-party)
export {
  _resetPeakHoursCache,
  createPeakHoursNotApplicableState,
  DEFAULT_PEAK_HOURS_TIMEOUT_MS,
  fetchPeakHoursStatus,
  getScheduledPeakHoursState,
  isClaudeCodeSessionProvider,
  PEAK_HOURS_CACHE_MS,
  PEAK_HOURS_DESCRIPTION,
  scopePeakHoursToSessionProvider,
} from './peakHours';
export type { FetchPeakHoursOptions, PeakHoursState } from './peakHours';
