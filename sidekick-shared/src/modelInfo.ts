/**
 * Model identification, pricing, and metadata.
 *
 * Provides unified model info lookup: family parsing, context window size,
 * and per-token pricing for cost calculation. Consolidates logic that was
 * previously split between modelContext.ts (context window) and
 * ModelPricingService in sidekick-vscode (pricing).
 *
 * @module modelInfo
 */

import { getModelContextWindowSize } from './modelContext';

// ── Types ──

/**
 * Pricing information for a model.
 * All costs are per million tokens in USD.
 */
export interface ModelPricing {
  /** Cost per million input tokens */
  inputCostPerMillion: number;
  /** Cost per million output tokens */
  outputCostPerMillion: number;
  /** Cost per million cache write tokens */
  cacheWriteCostPerMillion: number;
  /** Cost per million cache read tokens */
  cacheReadCostPerMillion: number;
}

/**
 * Token usage for cost calculation.
 */
export interface CostTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/**
 * Comprehensive model metadata.
 */
export interface ModelInfo {
  /** Model family (e.g., "opus", "sonnet", "haiku") or null for non-Claude models */
  family: string | null;
  /** Model version (e.g., "4", "4.5", "4.6") or null for non-Claude models */
  version: string | null;
  /** Context window size in tokens */
  contextWindow: number;
  /** Pricing data, or null for models without known pricing */
  pricing: ModelPricing | null;
}

// ── Pricing Table ──

/**
 * Pricing table for Claude models.
 * Key format: "{family}-{version}" (e.g., "haiku-4.5", "sonnet-4")
 *
 * Source: Anthropic API pricing (2026-01-29)
 */
const PRICING_TABLE: Record<string, ModelPricing> = {
  'haiku-4.5': {
    inputCostPerMillion: 1.0,
    outputCostPerMillion: 5.0,
    cacheWriteCostPerMillion: 1.25,
    cacheReadCostPerMillion: 0.1,
  },
  'haiku-3.5': {
    inputCostPerMillion: 0.8,
    outputCostPerMillion: 4.0,
    cacheWriteCostPerMillion: 1.0,
    cacheReadCostPerMillion: 0.08,
  },
  'sonnet-4.5': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.3,
  },
  'sonnet-4': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.3,
  },
  'sonnet-4.6': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.3,
  },
  'opus-4.5': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'opus-4': {
    inputCostPerMillion: 15.0,
    outputCostPerMillion: 75.0,
    cacheWriteCostPerMillion: 18.75,
    cacheReadCostPerMillion: 1.5,
  },
  'opus-4.6': {
    inputCostPerMillion: 15.0,
    outputCostPerMillion: 75.0,
    cacheWriteCostPerMillion: 18.75,
    cacheReadCostPerMillion: 1.5,
  },
};

// ── Model Parsing ──

/**
 * Parses a Claude model ID to extract family and version.
 *
 * @param modelId - Model ID like "claude-opus-4-20250514"
 * @returns Object with family and version, or null if not a Claude model
 *
 * @example
 * ```typescript
 * parseModelId('claude-opus-4-20250514')
 * // => { family: 'opus', version: '4' }
 *
 * parseModelId('gpt-4o')
 * // => null
 * ```
 */
export function parseModelId(modelId: string): { family: string; version: string } | null {
  const match = modelId.match(/claude-(haiku|sonnet|opus)-([0-9.]+)/i);
  if (!match) return null;
  return { family: match[1].toLowerCase(), version: match[2] };
}

// ── Pricing Lookup ──

/**
 * Gets pricing for a model.
 *
 * Fallback strategy:
 * 1. Exact match on family-version
 * 2. Latest version in same family
 * 3. Sonnet 4.5 pricing (safe middle-ground)
 *
 * @param modelId - Model ID like "claude-opus-4-20250514"
 * @returns Pricing information, or null for non-Claude models
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  const parsed = parseModelId(modelId);
  if (!parsed) return null;

  const { family, version } = parsed;
  const key = `${family}-${version}`;

  // Exact match
  if (PRICING_TABLE[key]) return PRICING_TABLE[key];

  // Fallback to latest version in family
  const familyKeys = Object.keys(PRICING_TABLE)
    .filter(k => k.startsWith(family))
    .sort()
    .reverse();

  if (familyKeys.length > 0) return PRICING_TABLE[familyKeys[0]];

  // Ultimate fallback
  return PRICING_TABLE['sonnet-4.5'];
}

// ── Public API ──

/**
 * Returns comprehensive metadata for a model ID.
 *
 * Combines family parsing, context window lookup, and pricing into one call.
 *
 * @param modelId - Model ID (e.g., "claude-opus-4-20250514", "gpt-4o")
 * @returns ModelInfo with all available metadata
 *
 * @example
 * ```typescript
 * const info = getModelInfo('claude-opus-4-20250514');
 * // => { family: 'opus', version: '4', contextWindow: 200000, pricing: { ... } }
 *
 * const gpt = getModelInfo('gpt-4o');
 * // => { family: null, version: null, contextWindow: 128000, pricing: null }
 * ```
 */
export function getModelInfo(modelId: string): ModelInfo {
  const parsed = parseModelId(modelId);
  return {
    family: parsed?.family ?? null,
    version: parsed?.version ?? null,
    contextWindow: getModelContextWindowSize(modelId),
    pricing: getModelPricing(modelId),
  };
}

/**
 * Calculates the USD cost from token usage and a model ID.
 *
 * Convenience wrapper that resolves pricing internally.
 * Returns 0 for models without known pricing (non-Claude).
 *
 * @param usage - Token usage breakdown
 * @param modelId - Model ID for pricing lookup
 * @returns Cost in USD
 *
 * @example
 * ```typescript
 * const cost = calculateCost(
 *   { inputTokens: 10000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0 },
 *   'claude-sonnet-4-20250514'
 * );
 * // => 0.0375
 * ```
 */
export function calculateCost(usage: CostTokenUsage, modelId: string): number {
  const pricing = getModelPricing(modelId);
  if (!pricing) return 0;

  return (
    (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion +
    (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWriteCostPerMillion +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadCostPerMillion
  );
}

/**
 * Calculates cost from token usage and an explicit pricing object.
 *
 * Use this when you already have pricing (e.g., from getModelPricing())
 * and want to avoid a second lookup.
 *
 * @param usage - Token usage breakdown
 * @param pricing - Pricing information
 * @returns Cost in USD
 */
export function calculateCostWithPricing(usage: CostTokenUsage, pricing: ModelPricing): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion +
    (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWriteCostPerMillion +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadCostPerMillion
  );
}

/**
 * Formats a USD cost as a currency string.
 *
 * Uses 4 decimal places for costs < $0.01 for visibility,
 * standard 2 decimal places otherwise.
 *
 * @param cost - Cost in USD
 * @returns Formatted string (e.g., "$0.15", "$0.0012")
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
