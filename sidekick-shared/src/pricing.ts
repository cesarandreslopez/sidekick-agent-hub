/**
 * `sidekick-shared/pricing` — model pricing, model-id identity, usage
 * normalization and cost, cost provenance, cost/token formatting, and text
 * token estimates, as one small pure entry (no filesystem, network, or Zod).
 *
 * For hosts that price usage or format costs without session reading: it
 * loads a handful of modules instead of the full browser surface. LiteLLM
 * catalog hydration stays Node-only in `sidekick-shared/node`
 * (`hydratePricingCatalog`); once hydrated, lookups here see the catalog.
 * Everything here is also exported from the package root and
 * `sidekick-shared/browser`.
 *
 * @module pricing
 */

export {
  MODEL_PROVIDER_IDS,
  canonicalModelId,
  isMovingModelAlias,
  parseModelId,
  compareModelIds,
  sortModelIds,
  shortModelName,
  getModelDisplayInfo,
  getModelInfo,
  getModelPricing,
  resolveModelPricing,
  registerModelPricing,
  clearRegisteredModelPricing,
  getPricingCatalogInfo,
  calculateCost,
  calculateCostWithPricing,
  calculateCostWithProvenance,
  mergeCostSources,
  costSourceFromPricingProvenance,
  mergeCostComponents,
  formatCost,
} from './modelInfo';
export type {
  ModelPricing,
  ModelPricingSource,
  ModelPricingMatch,
  ModelPricingProvenance,
  ResolvedModelPricing,
  ResolveModelPricingOptions,
  RegisterModelPricingOptions,
  PricingCatalogSource,
  PricingCatalogInfo,
  CostComponent,
  CostTokenUsage,
  ModelProvider,
  ParsedModelId,
  ModelInfo,
  CostSource,
  CostProvenanceInput,
  CostWithProvenance,
  ModelDisplayInfo,
  FormatCostOptions,
} from './modelInfo';

export {
  normalizeProviderUsage,
  extractNormalizedUsage,
  calculateNormalizedUsageCost,
} from './usageNormalization';
export type {
  UsageProvider,
  UsageSemantics,
  UsageNormalizationProvenance,
  AnthropicUsageInput,
  OpenAIUsageInput,
  SidekickUsageInput,
  ProviderUsageInput,
  NormalizedUsage,
  PricingProvenance,
  NormalizedUsageCostInput,
  NormalizedUsageCost,
} from './usageNormalization';

export { formatTokenCount, formatDurationMs } from './formatting';
export type { FormatTokenCountOptions, FormatDurationMsOptions } from './formatting';

export {
  ASCII_CHARS_PER_TOKEN,
  estimateTextTokens,
  estimateSerializedTokens,
} from './tokenEstimation';
export type {
  TokenEstimationMethod,
  TokenEstimationConfidence,
  ExactTokenCounterContext,
  ExactTokenCounter,
  TokenEstimationOptions,
  TokenEstimate,
} from './tokenEstimation';
