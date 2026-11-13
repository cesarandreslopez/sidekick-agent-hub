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
 * The deprecated `calculateCost`, `calculateCostWithPricing`,
 * `calculateCostWithProvenance`, `CostTokenUsage` and `CostProvenanceInput`
 * are deliberately absent: they double-count OpenAI/Codex cached input and
 * reasoning. Use `priceProviderUsage()` for raw provider usage, or
 * `normalizeProviderUsage()` with `calculateNormalizedUsageCost()`. They
 * remain on the package root and `sidekick-shared/browser` for compatibility.
 *
 * @module pricing
 */

export {
  MODEL_PROVIDER_IDS,
  canonicalModelId,
  isMovingModelAlias,
  MOVING_MODEL_ALIASES,
  COST_SOURCES,
  parseModelId,
  compareModelIds,
  sortModelIds,
  shortModelName,
  getModelDisplayInfo,
  getModelInfo,
  getModelPricing,
  resolveModelPricing,
  resolvePricingTier,
  registerModelPricing,
  clearRegisteredModelPricing,
  getPricingCatalogInfo,
  mergeCostSources,
  costSourceFromPricingProvenance,
  mergeCostComponents,
  formatCost,
} from './modelInfo';
export type {
  ModelPricing,
  ModelPricingTier,
  ModelPricingSource,
  ModelPricingMatch,
  ModelPricingProvenance,
  ResolvedModelPricing,
  ResolveModelPricingOptions,
  RegisterModelPricingOptions,
  PricingCatalogSource,
  PricingCatalogInfo,
  CostComponent,
  ModelProvider,
  ParsedModelId,
  ModelInfo,
  CostSource,
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
// One-call pricing of raw provider usage objects.
export {
  RAW_USAGE_FORMATS,
  PRICING_PROVENANCES,
  normalizeRawProviderUsage,
  priceProviderUsage,
} from './usageNormalization';
export type {
  RawUsageFormat,
  RawUsageExtras,
  PriceProviderUsageInput,
  ProviderUsagePrice,
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
