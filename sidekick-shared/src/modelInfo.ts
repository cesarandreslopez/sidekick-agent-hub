/**
 * Model identification, pricing, and metadata.
 *
 * Single source of truth for:
 * - Parsing model IDs into {provider, family, version}
 * - Looking up per-token pricing (static baseline + optional runtime overrides)
 * - Calculating USD cost from token usage
 *
 * Design notes:
 * - Pricing lookup is honest: unknown models return `null`, never a "best-guess
 *   other model's rate". Callers must handle null and render "—" in UIs.
 * - An override map (populated by `pricingCatalog.ts` via `_setPricingOverrides`)
 *   is consulted first, so runtime hydration from LiteLLM supersedes the static
 *   baseline without requiring a redeploy when vendor prices change.
 * - Longest-prefix matching handles variants like `claude-opus-4.5-20250514`
 *   against a key like `claude-opus-4.5`. Same pattern used in modelContext.ts.
 *
 * @module modelInfo
 */

import { getModelContextWindowSize } from './modelContext';

// ── Types ──

/** Pricing information for a model. All costs are per million tokens in USD. */
export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheWriteCostPerMillion: number;
  cacheReadCostPerMillion: number;
}

/** Token usage for cost calculation. */
export interface CostTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /**
   * OpenAI o-series / Codex "reasoning" tokens. Billed at the output rate by
   * OpenAI, so we multiply by `outputCostPerMillion` inside calculateCost.
   * Optional for backward compatibility with existing callers.
   */
  reasoningTokens?: number;
}

/** Provider that hosts a model. "unknown" means we couldn't classify it. */
export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'unknown';

/** Structured result of parsing a raw model ID. */
export interface ParsedModelId {
  provider: ModelProvider;
  family: string;
  version: string;
}

/** Comprehensive model metadata. */
export interface ModelInfo {
  provider: ModelProvider | null;
  family: string | null;
  version: string | null;
  contextWindow: number;
  pricing: ModelPricing | null;
}

/** Provenance for a displayed cost value. */
export type CostSource = 'reported' | 'estimated' | 'unpriced';

/** Input for cost calculation that preserves reported-vs-estimated provenance. */
export interface CostProvenanceInput {
  usage: CostTokenUsage;
  modelId: string;
  reportedCostUsd?: number | null;
}

/** Cost value plus provenance for UI rollups and merged session totals. */
export interface CostWithProvenance {
  costUsd?: number;
  source: CostSource;
}

/** Display and ranking metadata for model pickers. */
export interface ModelDisplayInfo {
  modelId: string;
  provider: ModelProvider | null;
  family: string | null;
  version: string | null;
  shortName: string;
  rank: number;
}

// ── Static Pricing Table ──

/**
 * Static baseline pricing. Keys are model-ID prefixes; lookup uses
 * longest-prefix matching so `claude-sonnet-4.5-20250514` resolves
 * against `claude-sonnet-4.5`.
 *
 * Sources:
 *   - Anthropic: https://www.anthropic.com/pricing
 *   - OpenAI: https://openai.com/api/pricing/
 * Snapshot taken: 2026-06-09. Runtime LiteLLM hydration refreshes this.
 *
 * Anthropic keys appear in both dashed (`claude-opus-4-8`, the real model-ID
 * form) and dotted (`claude-opus-4.8`, the LiteLLM catalog form) spellings —
 * prefix matching cannot bridge the two, so both are needed.
 */
const PRICING_TABLE: Record<string, ModelPricing> = {
  // ── Anthropic: Claude ──
  'claude-fable-5': {
    inputCostPerMillion: 10.0,
    outputCostPerMillion: 50.0,
    cacheWriteCostPerMillion: 12.5,
    cacheReadCostPerMillion: 1.0,
  },
  'claude-haiku-4-5': {
    inputCostPerMillion: 1.0,
    outputCostPerMillion: 5.0,
    cacheWriteCostPerMillion: 1.25,
    cacheReadCostPerMillion: 0.1,
  },
  'claude-haiku-4.5': {
    inputCostPerMillion: 1.0,
    outputCostPerMillion: 5.0,
    cacheWriteCostPerMillion: 1.25,
    cacheReadCostPerMillion: 0.1,
  },
  'claude-haiku-3.5': {
    inputCostPerMillion: 0.8,
    outputCostPerMillion: 4.0,
    cacheWriteCostPerMillion: 1.0,
    cacheReadCostPerMillion: 0.08,
  },
  'claude-sonnet-4-6': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.3,
  },
  'claude-sonnet-4.6': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.3,
  },
  'claude-sonnet-4-5': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.3,
  },
  'claude-sonnet-4.5': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.3,
  },
  'claude-sonnet-4': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.3,
  },
  'claude-opus-4-8': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'claude-opus-4.8': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'claude-opus-4-7': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'claude-opus-4.7': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'claude-opus-4-6': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'claude-opus-4.6': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'claude-opus-4.5': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  // Opus 4.0 / 4.1 — pre-4.5 pricing tier
  'claude-opus-4': {
    inputCostPerMillion: 15.0,
    outputCostPerMillion: 75.0,
    cacheWriteCostPerMillion: 18.75,
    cacheReadCostPerMillion: 1.5,
  },

  // ── OpenAI: GPT-4.x family ──
  'gpt-4.1': {
    inputCostPerMillion: 2.0,
    outputCostPerMillion: 8.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.5,
  },
  'gpt-4o-mini': {
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.075,
  },
  'gpt-4o': {
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 1.25,
  },
  'gpt-4-turbo': {
    inputCostPerMillion: 10.0,
    outputCostPerMillion: 30.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
  },

  // ── OpenAI: GPT-5 family (baseline estimate; LiteLLM catalog overrides) ──
  // Codex emits `gpt-5.4`, `gpt-5.3-codex`, `gpt-5`. Anchoring the static
  // estimate to gpt-4o-tier rates so offline users see a reasonable ballpark.
  'gpt-5.4': {
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.125,
  },
  'gpt-5.3-codex': {
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.125,
  },
  'gpt-5.3': {
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.125,
  },
  'gpt-5': {
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.125,
  },

  // ── OpenAI: o-series (reasoning models) ──
  'o3-mini': {
    inputCostPerMillion: 1.1,
    outputCostPerMillion: 4.4,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.55,
  },
  'o3': {
    inputCostPerMillion: 2.0,
    outputCostPerMillion: 8.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.5,
  },
  'o1-mini': {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 12.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 1.5,
  },
  'o1': {
    inputCostPerMillion: 15.0,
    outputCostPerMillion: 60.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 7.5,
  },
};

/** Static-table keys sorted longest-first so longest-prefix wins. */
const STATIC_SORTED_KEYS = Object.keys(PRICING_TABLE).sort(
  (a, b) => b.length - a.length,
);

// ── Override Table (populated at runtime by pricingCatalog) ──

let overrideTable: Record<string, ModelPricing> = {};
let overrideSortedKeys: string[] = [];

/**
 * Internal: replace the runtime override map. Called by `pricingCatalog.ts`
 * after a successful LiteLLM hydration. Not part of the stable public API,
 * but exported so the Node-only catalog module can wire itself in without
 * creating a circular import.
 */
export function _setPricingOverrides(overrides: Record<string, ModelPricing>): void {
  overrideTable = { ...overrides };
  overrideSortedKeys = Object.keys(overrideTable).sort(
    (a, b) => b.length - a.length,
  );
}

/** Internal: snapshot current overrides (test + diagnostics). */
export function _getPricingOverrides(): Record<string, ModelPricing> {
  return { ...overrideTable };
}

/** Internal: clear overrides (used by tests and when disabling hydration). */
export function _clearPricingOverrides(): void {
  overrideTable = {};
  overrideSortedKeys = [];
}

// ── Model ID Parsing ──

const CLAUDE_RE = /^claude-(haiku|sonnet|opus|fable)-([0-9.]+)/i;
const LEGACY_CLAUDE_RE = /^claude-([0-9]+(?:[-.][0-9]+)?)-(haiku|sonnet|opus)(?:-|$)/i;
const GPT_RE = /^gpt-([0-9][0-9.A-Za-z-]*)/i;
const O_SERIES_RE = /^o([0-9]+)(-mini|-pro)?/i;
const GEMINI_RE = /^gemini-([0-9][0-9.A-Za-z-]*)/i;

/**
 * Parses a model ID into {provider, family, version}.
 *
 * Recognizes Anthropic (Claude), OpenAI (GPT + o-series), and Google (Gemini).
 * Returns null for anything else — callers should treat that as "unknown model".
 */
export function parseModelId(modelId: string): ParsedModelId | null {
  if (!modelId) return null;
  const normalized = modelId.replace(/\[1m\]/gi, '');

  const claude = normalized.match(CLAUDE_RE);
  if (claude) {
    return { provider: 'anthropic', family: claude[1].toLowerCase(), version: claude[2] };
  }

  const legacyClaude = normalized.match(LEGACY_CLAUDE_RE);
  if (legacyClaude) {
    return {
      provider: 'anthropic',
      family: legacyClaude[2].toLowerCase(),
      version: legacyClaude[1].replace('-', '.'),
    };
  }

  const gpt = normalized.match(GPT_RE);
  if (gpt) {
    return { provider: 'openai', family: 'gpt', version: gpt[1] };
  }

  const oSeries = normalized.match(O_SERIES_RE);
  if (oSeries) {
    const suffix = oSeries[2] ? oSeries[2] : '';
    return { provider: 'openai', family: 'o', version: `${oSeries[1]}${suffix}` };
  }

  const gemini = normalized.match(GEMINI_RE);
  if (gemini) {
    return { provider: 'google', family: 'gemini', version: gemini[1] };
  }

  return null;
}

// ── Pricing Lookup ──

/** Find the longest key in `keys` that is a prefix of `modelId`, or null. */
function findLongestPrefix(keys: string[], modelId: string): string | null {
  for (const key of keys) {
    if (modelId === key || modelId.startsWith(key)) return key;
  }
  return null;
}

/**
 * Gets pricing for a model ID.
 *
 * Lookup order:
 *   1. Runtime override map (from LiteLLM catalog hydration).
 *   2. Static PRICING_TABLE.
 *   3. `null` — unknown model. Callers MUST handle this.
 *
 * @returns Pricing for the model, or null if unknown. No silent fallback.
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  if (!modelId) return null;
  const normalized = modelId.replace(/\[1m\]/gi, '');

  // 1. Overrides (exact then longest-prefix)
  if (overrideTable[normalized]) return overrideTable[normalized];
  const overridePrefix = findLongestPrefix(overrideSortedKeys, normalized);
  if (overridePrefix) return overrideTable[overridePrefix];

  // 2. Static (exact then longest-prefix)
  if (PRICING_TABLE[normalized]) return PRICING_TABLE[normalized];
  const staticPrefix = findLongestPrefix(STATIC_SORTED_KEYS, normalized);
  if (staticPrefix) return PRICING_TABLE[staticPrefix];

  // 3. Unknown
  return null;
}

/**
 * Returns comprehensive metadata for a model ID.
 *
 * @example
 * getModelInfo('claude-opus-4.5-20250514')
 * // => { provider: 'anthropic', family: 'opus', version: '4.5',
 * //      contextWindow: 200000, pricing: { ... } }
 *
 * getModelInfo('gpt-4o')
 * // => { provider: 'openai', family: 'gpt', version: '4o',
 * //      contextWindow: 128000, pricing: { ... } }
 */
export function getModelInfo(modelId: string): ModelInfo {
  const parsed = parseModelId(modelId);
  return {
    provider: parsed?.provider ?? null,
    family: parsed?.family ?? null,
    version: parsed?.version ?? null,
    contextWindow: getModelContextWindowSize(modelId),
    pricing: getModelPricing(modelId),
  };
}

// ── Cost Calculation ──

/**
 * Calculates cost from token usage and an explicit pricing object.
 *
 * Reasoning tokens (OpenAI o-series / Codex) are billed at the output rate,
 * matching OpenAI's billing behavior.
 */
export function calculateCostWithPricing(
  usage: CostTokenUsage,
  pricing: ModelPricing,
): number {
  const reasoning = usage.reasoningTokens ?? 0;
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion +
    (reasoning / 1_000_000) * pricing.outputCostPerMillion +
    (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWriteCostPerMillion +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadCostPerMillion
  );
}

/**
 * Calculates USD cost from token usage and a model ID.
 *
 * Returns `null` for unknown models. Callers should render `—` in that case,
 * not $0 — so users don't confuse "missing pricing" with "free".
 */
export function calculateCost(
  usage: CostTokenUsage,
  modelId: string,
): number | null {
  const pricing = getModelPricing(modelId);
  if (!pricing) return null;
  return calculateCostWithPricing(usage, pricing);
}

/**
 * Calculates cost while preserving whether the value was provider-reported,
 * locally estimated from pricing, or unavailable because the model is unpriced.
 */
export function calculateCostWithProvenance(input: CostProvenanceInput): CostWithProvenance {
  if (
    typeof input.reportedCostUsd === 'number' &&
    Number.isFinite(input.reportedCostUsd)
  ) {
    return { costUsd: input.reportedCostUsd, source: 'reported' };
  }

  const estimated = calculateCost(input.usage, input.modelId);
  if (estimated === null) return { source: 'unpriced' };
  return { costUsd: estimated, source: 'estimated' };
}

/**
 * Merge two cost sources for rollups. The least certain source wins so a total
 * containing any unpriced or estimated component does not look fully reported.
 */
export function mergeCostSources(a: CostSource, b: CostSource): CostSource {
  const rank: Record<CostSource, number> = {
    reported: 0,
    estimated: 1,
    unpriced: 2,
  };
  return rank[a] >= rank[b] ? a : b;
}

// ── Display ──

function normalizeModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+\//, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '')
    .replace(/\[1m\]/gi, '');
}

/**
 * Short display label for model IDs. Keeps historical Claude family labels
 * compact while normalizing common OpenAI labels.
 */
export function shortModelName(modelId: string): string {
  const normalized = normalizeModelId(modelId);
  const parsed = parseModelId(normalized);

  if (normalized.includes('codex')) return 'Codex';
  if (parsed?.provider === 'anthropic') {
    const family = parsed.family.toLowerCase();
    return family.charAt(0).toUpperCase() + family.slice(1);
  }

  if (parsed?.provider === 'openai') {
    if (parsed.family === 'o') return `o${parsed.version}`;
    if (normalized.startsWith('gpt-4o-mini')) return 'GPT-4o mini';
    if (normalized.startsWith('gpt-4o')) return 'GPT-4o';
    if (parsed.family === 'gpt') return `GPT-${parsed.version}`;
  }

  return modelId;
}

const CLAUDE_FAMILY_RANK: Record<string, number> = {
  fable: 0,
  opus: 1,
  sonnet: 2,
  haiku: 3,
};

function versionRank(version: string | null): number {
  if (!version) return Number.MAX_SAFE_INTEGER;
  const numeric = Number(version.replace('-', '.').match(/[0-9]+(?:\.[0-9]+)?/)?.[0]);
  if (!Number.isFinite(numeric)) return Number.MAX_SAFE_INTEGER;
  return -numeric;
}

/**
 * Returns stable display metadata and a rank suitable for provider model menus.
 */
export function getModelDisplayInfo(modelId: string): ModelDisplayInfo {
  const parsed = parseModelId(modelId);
  const normalized = normalizeModelId(modelId);

  let rank = 1_000;
  if (parsed?.provider === 'anthropic') {
    rank = (CLAUDE_FAMILY_RANK[parsed.family] ?? 9) * 100 + versionRank(parsed.version);
  } else if (normalized.includes('codex')) {
    rank = 200;
  } else if (parsed?.provider === 'openai') {
    rank = parsed.family === 'gpt' ? 300 + versionRank(parsed.version) : 400 + versionRank(parsed.version);
  } else if (parsed?.provider === 'google') {
    rank = 500 + versionRank(parsed.version);
  }

  return {
    modelId,
    provider: parsed?.provider ?? null,
    family: parsed?.family ?? null,
    version: parsed?.version ?? null,
    shortName: shortModelName(modelId),
    rank,
  };
}

/** Compare two model IDs using shared provider/family ranking rules. */
export function compareModelIds(a: string, b: string): number {
  const left = getModelDisplayInfo(a);
  const right = getModelDisplayInfo(b);
  if (left.rank !== right.rank) return left.rank - right.rank;
  return a.localeCompare(b);
}

/** Return a sorted copy of model IDs using shared provider/family ranking rules. */
export function sortModelIds<T extends string>(modelIds: readonly T[]): T[] {
  return [...modelIds].sort(compareModelIds) as T[];
}

/**
 * Formats a USD cost as a currency string.
 *
 * - `null` / `undefined` → `"—"` (honest "pricing unavailable").
 * - `< $0.01` → 4 decimals, so sub-cent costs are still visible.
 * - otherwise → 2 decimals.
 */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return '—';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
