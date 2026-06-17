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
  messageUsageSchema,
  sessionMessageSchema,
  sessionEventSchema,
  permissionModeSchema,
  extractSessionEvents,
} from './sessionEvent';
export type {
  MessageUsage,
  SessionMessage,
  SessionEvent,
  PermissionMode,
} from '../types/sessionEvent';

export {
  quotaWindowSchema,
  quotaStateSchema,
  quotaFailureKindSchema,
  quotaProviderIdSchema,
  quotaSourceSchema,
  peakHoursStateSchema,
  quotaFailureDescriptorSchema,
  runtimeQuotaProviderSchema,
  providerQuotaStateSchema,
  claudeProviderQuotaStateSchema,
  codexProviderQuotaStateSchema,
  providerQuotaMapSchema,
} from './quota';
export type { QuotaWindow, QuotaState } from '../quota';
export type { PeakHoursState } from '../peakHours';
export type { QuotaFailureDescriptor } from '../quotaPresentation';
export type {
  ProviderQuotaState,
  ProviderQuotaMap,
  RuntimeQuotaProvider,
} from '../providerQuota';

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

export {
  activeProviderAccountStatusSchema,
  activeAccountStatusSchema,
} from './accountStatus';
export type {
  ActiveProviderAccountStatus,
  ActiveAccountStatus,
} from '../accountStatus';

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
