/**
 * Node-only entry.
 *
 * Pricing catalog hydration from the LiteLLM source. Requires `node:fs`
 * and `node:path`; safe for extension-host and CLI consumers. Not safe
 * for browser bundles — use `sidekick-shared/browser` there.
 */

export {
  hydratePricingCatalog,
  normalizeLiteLlmCatalog,
  normalizeLiteLlmContextWindows,
  LITELLM_CATALOG_URL,
} from './pricingCatalog';

export type { HydrateOptions, HydrateResult } from './pricingCatalog';
export {
  loadObservedContextWindows,
  recordObservedContextWindow,
  getObservedContextWindowPath,
} from './observedContextWindows';
export type {
  ObservedContextWindowOptions,
  ObservedContextWindowStore,
} from './observedContextWindows';
export { listRecentSessions, readSessionTranscript } from './sessionTranscripts';
export {
  collectPromptHistory,
  isPromptHistorySessionSettled,
  parsePromptHistoryCursor,
  PROMPT_HISTORY_ORDINAL_MAX_RECORD_BYTES,
} from './promptHistory';
export { findToolCallOrigins } from './toolCallOrigins';
export type { FindToolCallOriginsOptions, ToolCallOrigin } from './toolCallOrigins';
export type {
  CollectPromptHistoryOptions,
  PromptHistoryAnswerState,
  PromptHistoryBound,
  PromptHistoryBounds,
  PromptHistoryCursor,
  PromptHistoryCursorSession,
  PromptHistoryEntry,
  PromptHistoryExclusion,
  PromptHistoryMetadataStatus,
  PromptHistoryPendingPrompt,
  PromptHistoryProvider,
  PromptHistoryResult,
  PromptHistoryResumeState,
  PromptHistoryStats,
  PromptHistoryUsage,
} from './promptHistory';
export { collectSessionPromptHistory } from './sessionPromptHistory';
export type {
  CollectSessionPromptHistoryOptions,
  PromptHistorySession,
  PromptHistorySessionPrompt,
  PromptHistorySessionRef,
  SessionPromptHistoryBound,
  SessionPromptHistoryBounds,
  SessionPromptHistoryInclude,
  SessionPromptHistoryResult,
  SessionPromptHistoryStats,
} from './sessionPromptHistory';
export type {
  PromptHistoryReply,
  PromptHistorySignal,
  PromptHistorySignalKind,
} from './sessionPromptSignals';
export {
  HUMAN_CLAUDE_ENTRYPOINTS,
  HUMAN_CODEX_SOURCES,
  humanPromptText,
  isHumanPrompt,
} from './humanPrompt';
export type { HumanPromptProvider } from './humanPrompt';
export {
  computeSessionFileStats,
  firstUserPrompt,
  providerContextSizeFn,
  readSessionFileStats,
} from './sessionStats';
export { readSessionReportInputs } from './report/sessionReportInputs';
export type { SessionReportInputs } from './report/sessionReportInputs';
export { fingerprintString, sessionFingerprintParts } from './sessionFingerprint';
export {
  STATE_FILE_NAME,
  STATE_FILE_SCHEMA_VERSION,
  billingBlockToStateFile,
  getStateFilePath,
  quotaToStateFile,
  readStateFile,
  writeStateFile,
} from './stateFile';
export type {
  SidekickStateFile,
  SidekickStateInput,
  StateFileAccount,
  StateFileBillingBlock,
  StateFileContext,
  StateFileQuota,
  StateFileQuotaWindow,
  StateFileSession,
  StateFileWriter,
  WriteStateFileOptions,
} from './stateFile';
export type { ComputeSessionFileStatsOptions, ReadSessionFileStatsOptions } from './sessionStats';
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
export {
  MAX_USAGE_CACHE_FILES,
  USAGE_CACHE_VERSION,
  collectUsageEvents,
  getUsageCacheDir,
  pruneUsageCache,
} from './usage/usageEvents';
export type {
  CollectUsageEventsOptions,
  CollectUsageEventsResult,
  UsageEventRecord,
  UsageSessionRecord,
} from './usage/usageEvents';
export {
  collectSessionTokenTotals,
  combineSessionTokenTotals,
  readMainThreadTokenTotals,
  scanSessionSubagents,
  subagentTokenTotals,
} from './sessionTokenTotals';
export type { SessionTokenTotals, SubagentTokenSummary } from './sessionTokenTotals';
export {
  applySessionSummary,
  isFileImported,
  markFileImported,
  removeSessionSummary,
  sessionSummaryFromStats,
} from './historicalStore';
export type { ApplySessionSummaryOptions, SessionSummaryFromStatsOptions } from './historicalStore';
export {
  ACTIVE_SESSION_MTIME_THRESHOLD_MS,
  importSessionHistory,
} from './usage/importSessionHistory';
export type {
  ImportSessionHistoryOptions,
  ImportSessionHistoryResult,
} from './usage/importSessionHistory';
export { bucketUsage, summarizeUsageRows, usageBucketKey, weekKey } from './usage/usageReports';
export type {
  BucketUsageOptions,
  UsageBucketRow,
  UsageGranularity,
  UsageGroupDimension,
  UsageTotals,
} from './usage/usageReports';
export type { ProviderSessionIndex, ListRecentSessionsOptions } from './sessionTranscripts';
export { findCodexRolloutFile } from './providers/codex';
export { walkRolloutFiles, walkRolloutFilesAsync } from './providers/rolloutWalker';
export type { RolloutFileInfo, WalkRolloutFilesOptions } from './providers/rolloutWalker';
export type { FindCodexRolloutFileOptions } from './providers/codex';
export { readCodexHistory } from './parsers/codexHistory';
export type { CodexHistoryEntry, ReadCodexHistoryOptions } from './parsers/codexHistory';
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
  ObservedSessionCollectOptions,
  ObservedSessionDiscoverOptions,
  ObservedSessionDiscoveryStats,
  ObservedSessionDiscoveryTrigger,
  ObservedSessionSourceSignal,
  ObservedSessionSourceListener,
  ObservedSessionResolution,
} from './observedSessionCollector';
export { DirectoryListingCache, splitWatchedPath } from './providers/directoryListingCache';
export type {
  CachedDirectoryListing,
  CachedFileStat,
  DirectoryListingCacheOptions,
  DirectoryListingCounters,
  ListDirectoryOptions,
} from './providers/directoryListingCache';
export type {
  ListSessionFilesOptions,
  ProviderId,
  SessionEnumerationCounters,
  SessionProviderBase,
  SessionProviderDiagnostic,
  WatchedSessionFile,
} from './providers/types';
export { createSessionProviders } from './providers/factory';
export type {
  CreateSessionProvidersOptions,
  CreateSessionProvidersResult,
} from './providers/factory';
export { SYNTHETIC_MODEL } from './usage/claudeUsageDedupe';

// Sidekick's config root
export {
  CONFIG_DIR_ENV_VAR,
  getConfigDir,
  getConfigDirOverride,
  getDefaultConfigDir,
} from './paths';

// Claude Code session directories (Claude's own path encoding)
export {
  encodeWorkspacePath as encodeClaudeWorkspacePath,
  getSessionDirectory as getClaudeSessionDirectory,
} from './parsers/sessionPathResolver';

// Provider homes the CLIs read for this process
export {
  getLiveClaudeHome,
  getDefaultClaudeHome,
  isDefaultClaudeHome,
  getClaudeProjectsDir,
} from './claudePaths';
export {
  getSystemCodexHome,
  getCodexMonitoringHomes,
  resolveSidekickCodexHome,
  getCodexExecutionEnv,
  getCodexSessionsDirs,
  getCodexCredentialStoreMode,
  forceFileCredentialStore,
  CODEX_SESSIONS_SUBDIR,
  CODEX_ARCHIVED_SESSIONS_SUBDIR,
} from './codexPaths';
export type { CodexCredentialStoreMode, CodexSessionsDirsOptions } from './codexPaths';
export {
  parseAuthJson as parseCodexAuthJson,
  readAuthIdentityFromRaw as readCodexAuthIdentity,
  readLastRefresh as readCodexLastRefresh,
  readAccessTokenExpiry as readCodexAccessTokenExpiry,
  identitiesMatch as codexIdentitiesMatch,
  codexRefreshFingerprint,
  compareCodexAuthFreshness,
} from './codexAuth';
export type { CodexAuthIdentity, CodexAuthJsonFile } from './codexAuth';
export { atomicWriteJson, atomicWriteJsonSync } from './writers/atomic';
export { parseClaudeAuthStatus, parseCodexLoginStatus } from './authStatus';
export type { ParsedClaudeAuthStatus, ParsedCodexLoginStatus } from './authStatus';
export { codexRolloutOrigin, codexSpawnParentFromSource } from './parsers/codexRolloutOrigin';
export type { CodexRolloutOrigin } from './parsers/codexRolloutOrigin';
export {
  getPricingCatalogInfo,
  registerModelPricing,
  clearRegisteredModelPricing,
} from './modelInfo';
export type {
  PricingCatalogInfo,
  PricingCatalogSource,
  RegisterModelPricingOptions,
} from './modelInfo';

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

export { fetchProviderServiceStatus } from './providerServiceStatus';

// Tool categories across providers
export { classifyTool, TOOL_CATEGORIES } from './toolCategory';
export type { ClassifyToolOptions, ToolCategory } from './toolCategory';

// Workspace roots and git worktrees
export { resolveWorkspaceRoots } from './workspaceRoots';
export type { ResolveWorkspaceRootsOptions, ResolvedWorkspaceRoots } from './workspaceRoots';
export { discoverWorktreeSiblings, resolveWorktreeMainRepo } from './parsers/sessionPathResolver';

// Bounded JSONL tail reader
export {
  captureJsonlCheckpoint,
  createJsonlTail,
  DEFAULT_JSONL_TAIL_MAX_LINE_BYTES,
  DEFAULT_JSONL_TAIL_READ_BYTES,
  JSONL_TAIL_CHECKPOINT_VERSION,
  JsonlTailSymlinkError,
  verifyJsonlCheckpoint,
} from './watchers/jsonlTail';
export type {
  JsonlTail,
  JsonlTailCheckpoint,
  JsonlTailReadResult,
  JsonlTailEntry,
  JsonlTailRewritePolicy,
  JsonlTailBatch,
  JsonlTailLine,
  JsonlTailOptions,
  JsonlTailReset,
  JsonlTailResetReason,
} from './watchers/jsonlTail';
