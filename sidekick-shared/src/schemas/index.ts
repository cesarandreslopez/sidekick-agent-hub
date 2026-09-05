/**
 * Schemas entry (`sidekick-shared/schemas`).
 *
 * Pure zod runtime validation for the data shapes that cross process/IPC
 * boundaries: session events, quota state, quota history, account status,
 * and assistant turn projections. No node:fs / node:path — safe to bundle
 * for browser runtimes, and lean enough that importing it does not drag in
 * the rest of the library.
 *
 * The mirrored TypeScript interfaces are re-exported as types so this
 * subpath is self-sufficient for boundary-validation modules.
 */

export {
  ACCOUNT_PROVIDER_IDS,
  QUOTA_PROVIDER_IDS,
  RUNTIME_QUOTA_PROVIDER_IDS,
  SESSION_PROVIDER_IDS,
} from '../providerIds';

export {
  messageUsageSchema,
  sessionMessageSchema,
  sessionEventSchema,
  permissionModeSchema,
  extractSessionEvents,
  userSessionEventSchema,
  assistantSessionEventSchema,
  summarySessionEventSchema,
  systemSessionEventSchema,
  toolUseSessionEventSchema,
  toolResultSessionEventSchema,
} from './sessionEvent';
export type {
  MessageUsage,
  SessionMessage,
  SessionEvent,
  PermissionMode,
} from '../types/sessionEvent';
export { normalizedUsageSchema, normalizedUsageCostSchema } from './usageNormalization';
export type { NormalizedUsage, NormalizedUsageCost } from '../usageNormalization';
export { tokenEstimateSchema } from './tokenEstimation';
export type { TokenEstimate } from '../tokenEstimation';
export {
  transcriptSourceProvenanceSchema,
  canonicalTranscriptBlockSchema,
  canonicalToolCallSchema,
  canonicalTranscriptMessageSchema,
  canonicalSessionTranscriptSchema,
} from './transcript';
export type {
  CanonicalSessionTranscript,
  CanonicalTranscriptMessage,
  CanonicalToolCall,
  TranscriptSourceProvenance,
} from '../transcript';
export {
  observationProvenanceV1Schema,
  observedAgentSessionV1Schema,
  observedValueV1Schema,
  pendingUserRequestV1Schema,
  providerCapabilitiesV1Schema,
  providerSessionAdapterV1Schema,
  sessionEvidenceRefV1Schema,
} from './observedSessionV1';
export type {
  ObservationProvenanceV1,
  ObservedAgentSessionV1,
  ObservedValueV1,
  PendingUserRequestV1,
  ProviderCapabilitiesV1,
  ProviderSessionAdapterV1,
  SessionEvidenceRefV1,
} from '../types/observedSessionV1';

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
} from './quota';
export type {
  CodexResetCredit,
  CodexResetCreditsSnapshot,
  QuotaWindow,
  QuotaState,
} from '../quota';
export type { PeakHoursState } from '../peakHours';
export type { QuotaFailureDescriptor } from '../quotaPresentation';
export type { ProviderQuotaState, ProviderQuotaMap, RuntimeQuotaProvider } from '../providerQuota';

export {
  quotaHistoryRuntimeProviderSchema,
  quotaHistorySampleSchema,
  quotaHistoryDailyBucketSchema,
} from './quotaHistory';
export type {
  QuotaHistoryRuntimeProvider,
  QuotaHistorySample,
  QuotaHistoryDailyBucket,
} from '../quotaHistory';

export { activeProviderAccountStatusSchema, activeAccountStatusSchema } from './accountStatus';
export type { ActiveProviderAccountStatus, ActiveAccountStatus } from '../accountStatus';

export {
  accountProviderIdSchema,
  accountManagerResultSchema,
  beginAccountLoginResultSchema,
  accountLoginStatusSchema,
  accountEntrySchema,
  savedAccountProfileSchema,
  listAllAccountsResultSchema,
} from './accountManager';
export type { AccountEntry, AccountManagerResult } from '../accounts';
export type { AccountProviderId, SavedAccountProfile } from '../accountRegistry';
export type {
  AccountLoginStatus,
  BeginAccountLoginResult,
  ListAllAccountsResult,
} from '../accountManager';

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
} from './assistantTurn';
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
} from '../turns/assistantTurn';

export {
  sidekickStateFileSchema,
  stateFileAccountSchema,
  stateFileBillingBlockSchema,
  stateFileContextSchema,
  stateFileQuotaSchema,
  stateFileQuotaWindowSchema,
  stateFileSessionSchema,
  stateFileWriterSchema,
} from './stateFile';
export type {
  SidekickStateFile,
  StateFileAccount,
  StateFileBillingBlock,
  StateFileContext,
  StateFileQuota,
  StateFileQuotaWindow,
  StateFileSession,
  StateFileWriter,
} from '../stateFile';
