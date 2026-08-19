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
export { formatDurationMs, formatTokenCount } from './formatting';
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
