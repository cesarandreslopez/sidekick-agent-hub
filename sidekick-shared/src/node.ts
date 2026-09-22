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
export { collectPromptHistory } from './promptHistory';
export type {
  CollectPromptHistoryOptions,
  PromptHistoryBound,
  PromptHistoryBounds,
  PromptHistoryCursor,
  PromptHistoryCursorSession,
  PromptHistoryEntry,
  PromptHistoryMetadataStatus,
  PromptHistoryPendingPrompt,
  PromptHistoryProvider,
  PromptHistoryResult,
  PromptHistoryResumeState,
  PromptHistoryStats,
  PromptHistoryUsage,
} from './promptHistory';
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
  SessionEnumerationCounters,
  WatchedSessionFile,
} from './providers/types';

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
