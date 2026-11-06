import { getModelPricing, type ModelPricing } from './modelInfo';
import type { SessionEvent } from './types/sessionEvent';

export type UsageProvider = 'anthropic' | 'openai' | 'sidekick' | (string & {});
export type UsageSemantics =
  | 'anthropic-additive-cache'
  | 'openai-inclusive-cache'
  | 'sidekick-disjoint';

export interface UsageNormalizationProvenance {
  provider?: UsageProvider;
  semantics: UsageSemantics;
  source?: string;
}

interface ProviderUsageBase {
  provider?: UsageProvider;
  source?: string;
  model?: string;
  reportedCostUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** Anthropic input and cache categories are additive. */
export interface AnthropicUsageInput extends ProviderUsageBase {
  semantics: 'anthropic';
  reasoningIncludedInOutput?: boolean;
}

/**
 * OpenAI-style counters: `inputTokens` includes every cached category, so
 * `cacheReadTokens` and `cacheWriteTokens` (Codex `cache_write_input_tokens`)
 * are both subtracted from it. Reasoning is normally a subset of output.
 */
export interface OpenAIUsageInput extends ProviderUsageBase {
  semantics: 'openai';
  reasoningIncludedInOutput?: boolean;
}

/** Already-disjoint usage. Reasoning inclusion must be stated explicitly. */
export interface SidekickUsageInput extends ProviderUsageBase {
  semantics: 'sidekick';
  reasoningIncludedInOutput: boolean;
}

export type ProviderUsageInput = AnthropicUsageInput | OpenAIUsageInput | SidekickUsageInput;

export interface NormalizedUsage {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reasoningIncludedInOutput: boolean;
  cacheInclusiveInputTokens: number;
  billableOutputTokens: number;
  totalTokens: number;
  model?: string;
  reportedCostUsd?: number;
  provenance: UsageNormalizationProvenance;
}

export type PricingProvenance =
  | 'provider-reported'
  | 'explicit-pricing'
  | 'model-catalog'
  | 'unpriced';

export interface NormalizedUsageCostInput {
  usage: NormalizedUsage;
  modelId?: string;
  pricing?: ModelPricing | null;
}

export interface NormalizedUsageCost {
  costUsd: number | null;
  source: PricingProvenance;
  modelId?: string;
  usage: NormalizedUsage;
}

function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0;
}

function reportedCost(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Convert provider-specific counters into finite, nonnegative, disjoint categories. */
export function normalizeProviderUsage(input: ProviderUsageInput): NormalizedUsage {
  const rawInput = tokenCount(input.inputTokens);
  const cacheReadTokens = tokenCount(input.cacheReadTokens);
  const cacheWriteTokens = tokenCount(input.cacheWriteTokens);
  const outputTokens = tokenCount(input.outputTokens);
  const reasoningTokens = tokenCount(input.reasoningTokens);

  const isOpenAI = input.semantics === 'openai';
  // OpenAI/Codex input already contains cache reads and writes
  // (`non_cached_input = input - cached`), so both come out of it.
  const uncachedInputTokens = isOpenAI
    ? Math.max(0, rawInput - cacheReadTokens - cacheWriteTokens)
    : rawInput;
  const reasoningIncludedInOutput = input.reasoningIncludedInOutput ?? input.semantics === 'openai';
  const cacheInclusiveInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const billableOutputTokens = outputTokens + (reasoningIncludedInOutput ? 0 : reasoningTokens);
  const totalTokens = cacheInclusiveInputTokens + billableOutputTokens;
  const semantics: UsageSemantics = isOpenAI
    ? 'openai-inclusive-cache'
    : input.semantics === 'anthropic'
      ? 'anthropic-additive-cache'
      : 'sidekick-disjoint';

  return {
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    reasoningIncludedInOutput,
    cacheInclusiveInputTokens,
    billableOutputTokens,
    totalTokens,
    ...(input.model ? { model: input.model } : {}),
    ...(reportedCost(input.reportedCostUsd) !== undefined
      ? { reportedCostUsd: reportedCost(input.reportedCostUsd) }
      : {}),
    provenance: {
      semantics,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.source ? { source: input.source } : {}),
    },
  };
}

/** Extract normalized usage from an event, preserving parser-owned semantics when present. */
export function extractNormalizedUsage(event: SessionEvent): NormalizedUsage | null {
  if (event.message?.normalizedUsage) return event.message.normalizedUsage;
  const usage = event.message?.usage;
  if (!usage) return null;

  const providerId = event.providerMetadata?.providerId;
  return normalizeProviderUsage({
    semantics: 'sidekick',
    provider: providerId,
    source: event.providerMetadata?.source ?? 'legacy-message-usage',
    model: event.message?.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    reasoningTokens: usage.reasoning_tokens,
    reasoningIncludedInOutput: providerId === 'codex' || providerId === 'openai',
    reportedCostUsd: usage.reported_cost,
  });
}

/**
 * USD for disjoint usage at `pricing`'s rates, or null when the result is not
 * a finite nonnegative number.
 *
 * OpenAI-style providers fold cache writes into input and the catalogs carry
 * no separate write rate for them (0), so under `openai-inclusive-cache`
 * semantics a write with no positive write rate is billed as ordinary input.
 */
function usageCostAtRates(usage: NormalizedUsage, pricing: ModelPricing): number | null {
  const cacheWriteRate =
    usage.provenance?.semantics === 'openai-inclusive-cache' &&
    !(pricing.cacheWriteCostPerMillion > 0)
      ? pricing.inputCostPerMillion
      : pricing.cacheWriteCostPerMillion;
  const costUsd =
    (usage.uncachedInputTokens / 1_000_000) * pricing.inputCostPerMillion +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadCostPerMillion +
    (usage.cacheWriteTokens / 1_000_000) * cacheWriteRate +
    (usage.billableOutputTokens / 1_000_000) * pricing.outputCostPerMillion;
  return Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null;
}

/** Price normalized, disjoint usage without double-counting reasoning tokens. */
export function calculateNormalizedUsageCost(input: NormalizedUsageCostInput): NormalizedUsageCost {
  const { usage } = input;
  const modelId = input.modelId ?? usage.model;
  if (usage.reportedCostUsd !== undefined) {
    return { costUsd: usage.reportedCostUsd, source: 'provider-reported', modelId, usage };
  }

  const explicit = input.pricing !== undefined;
  const pricing = explicit ? input.pricing : modelId ? getModelPricing(modelId) : null;
  if (!pricing) return { costUsd: null, source: 'unpriced', modelId, usage };

  const costUsd = usageCostAtRates(usage, pricing);
  if (costUsd === null) {
    return { costUsd: null, source: 'unpriced', modelId, usage };
  }
  return {
    costUsd,
    source: explicit ? 'explicit-pricing' : 'model-catalog',
    modelId,
    usage,
  };
}
