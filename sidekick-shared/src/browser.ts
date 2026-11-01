/**
 * Browser / webview entry.
 *
 * Pure, synchronous, filesystem-free helpers. Safe to bundle for browser
 * runtimes (VS Code webviews, web apps, etc.). Does NOT pull in node:fs,
 * node:path, or any Node-only module.
 *
 * For pricing hydration (LiteLLM catalog refresh), use `sidekick-shared/node`.
 */

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
  formatTokenBreakdown,
  summarizeTokens,
  sumTokenTotals,
  TOKEN_CONTEXT_LABEL,
  TOKEN_MAIN_THREAD_LABEL,
  TOKEN_SESSION_TOTAL_LABEL,
  TOKEN_SUBAGENTS_LABEL,
  TOKEN_TOTAL_LABEL,
} from './tokenSummary';
export type { TokenSummary, TokenTotalsLike } from './tokenSummary';
export { ClaudeUsageDeduper, SYNTHETIC_MODEL } from './usage/claudeUsageDedupe';
export {
  ASCII_CHARS_PER_TOKEN,
  estimateTextTokens,
  estimateSerializedTokens,
} from './tokenEstimation';
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
export {
  addLocalDays,
  formatDurationMs,
  formatLocalDateKey,
  formatTokenCount,
  parseLocalDateKey,
} from './formatting';
export type { FormatDurationMsOptions, FormatTokenCountOptions } from './formatting';
export { parseMcpToolName } from './parsers/mcpToolName';
export type { McpToolNameParts } from './parsers/mcpToolName';
export {
  buildSessionContextSnapshot,
  calculateSessionContextPressure,
  createSessionContextProjector,
} from './context/sessionContext';

export {
  ACCOUNT_PROVIDER_IDS,
  MODEL_PROVIDER_IDS,
  QUOTA_PROVIDER_IDS,
  RUNTIME_QUOTA_PROVIDER_IDS,
  SESSION_PROVIDER_IDS,
} from './providerIds';
export type {
  AccountProviderId,
  ModelProviderId,
  QuotaProviderId,
  RuntimeQuotaProviderId,
  SessionProviderId,
} from './providerIds';
export type {
  BuildSessionContextSnapshotOptions,
  SessionContextCapabilities,
  SessionContextLayerBreakdown,
  SessionContextPressure,
  SessionContextProjector,
  SessionContextSnapshot,
  SessionContextSource,
  SessionContextSourceType,
} from './context/sessionContext';

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
} from './modelInfo';

export type {
  ModelPricing,
  CostTokenUsage,
  CostSource,
  CostProvenanceInput,
  CostWithProvenance,
  ModelProvider,
  ParsedModelId,
  ModelInfo,
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
export {
  BILLING_BLOCK_DURATION_MS,
  computeBillingBlocks,
  findActiveBillingBlock,
} from './usage/billingBlocks';
export type {
  BillingBlock,
  BillingBlockInput,
  BillingBlockModelUsage,
  BillingBlockTokens,
  ComputeBillingBlocksOptions,
} from './usage/billingBlocks';
export { bucketUsage, summarizeUsageRows, usageBucketKey, weekKey } from './usage/usageReports';
export type {
  BucketUsageOptions,
  UsageBucketRow,
  UsageGranularity,
  UsageGroupDimension,
  UsageTotals,
} from './usage/usageReports';
export {
  applySessionSummary,
  isFileImported,
  markFileImported,
  removeSessionSummary,
  sessionSummaryFromStats,
} from './historicalStore';
export type { ApplySessionSummaryOptions, SessionSummaryFromStatsOptions } from './historicalStore';
export {
  FAILING_TOOL_TREND_ARROWS,
  failingToolTrend,
  mergeFailingToolWindows,
} from './failingTools';
export type { FailingToolTrend, FailingToolTrendRow, FailingToolWindow } from './failingTools';

export {
  diagnoseProviderFailure,
  PROVIDER_AUTHENTICATION_SOURCES,
  PROVIDER_AUTHENTICATION_STATES,
  PROVIDER_CREDENTIAL_KINDS,
  PROVIDER_FAILURE_CODES,
  PROVIDER_FAILURE_EVIDENCE_SOURCES,
  PROVIDER_RECOVERY_ACTIONS,
} from './providerFailure';
export type {
  ProviderCredentialKind,
  ProviderAuthenticationEvidence,
  ProviderFailureInput,
  ProviderFailureCode,
  ProviderRecoveryAction,
  ProviderRetryAfter,
  ProviderFailureEvidence,
  ProviderFailureDiagnosis,
} from './providerFailure';

export type {
  ProviderServiceSeverity,
  ProviderServiceComponent,
  ProviderServiceIncident,
  ProviderServiceStatusFailureReason,
  ObservedProviderServiceStatus,
  UnavailableProviderServiceStatus,
  ProviderServiceStatus,
  FetchProviderServiceStatusOptions,
} from './providerServiceStatusTypes';

// Session event and Codex rollout shapes (types only)
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

// Codex rollout parsing (pure: no filesystem access)
export {
  CodexRolloutParser,
  DEFAULT_MAX_TRACKED_TOOL_CALLS,
  extractPatchFilePaths,
  normalizeCodexToolName,
  normalizeCodexToolInput,
  resolveCodexCallUsage,
} from './parsers/codexParser';
export type { CodexRolloutParserOptions } from './parsers/codexParser';

export {
  HUMAN_CLAUDE_ENTRYPOINTS,
  HUMAN_CODEX_SOURCES,
  humanPromptText,
  isHumanPrompt,
} from './humanPrompt';
export type { HumanPromptProvider } from './humanPrompt';

export { renderHandoffUrlTemplate } from './handoffUrl';
export type { HandoffUrlIdentifiers } from './handoffUrl';

// Tool categories across providers
export { classifyTool, TOOL_CATEGORIES } from './toolCategory';
export type { ClassifyToolOptions, ToolCategory } from './toolCategory';

// Quota window helpers (pure; safe for webviews)
export {
  claudePlanLabel,
  extraQuotaRows,
  formatExtraUsage,
  quotaWindowApplies,
  quotaWindowHasData,
  quotaWindowLabel,
  quotaWindowShortLabel,
} from './quota';
export type { QuotaExtraUsage, QuotaLimitRow, QuotaWindow } from './quota';
