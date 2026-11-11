/**
 * @fileoverview Model pricing for session costs — a thin layer over sidekick-shared.
 *
 * Session costs are priced from per-model usage when they are read, not when
 * each event arrives, so a catalog refresh or a change to custom pricing
 * re-prices the whole session. Every surface (live dashboard, rebuilt
 * dashboard, Summary tab, historical records) goes through
 * `priceSessionModelUsage`, so their totals agree.
 *
 * Usage is kept in disjoint categories with the parser's reasoning semantics
 * applied: Codex and Claude count reasoning inside output, so only reasoning
 * reported apart from output (OpenCode's non-OpenAI providers) is billed on
 * top. Unknown models are unpriced (`priced: false`) and contribute 0, so the
 * UI can render "—" instead of a made-up dollar figure.
 *
 * @module services/ModelPricingService
 */

import {
  calculateNormalizedUsageCost,
  costSourceFromPricingProvenance,
  formatCost as sharedFormatCost,
  getModelPricing,
  mergeCostComponents,
  normalizeProviderUsage,
  parseModelId,
  resolvePricingTier,
  type CostComponent,
  type CostSource,
  type ModelPricing as SharedModelPricing,
  type NormalizedUsage,
  type ParsedModelId,
} from 'sidekick-shared';

/** Pricing information for a model. All costs are per million tokens in USD. */
export type ModelPricing = SharedModelPricing;

/** Token categories of calls priced at one rate. */
export interface ModelPricingCategories {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Reasoning tokens reported apart from output and billed on top of it. */
  separateReasoningTokens: number;
}

/**
 * One raw model id's usage inside a model row, in the categories that price
 * it. Calls whose cost the provider reported keep that cost and their token
 * count; every other call's usage is priced from the catalog on read.
 */
export interface ModelPricingBucket extends ModelPricingCategories {
  /** Provider-reported spend. */
  reportedCostUsd: number;
  /** Tokens covered by `reportedCostUsd` (not re-priced). */
  reportedTokens: number;
  /**
   * Calls whose prompt crossed a long-context price tier, keyed by the tier's
   * `aboveInputTokens`, kept apart so a merged total never re-prices short
   * calls at the long-context rate (or long calls at the base rate). Absent
   * in rows recorded before 0.32, which price at base rates.
   */
  longContext?: Record<string, ModelPricingCategories>;
}

/**
 * A `SessionStats.modelUsage` row. `pricing` is keyed by the raw model ids the
 * row merged (rows are keyed by `canonicalModelId`), so each is priced with its
 * own id. A row without `pricing` is priced from its own categories, with
 * reasoning counted inside output.
 */
export interface ModelUsageEntry {
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningTokens?: number;
  pricing?: Record<string, ModelPricingBucket>;
}

/** What a model row costs. */
export interface ModelCost {
  /** USD for the priced part of the row; 0 when nothing could be priced. */
  cost: number;
  /** Least certain source among the row's usage; undefined when it had no tokens. */
  source?: CostSource;
  /** False when some of the row's tokens have no known price. */
  priced: boolean;
}

export interface ModelCostRow extends ModelCost {
  model: string;
  calls: number;
  tokens: number;
}

export interface SessionCost {
  rows: ModelCostRow[];
  /** Sum of the rows' priced parts. */
  totalCost: number;
  /** Rolled-up provenance (`mergeCostComponents`); undefined when nothing counted. */
  source?: CostSource;
  /** Rows with any unpriced usage. */
  unpricedModelIds: string[];
}

function emptyBucket(): ModelPricingBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    separateReasoningTokens: 0,
    reportedCostUsd: 0,
    reportedTokens: 0,
  };
}

/** A bucket holding a row's own categories, reasoning counted inside output. */
function bucketFromCategories(entry: ModelUsageEntry): ModelPricingBucket {
  return {
    ...emptyBucket(),
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    cacheReadTokens: entry.cacheReadTokens,
  };
}

/**
 * Add one event's normalized usage (`extractNormalizedUsage`, which keeps the
 * parser's reasoning semantics) to a model row's pricing buckets.
 */
export function addUsageToPricing(
  entry: ModelUsageEntry,
  modelId: string,
  usage: NormalizedUsage,
): void {
  const buckets = (entry.pricing ??= {});
  const bucket = (buckets[modelId] ??= emptyBucket());
  if (usage.reportedCostUsd !== undefined) {
    bucket.reportedCostUsd += usage.reportedCostUsd;
    bucket.reportedTokens += usage.totalTokens;
    return;
  }
  // A single request whose prompt crossed a long-context tier keeps its
  // tokens apart, so pricing the merged row later bills only those calls at
  // the tier's rates.
  const tier = resolvePricingTier(getModelPricing(modelId), usage.requestPromptTokens);
  const target: ModelPricingCategories = tier
    ? ((bucket.longContext ??= {})[String(tier.aboveInputTokens)] ??= emptyCategories())
    : bucket;
  target.inputTokens += usage.uncachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  if (!usage.reasoningIncludedInOutput) target.separateReasoningTokens += usage.reasoningTokens;
}

function emptyCategories(): ModelPricingCategories {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    separateReasoningTokens: 0,
  };
}

/** Disjoint usage for one category set; `abovePrompt` selects its long-context tier. */
function categoriesUsage(
  categories: ModelPricingCategories,
  abovePrompt?: number,
): NormalizedUsage {
  return normalizeProviderUsage({
    semantics: 'sidekick',
    inputTokens: categories.inputTokens,
    outputTokens: categories.outputTokens,
    cacheWriteTokens: categories.cacheWriteTokens,
    cacheReadTokens: categories.cacheReadTokens,
    reasoningTokens: categories.separateReasoningTokens,
    reasoningIncludedInOutput: false,
    ...(abovePrompt !== undefined ? { requestPromptTokens: abovePrompt + 1 } : {}),
  });
}

/** Price one model row. `model` prices rows without buckets (older snapshots). */
export function priceModelUsage(model: string, entry: ModelUsageEntry): ModelCost {
  const buckets = entry.pricing ?? { [model]: bucketFromCategories(entry) };
  let cost = 0;
  const components: CostComponent[] = [];
  for (const [modelId, bucket] of Object.entries(buckets)) {
    if (bucket.reportedTokens > 0 || bucket.reportedCostUsd > 0) {
      cost += bucket.reportedCostUsd;
      components.push({ source: 'reported', tokens: bucket.reportedTokens });
    }
    const parts: NormalizedUsage[] = [categoriesUsage(bucket)];
    for (const [threshold, categories] of Object.entries(bucket.longContext ?? {})) {
      const above = Number(threshold);
      if (Number.isFinite(above) && above > 0) parts.push(categoriesUsage(categories, above));
    }
    for (const usage of parts) {
      if (usage.totalTokens === 0) continue;
      const priced = calculateNormalizedUsageCost({ usage, modelId });
      cost += priced.costUsd ?? 0;
      components.push({
        source: costSourceFromPricingProvenance(priced.source),
        tokens: usage.totalTokens,
      });
    }
  }
  const source = mergeCostComponents(components);
  return { cost, ...(source ? { source } : {}), priced: source !== 'unpriced' };
}

/** Price every model row of a session, in map order. */
export function priceSessionModelUsage(
  modelUsage: ReadonlyMap<string, ModelUsageEntry>,
): SessionCost {
  const rows: ModelCostRow[] = [];
  let totalCost = 0;
  modelUsage.forEach((entry, model) => {
    const priced = priceModelUsage(model, entry);
    rows.push({ model, calls: entry.calls, tokens: entry.tokens, ...priced });
    totalCost += priced.cost;
  });
  const source = mergeCostComponents(
    rows.map((row) => ({ source: row.source, tokens: row.tokens })),
  );
  return {
    rows,
    totalCost,
    ...(source ? { source } : {}),
    unpricedModelIds: rows.filter((row) => !row.priced).map((row) => row.model),
  };
}

/**
 * Model lookups and cost formatting. Unknown models return null; callers
 * render "—" rather than invent a price.
 */
export class ModelPricingService {
  static parseModelId(modelId: string): ParsedModelId | null {
    return parseModelId(modelId);
  }

  /** Returns pricing for a model, or null if unknown. Callers must handle null. */
  static getPricing(modelId: string): ModelPricing | null {
    return getModelPricing(modelId);
  }

  /** Formats cost as `$X.YZ`, or `—` for null/undefined. */
  static formatCost(cost: number | null | undefined): string {
    return sharedFormatCost(cost);
  }
}
