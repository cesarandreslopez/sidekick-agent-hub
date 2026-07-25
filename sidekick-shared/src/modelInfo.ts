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

/**
 * Token usage for the legacy cost calculation contract.
 * @deprecated Use NormalizedUsage and calculateNormalizedUsageCost. This shape
 * cannot state whether reasoning is already included in output.
 */
export interface CostTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /**
   * Legacy disjoint reasoning category. The compatibility calculator always
   * adds it at the output rate, even when a provider already included it in
   * output. Use NormalizedUsage to state inclusion semantics.
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

/**
 * Input for the legacy cost calculation contract.
 * @deprecated Use NormalizedUsageCostInput.
 */
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
  // Sonnet 5 carries the standard rate here. The introductory $2/$10 (through
  // 2026-08-31) arrives via catalog hydration, which supersedes this baseline.
  // Sonnet 5 is $2/$10, not the $3/$15 every earlier Sonnet charged, and it
  // carries no >200K surcharge the way Sonnet 4.5 does. The catalog agrees
  // across all eleven of its Sonnet 5 entries.
  'claude-sonnet-5': {
    inputCostPerMillion: 2.0,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.2,
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
  'claude-opus-5': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
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
  'claude-opus-4-5': {
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
  // The `-tts`, `-transcribe`, and `-realtime-preview` variants also bill above
  // the key they inherit, but no coding agent routes to them, so they are left
  // out rather than carried here. Catalog hydration still prices them correctly.
  'gpt-4.1-mini': {
    inputCostPerMillion: 0.4,
    outputCostPerMillion: 1.6,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.1,
  },
  'gpt-4.1-nano': {
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.4,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.025,
  },
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
  // The launch snapshot kept its original $5/$15 when gpt-4o was cut to
  // $2.50/$10, so a pinned id must not read the current rate.
  'gpt-4o-2024-05-13': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
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

  // ── OpenAI: GPT-5 family ──
  // Published rates, verified against the LiteLLM catalog. Runtime hydration
  // still supersedes these; they are the offline baseline.
  //
  // Every tier that ships at a rate of its own needs an entry of its own. Keys
  // are matched longest-first, so a `-mini`/`-nano`/`-pro` variant with no entry
  // silently inherits its base model's rate and reports a wrong number rather
  // than none — `gpt-5-nano` read 25x its true cost this way.
  'gpt-5.6-sol': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 30.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'gpt-5.6-terra': {
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 3.13,
    cacheReadCostPerMillion: 0.25,
  },
  'gpt-5.6-luna': {
    inputCostPerMillion: 1.0,
    outputCostPerMillion: 6.0,
    cacheWriteCostPerMillion: 1.25,
    cacheReadCostPerMillion: 0.1,
  },
  'gpt-5.6': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 30.0,
    cacheWriteCostPerMillion: 6.25,
    cacheReadCostPerMillion: 0.5,
  },
  'gpt-5.5-pro': {
    inputCostPerMillion: 30.0,
    outputCostPerMillion: 180.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 3.0,
  },
  'gpt-5.5': {
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 30.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.5,
  },
  'gpt-5.4-mini': {
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 4.5,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.07,
  },
  'gpt-5.4-nano': {
    inputCostPerMillion: 0.2,
    outputCostPerMillion: 1.25,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.02,
  },
  'gpt-5.4-pro': {
    inputCostPerMillion: 30.0,
    outputCostPerMillion: 180.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 3.0,
  },
  'gpt-5.4': {
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 15.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.25,
  },
  'gpt-5.3-codex': {
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.175,
  },
  'gpt-5.3-chat-latest': {
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.175,
  },
  // No bare `gpt-5.3` ships in the catalog; both real variants above are
  // $1.75/$14. This entry stays an estimate and only answers ids that match
  // neither variant.
  'gpt-5.3': {
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.125,
  },
  'gpt-5.2-pro': {
    inputCostPerMillion: 21.0,
    outputCostPerMillion: 168.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
  },
  // Also answers `gpt-5.2-codex` and `gpt-5.2-chat*`, which bill at this rate.
  'gpt-5.2': {
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.175,
  },
  'gpt-5.1-codex-mini': {
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 2.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.025,
  },
  'gpt-5-pro': {
    inputCostPerMillion: 15.0,
    outputCostPerMillion: 120.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
  },
  'gpt-5-mini': {
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 2.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.025,
  },
  'gpt-5-nano': {
    inputCostPerMillion: 0.05,
    outputCostPerMillion: 0.4,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.005,
  },
  'gpt-5': {
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.125,
  },

  // ── OpenAI: o-series (reasoning models) ──
  // The `-pro` and deep-research tiers cost an order of magnitude more than the
  // base model whose key they would otherwise match.
  'o3-deep-research': {
    inputCostPerMillion: 10.0,
    outputCostPerMillion: 40.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 2.5,
  },
  'o3-mini': {
    inputCostPerMillion: 1.1,
    outputCostPerMillion: 4.4,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.55,
  },
  'o3-pro': {
    inputCostPerMillion: 20.0,
    outputCostPerMillion: 80.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
  },
  o3: {
    inputCostPerMillion: 2.0,
    outputCostPerMillion: 8.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.5,
  },
  // OpenAI cut o1-mini to $1.10/$4.40 after launch; $3/$12 was the launch rate.
  // No bare catalog key settles it — Azure's $1.21/$4.84 is its usual 1.1x
  // uplift on exactly this number, and Replicate's OpenAI passthrough agrees.
  'o1-mini': {
    inputCostPerMillion: 1.1,
    outputCostPerMillion: 4.4,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.55,
  },
  'o1-pro': {
    inputCostPerMillion: 150.0,
    outputCostPerMillion: 600.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
  },
  o1: {
    inputCostPerMillion: 15.0,
    outputCostPerMillion: 60.0,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 7.5,
  },
};

/** Static-table keys sorted longest-first so longest-prefix wins. */
const STATIC_SORTED_KEYS = Object.keys(PRICING_TABLE).sort((a, b) => b.length - a.length);

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
  overrideSortedKeys = Object.keys(overrideTable).sort((a, b) => b.length - a.length);
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

// Anthropic writes the minor version with a hyphen in modern IDs
// (`claude-sonnet-4-6-20260321`) and a dot in older ones
// (`claude-sonnet-4.5-20241022`). Accept both, then normalize to a dot.
// The `{1,2}` bound plus the trailing `(?![0-9])` keep the 8-digit release
// date from being mistaken for a minor version in `claude-opus-4-20250514`.
const CLAUDE_RE = /^claude-(haiku|sonnet|opus|fable)-([0-9]+(?:[-.][0-9]{1,2})?)(?![0-9])/i;
const LEGACY_CLAUDE_RE = /^claude-([0-9]+(?:[-.][0-9]+)?)-(haiku|sonnet|opus)(?:-|$)/i;
const GPT_RE = /^gpt-([0-9][0-9.A-Za-z-]*)/i;
const O_SERIES_RE = /^o([0-9]+)(-mini|-pro)?/i;
const GEMINI_RE = /^gemini-([0-9][0-9.A-Za-z-]*)/i;

/**
 * Parses a model ID into {provider, family, version}.
 *
 * Input is trimmed and lowercased before matching, so padded or mixed-case
 * IDs (e.g. " Claude-Opus-4-8 ") parse without caller-side normalization.
 *
 * Recognizes Anthropic (Claude), OpenAI (GPT + o-series), and Google (Gemini).
 * Returns null for anything else — callers should treat that as "unknown model".
 */
export function parseModelId(modelId: string): ParsedModelId | null {
  if (!modelId) return null;
  const normalized = modelId
    .replace(/\[1m\]/gi, '')
    .trim()
    .toLowerCase();

  const claude = normalized.match(CLAUDE_RE);
  if (claude) {
    return {
      provider: 'anthropic',
      family: claude[1].toLowerCase(),
      version: claude[2].replace('-', '.'),
    };
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

/** Override-then-static lookup, exact then longest-prefix at each stage. */
function lookupPricing(modelId: string): ModelPricing | null {
  if (overrideTable[modelId]) return overrideTable[modelId];
  const overridePrefix = findLongestPrefix(overrideSortedKeys, modelId);
  if (overridePrefix) return overrideTable[overridePrefix];

  if (PRICING_TABLE[modelId]) return PRICING_TABLE[modelId];
  const staticPrefix = findLongestPrefix(STATIC_SORTED_KEYS, modelId);
  if (staticPrefix) return PRICING_TABLE[staticPrefix];

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
 * The ID is first looked up verbatim (minus the "[1m]" suffix) — override
 * keys from the LiteLLM catalog are stored as published and may be
 * mixed-case — then retried trimmed/lowercased so padded or mixed-case IDs
 * resolve against the lowercase tables.
 *
 * @returns Pricing for the model, or null if unknown. No silent fallback.
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  if (!modelId) return null;
  const stripped = modelId.replace(/\[1m\]/gi, '');

  const direct = lookupPricing(stripped);
  if (direct) return direct;

  const normalized = stripped.trim().toLowerCase();
  return normalized === stripped ? null : lookupPricing(normalized);
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
 * Legacy behavior treats reasoning as disjoint and adds it at the output rate.
 * @deprecated Use calculateNormalizedUsageCost. This legacy function always
 * adds reasoning to output and cannot represent provider inclusion semantics.
 */
export function calculateCostWithPricing(usage: CostTokenUsage, pricing: ModelPricing): number {
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
 * @deprecated Use calculateNormalizedUsageCost.
 */
export function calculateCost(usage: CostTokenUsage, modelId: string): number | null {
  const pricing = getModelPricing(modelId);
  if (!pricing) return null;
  return calculateCostWithPricing(usage, pricing);
}

/**
 * Calculates cost while preserving whether the value was provider-reported,
 * locally estimated from pricing, or unavailable because the model is unpriced.
 * @deprecated Use calculateNormalizedUsageCost.
 */
export function calculateCostWithProvenance(input: CostProvenanceInput): CostWithProvenance {
  if (typeof input.reportedCostUsd === 'number' && Number.isFinite(input.reportedCostUsd)) {
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
    rank =
      parsed.family === 'gpt'
        ? 300 + versionRank(parsed.version)
        : 400 + versionRank(parsed.version);
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
