import {
  canonicalModelId,
  costSourceFromPricingProvenance,
  getModelPricing,
  parseModelId,
  resolveModelPricing,
  resolvePricingTier,
  type CostSource,
  type ModelPricing,
  type ModelPricingProvenance,
} from './modelInfo';
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
  /**
   * The counters describe one request (one API call). Its prompt size —
   * uncached input plus cache reads and writes — is then recorded as
   * `requestPromptTokens` and selects a long-context pricing tier. Leave
   * unset for totals that merge several requests.
   */
  singleRequest?: boolean;
  /**
   * The prompt size of the single request this usage was billed under, when
   * the counters alone do not show it (a correction carrying only a delta).
   * Wins over `singleRequest`.
   */
  requestPromptTokens?: number;
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
  /**
   * Prompt size (uncached input + cache reads + cache writes) of the single
   * request this usage was billed under. It selects a long-context pricing
   * tier. Absent on totals that combine several requests, which always bill
   * at base rates.
   */
  requestPromptTokens?: number;
  model?: string;
  reportedCostUsd?: number;
  provenance: UsageNormalizationProvenance;
}

/**
 * Every `PricingProvenance`, as a runtime tuple for validators and enum
 * mirrors. Since 0.33.0.
 */
export const PRICING_PROVENANCES = [
  'provider-reported',
  'explicit-pricing',
  'model-catalog',
  'unpriced',
] as const;

export type PricingProvenance = (typeof PRICING_PROVENANCES)[number];

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
  /**
   * `aboveInputTokens` of the long-context tier the request billed under;
   * set only when one applied.
   */
  pricingTier?: number;
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
  const requestPromptTokens =
    input.requestPromptTokens !== undefined && tokenCount(input.requestPromptTokens) > 0
      ? tokenCount(input.requestPromptTokens)
      : input.singleRequest
        ? cacheInclusiveInputTokens
        : undefined;
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
    ...(requestPromptTokens !== undefined ? { requestPromptTokens } : {}),
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
    // An event's usage is one request's.
    singleRequest: true,
  });
}

/**
 * True when `modelId` names an OpenAI-family model (`gpt-*`, `o<n>`,
 * `codex-*`, `chatgpt-*`, with any provider or region prefix). OpenAI bills a
 * prompt-cache write as ordinary input, so a catalog that lists no write rate
 * (0) for such a model does not make writes free. Other providers' zero write
 * rates (Gemini, DeepSeek, GLM, …) are taken at their word.
 */
function writesBilledAsInput(modelId: string | undefined): boolean {
  if (typeof modelId !== 'string' || !modelId.trim()) return false;
  const id = canonicalModelId(modelId);
  if (/^(?:codex|chatgpt)(?:-|$)/.test(id)) return true;
  return parseModelId(id)?.provider === 'openai';
}

/**
 * USD for disjoint usage at `pricing`'s rates, or null when the result is not
 * a finite nonnegative number. A single request's prompt size
 * (`requestPromptTokens`) selects a long-context tier, whose rates then apply
 * to every category; `tier` reports its threshold.
 *
 * OpenAI-style providers fold cache writes into input, and the catalogs carry
 * no separate write rate for them (0). A write with no positive write rate is
 * therefore billed as ordinary input (the tier's input rate when a tier
 * applies) under `openai-inclusive-cache` semantics, and for an
 * OpenAI-family `modelId` whatever the semantics, such as disjoint usage a
 * caller stored after normalizing. Any other zero write rate stays zero.
 */
function usageCostAtRates(
  usage: NormalizedUsage,
  pricing: ModelPricing,
  modelId?: string,
): { costUsd: number | null; tier?: number } {
  const tier = resolvePricingTier(pricing, usage.requestPromptTokens);
  const rates = tier ?? pricing;
  const cacheWriteRate =
    !(rates.cacheWriteCostPerMillion > 0) &&
    (usage.provenance?.semantics === 'openai-inclusive-cache' || writesBilledAsInput(modelId))
      ? rates.inputCostPerMillion
      : rates.cacheWriteCostPerMillion;
  const costUsd =
    (usage.uncachedInputTokens / 1_000_000) * rates.inputCostPerMillion +
    (usage.cacheReadTokens / 1_000_000) * rates.cacheReadCostPerMillion +
    (usage.cacheWriteTokens / 1_000_000) * cacheWriteRate +
    (usage.billableOutputTokens / 1_000_000) * rates.outputCostPerMillion;
  if (!(Number.isFinite(costUsd) && costUsd >= 0)) return { costUsd: null };
  return tier ? { costUsd, tier: tier.aboveInputTokens } : { costUsd };
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

  const priced = usageCostAtRates(usage, pricing, modelId);
  if (priced.costUsd === null) {
    return { costUsd: null, source: 'unpriced', modelId, usage };
  }
  return {
    costUsd: priced.costUsd,
    source: explicit ? 'explicit-pricing' : 'model-catalog',
    modelId,
    usage,
    ...(priced.tier !== undefined ? { pricingTier: priced.tier } : {}),
  };
}

// ── Raw provider usage ──

/**
 * Raw usage shapes `normalizeRawProviderUsage` reads:
 * - `anthropic`: Messages API `usage` (`input_tokens`, `output_tokens`,
 *   `cache_read_input_tokens`, `cache_creation_input_tokens`, or the
 *   `cache_creation.ephemeral_*_input_tokens` split). Cache fields are
 *   additive to input.
 * - `openai`: Responses API `usage` (`input_tokens`,
 *   `input_tokens_details.cached_tokens` / `.cache_write_tokens`,
 *   `output_tokens`, `output_tokens_details.reasoning_tokens`), or Chat
 *   Completions usage (`prompt_tokens`, `completion_tokens` and their
 *   `_details`) when `input_tokens` is absent. Cached input is inside input
 *   and reasoning inside output.
 * - `codex`: a Codex `TokenUsage` (rollout `last_token_usage`, `exec --json`,
 *   or the app-server's camelCase spelling): `input_tokens`,
 *   `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
 *   `reasoning_output_tokens`. OpenAI semantics: cache reads and writes are
 *   both inside `input_tokens` and come out of it, exactly as the session
 *   parser reads them, so totals match parsed sessions.
 */
export const RAW_USAGE_FORMATS = ['anthropic', 'openai', 'codex'] as const;
export type RawUsageFormat = (typeof RAW_USAGE_FORMATS)[number];

/** Metadata `normalizeRawProviderUsage` copies onto the normalized usage. */
export interface RawUsageExtras {
  /** Defaults to `anthropic` for the Anthropic format and `openai` otherwise. */
  provider?: UsageProvider;
  /** Defaults to `<format>-raw-usage`. */
  source?: string;
  model?: string;
  reportedCostUsd?: number | null;
  /** The usage is one request's; its prompt size selects a long-context tier. */
  singleRequest?: boolean;
  /** Explicit prompt size of the request (wins over `singleRequest`). */
  requestPromptTokens?: number;
}

/** An own property of a plain object, or undefined; never throws. */
function rawField(value: unknown, ...keys: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of keys) {
    try {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        return (value as Record<string, unknown>)[key];
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function rawCount(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Normalize one provider's raw usage object into disjoint categories, with
 * that provider's cache and reasoning semantics applied (see
 * `RAW_USAGE_FORMATS`). Missing, negative or non-numeric counters read as 0,
 * so malformed input yields zero usage rather than an error. Throws a
 * `TypeError` only for a `format` outside `RAW_USAGE_FORMATS`.
 */
export function normalizeRawProviderUsage(
  format: RawUsageFormat,
  usage: unknown,
  extras?: RawUsageExtras,
): NormalizedUsage {
  const meta = {
    provider: extras?.provider ?? (format === 'anthropic' ? 'anthropic' : 'openai'),
    source: extras?.source ?? `${format}-raw-usage`,
    ...(extras?.model ? { model: extras.model } : {}),
    ...(extras?.reportedCostUsd !== undefined ? { reportedCostUsd: extras.reportedCostUsd } : {}),
    ...(extras?.singleRequest ? { singleRequest: true } : {}),
    ...(extras?.requestPromptTokens !== undefined
      ? { requestPromptTokens: extras.requestPromptTokens }
      : {}),
  };
  switch (format) {
    case 'anthropic': {
      const creation = rawField(usage, 'cache_creation');
      const split =
        (rawCount(rawField(creation, 'ephemeral_5m_input_tokens')) ?? 0) +
        (rawCount(rawField(creation, 'ephemeral_1h_input_tokens')) ?? 0);
      return normalizeProviderUsage({
        ...meta,
        semantics: 'anthropic',
        inputTokens: rawCount(rawField(usage, 'input_tokens')),
        outputTokens: rawCount(rawField(usage, 'output_tokens')),
        cacheReadTokens: rawCount(rawField(usage, 'cache_read_input_tokens')),
        cacheWriteTokens: rawCount(rawField(usage, 'cache_creation_input_tokens')) ?? split,
      });
    }
    case 'openai': {
      const responses = rawField(usage, 'input_tokens') !== undefined;
      const inputDetails = rawField(
        usage,
        responses ? 'input_tokens_details' : 'prompt_tokens_details',
      );
      const outputDetails = rawField(
        usage,
        responses ? 'output_tokens_details' : 'completion_tokens_details',
      );
      return normalizeProviderUsage({
        ...meta,
        semantics: 'openai',
        inputTokens: rawCount(rawField(usage, responses ? 'input_tokens' : 'prompt_tokens')),
        outputTokens: rawCount(rawField(usage, responses ? 'output_tokens' : 'completion_tokens')),
        cacheReadTokens: rawCount(rawField(inputDetails, 'cached_tokens')),
        cacheWriteTokens: rawCount(rawField(inputDetails, 'cache_write_tokens')),
        reasoningTokens: rawCount(rawField(outputDetails, 'reasoning_tokens')),
      });
    }
    case 'codex':
      return normalizeProviderUsage({
        ...meta,
        semantics: 'openai',
        inputTokens: rawCount(rawField(usage, 'input_tokens', 'inputTokens')),
        outputTokens: rawCount(rawField(usage, 'output_tokens', 'outputTokens')),
        cacheReadTokens: rawCount(rawField(usage, 'cached_input_tokens', 'cachedInputTokens')),
        cacheWriteTokens: rawCount(
          rawField(usage, 'cache_write_input_tokens', 'cacheWriteInputTokens'),
        ),
        reasoningTokens: rawCount(
          rawField(usage, 'reasoning_output_tokens', 'reasoningOutputTokens'),
        ),
      });
    default:
      throw new TypeError(`Unknown raw usage format: ${String(format)}`);
  }
}

export interface PriceProviderUsageInput {
  /** Which provider API or log wrote `usage`. */
  provider: RawUsageFormat;
  /** The provider's raw usage object, as in `normalizeRawProviderUsage`. */
  usage: unknown;
  /** Model id to price with when no `pricing` is given. */
  model?: string;
  /** Explicit rates; `null` means unpriced. Takes precedence over `model`. */
  pricing?: ModelPricing | null;
  /** A provider-reported cost; when finite and nonnegative it wins. */
  reportedCostUsd?: number | null;
  /**
   * `usage` is one request's, so its prompt size selects a long-context
   * pricing tier. Defaults to true for `anthropic` and `openai` (an API
   * response's usage) and false for `codex`, whose usage objects include
   * running totals (`exec --json` `turn.completed`); pass true for a rollout's
   * `last_token_usage`.
   *
   * Pass false for any total that merges several model calls under the
   * `anthropic` or `openai` format, such as Claude Code's headless
   * `result.usage` (`claude -p --output-format stream-json`, the `run` usage
   * of `sidekick-shared/headless`), which sums every call of the run: priced
   * as one request it could cross a long-context threshold no single call
   * reached.
   */
  singleRequest?: boolean;
}

export interface ProviderUsagePrice {
  costUsd: number | null;
  /** Display cost source, as `costSourceFromPricingProvenance` maps `provenance`. */
  source: CostSource;
  provenance: PricingProvenance;
  /** How `resolveModelPricing` matched `model`, when it was consulted. */
  pricingMatch?: ModelPricingProvenance;
  modelId?: string;
  normalized: NormalizedUsage;
  /** `aboveInputTokens` of the long-context tier applied, when one was. */
  pricingTier?: number;
}

/**
 * Price one raw provider usage object in a single call, with that provider's
 * cache and reasoning semantics applied, so nothing is counted twice. Unlike
 * the deprecated `calculateCost`, Codex reasoning (already inside output) and
 * cached input (already inside input) are billed once.
 *
 * Precedence: a provider-reported cost, then explicit `pricing` (`null`
 * leaves it unpriced), then `resolveModelPricing(model)`.
 */
export function priceProviderUsage(input: PriceProviderUsageInput): ProviderUsagePrice {
  const modelId = typeof input.model === 'string' && input.model.trim() ? input.model : undefined;
  const normalized = normalizeRawProviderUsage(input.provider, input.usage, {
    ...(modelId ? { model: modelId } : {}),
    reportedCostUsd: input.reportedCostUsd,
    singleRequest: input.singleRequest ?? input.provider !== 'codex',
  });
  const result = (
    costUsd: number | null,
    provenance: PricingProvenance,
    pricingMatch?: ModelPricingProvenance,
    pricingTier?: number,
  ): ProviderUsagePrice => ({
    costUsd,
    source: costSourceFromPricingProvenance(provenance),
    provenance,
    ...(pricingMatch ? { pricingMatch } : {}),
    ...(modelId ? { modelId } : {}),
    normalized,
    ...(pricingTier !== undefined ? { pricingTier } : {}),
  });

  if (normalized.reportedCostUsd !== undefined) {
    return result(normalized.reportedCostUsd, 'provider-reported');
  }
  if (input.pricing !== undefined) {
    const priced = input.pricing ? usageCostAtRates(normalized, input.pricing, modelId) : null;
    return !priced || priced.costUsd === null
      ? result(null, 'unpriced')
      : result(priced.costUsd, 'explicit-pricing', undefined, priced.tier);
  }
  if (!modelId) return result(null, 'unpriced');
  const resolved = resolveModelPricing(modelId);
  const priced = resolved.pricing ? usageCostAtRates(normalized, resolved.pricing, modelId) : null;
  return !priced || priced.costUsd === null
    ? result(null, 'unpriced', resolved.provenance)
    : result(priced.costUsd, 'model-catalog', resolved.provenance, priced.tier);
}
