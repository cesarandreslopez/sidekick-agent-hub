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
 * - A consumer layer (`registerModelPricing`) sits beside the catalog and
 *   imported layers and survives their resets.
 * - Every table-derived value is computed lazily, so a tree-shaken bundle that
 *   only uses the parsing/display helpers does not retain the pricing table.
 *
 * @module modelInfo
 */

import { getModelContextWindowSize } from './modelContext';
import { resolveModelAlias } from './modelAliases';
import { ownValue } from './ownKey';
import type { ModelProviderId } from './providerIds';
import type { PricingProvenance } from './usageNormalization';

export { MODEL_PROVIDER_IDS } from './providerIds';
export { formatCost } from './formatting';
export type { FormatCostOptions } from './formatting';

// ── Types ──

/** Pricing information for a model. All costs are per million tokens in USD. */
export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheWriteCostPerMillion: number;
  cacheReadCostPerMillion: number;
}

/**
 * Which layer answered a pricing lookup.
 *
 * - `registered` — an entry supplied through `registerModelPricing` (consumer
 *   configuration such as negotiated prices). Always an exact match.
 * - `imported` — an exact resolution imported from another realm via
 *   `importResolvedModelCatalog`.
 * - `catalog` — the runtime LiteLLM catalog (`hydratePricingCatalog`).
 * - `static` — the offline baseline shipped with this package.
 * - `none` — unpriced.
 */
export type ModelPricingSource = 'registered' | 'imported' | 'catalog' | 'static' | 'none';
export type ModelPricingMatch = 'exact' | 'prefix' | 'none';

export interface ModelPricingProvenance {
  source: ModelPricingSource;
  match: ModelPricingMatch;
  matchedModelId?: string;
  /** True when the price was inherited from a shorter model-ID prefix. */
  inheritedByPrefix: boolean;
}

export interface ResolvedModelPricing {
  modelId: string;
  /**
   * The looked-up id trimmed, lowercased, without `[1m]`, and resolved through
   * registered aliases. Deployment prefixes and date suffixes are kept, so
   * this is not the same value as `canonicalModelId(modelId)`.
   */
  canonicalModelId: string;
  pricing: ModelPricing | null;
  provenance: ModelPricingProvenance;
}

export interface ResolveModelPricingOptions {
  /**
   * Consult entries from `registerModelPricing`. Defaults to true; pass false
   * to see what the package's own layers would answer.
   */
  includeRegistered?: boolean;
}

export interface RegisterModelPricingOptions {
  /**
   * `false` (default): the entry wins over every other layer — explicit
   * configuration such as negotiated prices.
   *
   * `true`: the entry is a gap filler. It is used only when no other layer has
   * an exact price for the looked-up id (its raw form or registered alias
   * target), so it replaces a prefix-inherited or missing price but never an
   * exact static, catalog, or imported one.
   */
  onlyIfMissing?: boolean;
}

/** Where the active pricing tables came from. */
export type PricingCatalogSource = 'static' | 'litellm' | 'stale-cache' | 'imported';

/** Describes the pricing basis currently applied to cost estimates. */
export interface PricingCatalogInfo {
  /**
   * `litellm` — catalog loaded from a fresh fetch or a cache within its TTL;
   * `stale-cache` — catalog loaded from a cache older than its TTL (the
   * refresh failed or was skipped offline); `imported` — no catalog, but
   * resolutions imported from another realm are active; `static` — only the
   * built-in baseline. Registered entries never change the source.
   */
  source: PricingCatalogSource;
  /** When the active catalog was fetched, if known. Only set for catalog sources. */
  fetchedAt?: string;
  /**
   * Stable, non-cryptographic fingerprint (`fnv1a64:<16 hex>`) of the active
   * static, catalog, imported, and registered pricing tables. Equal digests
   * mean equal prices; it changes whenever any price in any layer changes.
   * Registered aliases are not part of it.
   */
  digest: string;
  /** Entries in the runtime catalog layer. */
  catalogEntries: number;
  /** Entries in the `registerModelPricing` layer. */
  registeredEntries: number;
}

/**
 * Internal: how the catalog overrides were obtained, recorded by
 * `pricingCatalog.ts` alongside `_setPricingOverrides`.
 */
export interface PricingOverridesBasis {
  source: 'litellm' | 'stale-cache';
  fetchedAt?: string;
}

/** One contribution to a cost rollup, for `mergeCostComponents`. */
export interface CostComponent {
  /** Provenance of this component's cost; undefined means nothing seen yet. */
  source?: CostSource;
  /** Tokens this component contributed. */
  tokens: number;
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
export type ModelProvider = ModelProviderId;

/** Structured result of parsing a raw model ID. */
export interface ParsedModelId {
  provider: ModelProvider;
  family: string;
  version: string;
  /**
   * GPT tier name (`astra`, `sol`, `terra`, `luna`) when the id carries one,
   * e.g. `gpt-6.1-sol` → `sol`. `version` still includes it (`6.1-sol`).
   * Absent for every other id.
   */
  variant?: string;
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
 *   - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   - OpenAI: https://developers.openai.com/api/docs/models
 * Current Anthropic and GPT-5.6/6 rates verified: 2026-09-22.
 * Runtime LiteLLM hydration refreshes this offline baseline.
 *
 * Anthropic keys appear in both dashed (`claude-opus-4-8`, the real model-ID
 * form) and dotted (`claude-opus-4.8`, the LiteLLM catalog form) spellings —
 * prefix matching cannot bridge the two, so both are needed.
 */
const PRICING_TABLE: Record<string, ModelPricing> = {
  // Current coding models verified 2026-10-30. Standard short-context rates;
  // DeepSeek uses peak rates. Gemini promotions end 2026-11-30 (Argon) and
  // 2026-12-31 (Flash). Haiku 5.5 costs more above 100K prompt tokens.
  // Sources and estimation limits: docs/configuration/model-resolution.md.
  // Explicit direct-provider keys support offline OpenCode model IDs without
  // stripping arbitrary deployment prefixes or changing alias resolution.
  'gpt-6.1-sol': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.1,
  },
  'openai/gpt-6.1-sol': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.1,
  },
  'gpt-6.1-terra': {
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    cacheWriteCostPerMillion: 1.25,
    cacheReadCostPerMillion: 0.05,
  },
  'openai/gpt-6.1-terra': {
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    cacheWriteCostPerMillion: 1.25,
    cacheReadCostPerMillion: 0.05,
  },
  'claude-sonnet-5-5': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.1,
  },
  'anthropic/claude-sonnet-5-5': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.1,
  },
  'claude-sonnet-5.5': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.1,
  },
  'anthropic/claude-sonnet-5.5': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.1,
  },
  'claude-haiku-5-5': {
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 0.125,
    cacheReadCostPerMillion: 0.01,
  },
  'anthropic/claude-haiku-5-5': {
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 0.125,
    cacheReadCostPerMillion: 0.01,
  },
  'claude-haiku-5.5': {
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 0.125,
    cacheReadCostPerMillion: 0.01,
  },
  'anthropic/claude-haiku-5.5': {
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 0.125,
    cacheReadCostPerMillion: 0.01,
  },
  'gemini-4-argon': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.1,
  },
  'gemini/gemini-4-argon': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.1,
  },
  'gemini-3.8-flash': {
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 3.75,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.075,
  },
  'gemini/gemini-3.8-flash': {
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 3.75,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.075,
  },
  'deepseek-flash': {
    inputCostPerMillion: 0.3,
    outputCostPerMillion: 1.2,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.006,
  },
  'deepseek/deepseek-flash': {
    inputCostPerMillion: 0.3,
    outputCostPerMillion: 1.2,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.006,
  },
  'deepseek-v4-flash': {
    inputCostPerMillion: 0.3,
    outputCostPerMillion: 1.2,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.006,
  },
  'deepseek/deepseek-v4-flash': {
    inputCostPerMillion: 0.3,
    outputCostPerMillion: 1.2,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.006,
  },
  'deepseek-v4-flash-vision-exp': {
    inputCostPerMillion: 0.3,
    outputCostPerMillion: 1.2,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.006,
  },
  'deepseek/deepseek-v4-flash-vision-exp': {
    inputCostPerMillion: 0.3,
    outputCostPerMillion: 1.2,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.006,
  },
  'deepseek-v4-pro': {
    inputCostPerMillion: 1.32,
    outputCostPerMillion: 3.96,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.044,
  },
  'deepseek/deepseek-v4-pro': {
    inputCostPerMillion: 1.32,
    outputCostPerMillion: 3.96,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.044,
  },
  'glm-5.3': {
    inputCostPerMillion: 1.4,
    outputCostPerMillion: 4.4,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.26,
  },
  'zai/glm-5.3': {
    inputCostPerMillion: 1.4,
    outputCostPerMillion: 4.4,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.26,
  },
  'glm-5.3-flash': {
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.03,
  },
  'zai/glm-5.3-flash': {
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.03,
  },
  'glm-5.3-flashx': {
    inputCostPerMillion: 0.37,
    outputCostPerMillion: 1.25,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.075,
  },
  'zai/glm-5.3-flashx': {
    inputCostPerMillion: 0.37,
    outputCostPerMillion: 1.25,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0.075,
  },

  // ── Anthropic: Claude ──
  // Fable 5.1 cache reads cost 0.025x input; Fable 5 retains its 0.1x rate.
  'claude-fable-5-1': {
    inputCostPerMillion: 10.0,
    outputCostPerMillion: 50.0,
    cacheWriteCostPerMillion: 12.5,
    cacheReadCostPerMillion: 0.25,
  },
  'claude-fable-5.1': {
    inputCostPerMillion: 10.0,
    outputCostPerMillion: 50.0,
    cacheWriteCostPerMillion: 12.5,
    cacheReadCostPerMillion: 0.25,
  },
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
  // Sonnet 5's $2/$10 introductory rate is now permanent. Standard pricing
  // applies across its full 1M context window.
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
  // Opus 5.5 undercuts Opus 5; without its own keys it would prefix-match 'claude-opus-5'.
  'claude-opus-5-5': {
    inputCostPerMillion: 4.0,
    outputCostPerMillion: 20.0,
    cacheWriteCostPerMillion: 5.0,
    cacheReadCostPerMillion: 0.2,
  },
  'claude-opus-5.5': {
    inputCostPerMillion: 4.0,
    outputCostPerMillion: 20.0,
    cacheWriteCostPerMillion: 5.0,
    cacheReadCostPerMillion: 0.2,
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

  // ── OpenAI: GPT-5/6 families ──
  // Published rates, cross-checked with the LiteLLM catalog. Runtime hydration
  // still supersedes these; they are the offline baseline.
  //
  // Every tier that ships at a rate of its own needs an entry of its own. Keys
  // are matched longest-first, so a `-mini`/`-nano`/`-pro` variant with no entry
  // silently inherits its base model's rate and reports a wrong number rather
  // than none — `gpt-5-nano` read 25x its true cost this way.
  'gpt-6-astra': {
    inputCostPerMillion: 10.0,
    outputCostPerMillion: 50.0,
    cacheWriteCostPerMillion: 12.5,
    cacheReadCostPerMillion: 1.0,
  },
  'gpt-6-sol': {
    inputCostPerMillion: 2.0,
    outputCostPerMillion: 10.0,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.2,
  },
  'gpt-6-luna': {
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 0.125,
    cacheReadCostPerMillion: 0.01,
  },
  'gpt-5.6-sol': {
    inputCostPerMillion: 4.0,
    outputCostPerMillion: 20.0,
    cacheWriteCostPerMillion: 5.0,
    cacheReadCostPerMillion: 0.4,
  },
  'gpt-5.6-terra': {
    inputCostPerMillion: 2.0,
    outputCostPerMillion: 12.0,
    cacheWriteCostPerMillion: 2.5,
    cacheReadCostPerMillion: 0.2,
  },
  'gpt-5.6-luna': {
    inputCostPerMillion: 0.2,
    outputCostPerMillion: 1.2,
    cacheWriteCostPerMillion: 0.25,
    cacheReadCostPerMillion: 0.02,
  },
  // The GPT-5.6 alias routes to Sol.
  'gpt-5.6': {
    inputCostPerMillion: 4.0,
    outputCostPerMillion: 20.0,
    cacheWriteCostPerMillion: 5.0,
    cacheReadCostPerMillion: 0.4,
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
    cacheReadCostPerMillion: 0.075,
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

/**
 * Static-table keys sorted longest-first so longest-prefix wins. Computed on
 * first lookup rather than at module load: a top-level call would keep the
 * whole table alive in tree-shaken bundles that never price anything.
 */
let staticSortedKeys: string[] | null = null;

function getStaticSortedKeys(): string[] {
  if (!staticSortedKeys) {
    staticSortedKeys = Object.keys(PRICING_TABLE).sort((a, b) => b.length - a.length);
  }
  return staticSortedKeys;
}

// ── Override Table (populated at runtime by pricingCatalog) ──

let overrideTable: Record<string, ModelPricing> = {};
let overrideSortedKeys: string[] = [];
let overrideBasis: PricingOverridesBasis | null = null;
let importedTable: Record<string, ResolvedModelPricing> = {};

/**
 * Internal: replace the runtime override map. Called by `pricingCatalog.ts`
 * after a successful LiteLLM hydration. Not part of the stable public API,
 * but exported so the Node-only catalog module can wire itself in without
 * creating a circular import.
 *
 * `basis` records how the map was obtained for `getPricingCatalogInfo()`;
 * omitted, a non-empty map reports as `litellm` with no `fetchedAt`. Every
 * call replaces the previous basis.
 */
export function _setPricingOverrides(
  overrides: Record<string, ModelPricing>,
  basis?: PricingOverridesBasis,
): void {
  overrideTable = Object.fromEntries(
    Object.entries(overrides).map(([key, value]) => [key.trim().toLowerCase(), { ...value }]),
  );
  overrideSortedKeys = Object.keys(overrideTable).sort((a, b) => b.length - a.length);
  overrideBasis = basis ? { ...basis } : null;
  invalidatePricingDigest();
}

/** Internal: snapshot current overrides (test + diagnostics). */
export function _getPricingOverrides(): Record<string, ModelPricing> {
  return { ...overrideTable };
}

/** Internal: clear overrides (used by tests and when disabling hydration). */
export function _clearPricingOverrides(): void {
  overrideTable = {};
  overrideSortedKeys = [];
  overrideBasis = null;
  invalidatePricingDigest();
}

/**
 * Internal: hydrate exact pricing resolutions exported by another realm.
 * Merges so successive partial imports accumulate (aliases already merge);
 * use `_clearImportedResolvedPricing` to reset.
 */
export function _setImportedResolvedPricing(values: Record<string, ResolvedModelPricing>): void {
  importedTable = { ...importedTable, ...values };
  invalidatePricingDigest();
}

/** Internal test hook. */
export function _clearImportedResolvedPricing(): void {
  importedTable = {};
  invalidatePricingDigest();
}

// ── Registered Table (consumer configuration) ──

interface RegisteredPricingEntry {
  pricing: ModelPricing;
  onlyIfMissing: boolean;
}

// A Map (created on first registration) so keys such as `__proto__` stay data.
let registeredTable: Map<string, RegisteredPricingEntry> | null = null;

function isValidModelPricing(value: unknown): value is ModelPricing {
  if (!value || typeof value !== 'object') return false;
  const pricing = value as Record<string, unknown>;
  return [
    pricing.inputCostPerMillion,
    pricing.outputCostPerMillion,
    pricing.cacheWriteCostPerMillion,
    pricing.cacheReadCostPerMillion,
  ].every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0);
}

/**
 * Register consumer pricing for model ids, e.g. negotiated or private-deployment
 * rates. This layer is separate from the runtime catalog and imported layers:
 * `_setPricingOverrides`, `hydratePricingCatalog`, and
 * `importResolvedModelCatalog` never reset it; only
 * `clearRegisteredModelPricing` does.
 *
 * Keys are trimmed, lowercased, and stripped of `[1m]`, like the other tables.
 * Matching is exact, never by prefix, against the looked-up id, its registered
 * alias target, and its `canonicalModelId()` form — so a `claude-opus-5-5`
 * entry also answers `claude-opus-5-5-20261001` and
 * `us.anthropic.claude-opus-5-5-20261001-v1:0`.
 *
 * Successive calls merge; re-registering a key replaces its price and mode.
 * Entries whose four rates are not all finite, nonnegative numbers are
 * skipped. Results carry `provenance.source: 'registered'`.
 *
 * Registered entries are realm-local configuration and are kept out of
 * cross-realm snapshots: they are not listed by the catalog id enumeration,
 * and `resolveModelPricing(id, { includeRegistered: false })` is the
 * resolution a snapshot should carry. An exported price would otherwise be
 * pinned as an exact import in the other realm and outlive
 * `clearRegisteredModelPricing` there. Register in each realm instead.
 */
export function registerModelPricing(
  entries: Record<string, ModelPricing>,
  options?: RegisterModelPricingOptions,
): void {
  const onlyIfMissing = options?.onlyIfMissing === true;
  let changed = false;
  for (const [key, value] of Object.entries(entries ?? {})) {
    const id = key
      .replace(/\[1m\]/gi, '')
      .trim()
      .toLowerCase();
    if (!id || !isValidModelPricing(value)) continue;
    registeredTable ??= new Map();
    registeredTable.set(id, {
      pricing: {
        inputCostPerMillion: value.inputCostPerMillion,
        outputCostPerMillion: value.outputCostPerMillion,
        cacheWriteCostPerMillion: value.cacheWriteCostPerMillion,
        cacheReadCostPerMillion: value.cacheReadCostPerMillion,
      },
      onlyIfMissing,
    });
    changed = true;
  }
  if (changed) invalidatePricingDigest();
}

/** Remove every entry added by `registerModelPricing`. */
export function clearRegisteredModelPricing(): void {
  if (registeredTable && registeredTable.size > 0) invalidatePricingDigest();
  registeredTable = null;
}

function findRegisteredPricing(
  rawId: string,
  aliasId: string,
): { id: string; entry: RegisteredPricingEntry } | null {
  if (!registeredTable || registeredTable.size === 0) return null;
  const canonical = canonicalModelId(rawId);
  for (const id of [rawId, aliasId, canonical, resolveModelAlias(canonical)]) {
    const entry = registeredTable.get(id);
    if (entry) return { id, entry };
  }
  return null;
}

// ── Pricing Basis ──

let pricingDigestMemo: string | null = null;

function invalidatePricingDigest(): void {
  pricingDigestMemo = null;
}

/** JSON with object keys sorted at every level; `undefined` members are dropped. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * 64-bit FNV-1a over the UTF-8 bytes of `text`, as 16 lowercase hex digits.
 * Uses four 16-bit limbs so it runs on plain numbers in every JS runtime.
 */
function fnv1a64Hex(text: string): string {
  // Offset basis 0xcbf29ce484222325, least significant limb first.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  const mix = (byte: number): void => {
    h0 ^= byte;
    // Multiply by the FNV prime 0x100000001b3 = 2^40 + 0x1b3, mod 2^64.
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + (h0 << 8) + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + (h1 << 8) + (t2 >>> 16);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  };
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      const low = code <= 0xdbff && i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        // A lone surrogate encodes as U+FFFD, as TextEncoder does.
        code = 0xfffd;
      }
    }
    if (code < 0x80) {
      mix(code);
    } else if (code < 0x800) {
      mix(0xc0 | (code >> 6));
      mix(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      mix(0xe0 | (code >> 12));
      mix(0x80 | ((code >> 6) & 0x3f));
      mix(0x80 | (code & 0x3f));
    } else {
      mix(0xf0 | (code >> 18));
      mix(0x80 | ((code >> 12) & 0x3f));
      mix(0x80 | ((code >> 6) & 0x3f));
      mix(0x80 | (code & 0x3f));
    }
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, '0')).join('');
}

function getPricingDigest(): string {
  if (pricingDigestMemo === null) {
    const imported: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(importedTable)) {
      imported[id] = { pricing: entry.pricing, provenance: entry.provenance };
    }
    const registered: Record<string, unknown> = {};
    for (const [id, entry] of registeredTable ?? []) {
      registered[id] = { pricing: entry.pricing, onlyIfMissing: entry.onlyIfMissing };
    }
    const payload = canonicalJson({
      v: 1,
      static: PRICING_TABLE,
      catalog: overrideTable,
      imported,
      registered,
    });
    pricingDigestMemo = `fnv1a64:${fnv1a64Hex(payload)}`;
  }
  return pricingDigestMemo;
}

/**
 * Describe the pricing basis behind current cost estimates: which layer the
 * prices come from, when the catalog was fetched, and a digest that changes
 * whenever any active price changes. Pure and cheap after the first call (the
 * digest is memoized until a table changes).
 */
export function getPricingCatalogInfo(): PricingCatalogInfo {
  const catalogEntries = overrideSortedKeys.length;
  let source: PricingCatalogSource = 'static';
  if (catalogEntries > 0) {
    source = overrideBasis?.source ?? 'litellm';
  } else if (Object.keys(importedTable).length > 0) {
    source = 'imported';
  }
  const fetchedAt = catalogEntries > 0 ? overrideBasis?.fetchedAt : undefined;
  return {
    source,
    ...(fetchedAt ? { fetchedAt } : {}),
    digest: getPricingDigest(),
    catalogEntries,
    registeredEntries: registeredTable?.size ?? 0,
  };
}

/** Internal: list every ID known to the pricing resolver. */
export function _getModelPricingIds(): string[] {
  return Array.from(
    new Set([
      ...Object.keys(PRICING_TABLE),
      ...Object.keys(overrideTable),
      ...Object.keys(importedTable),
    ]),
  );
}

// ── Model ID Canonicalization ──

// Bedrock: optional cross-region prefix (`us.`, `eu.`, `apac.`, `global.`, …)
// then the vendor segment, e.g. `us.anthropic.claude-opus-5-5-20261001-v1:0`.
const BEDROCK_ANTHROPIC_RE = /^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\.)?anthropic\./;
// Bedrock revision tag (`-v1:0`, `-v1`), only after a version or date digit so
// legacy names such as `claude-v2:1` and `claude-instant-v1` keep theirs.
const BEDROCK_REVISION_RE = /([0-9])-v[0-9]+(?::[0-9]+)?$/;
const VERTEX_VERSION_RE = /@(?:[0-9]{8}|latest)$/;
const LATEST_SUFFIX_RE = /-latest$/;
const DASHED_DATE_SUFFIX_RE = /-[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const COMPACT_DATE_SUFFIX_RE = /-[0-9]{8}$/;

/**
 * Reduce a model id to the bare model name it denotes, for grouping and
 * matching across hosts and snapshots.
 *
 * Trims and lowercases, then removes: `[1m]`; every leading `segment/`
 * provider or region prefix (`azure/us/gpt-6.1-terra` → `gpt-6.1-terra`);
 * Bedrock forms (`us.anthropic.claude-opus-5-5-20261001-v1:0` →
 * `claude-opus-5-5`, also `eu.`/`apac.`/`global.` and bare `anthropic.`);
 * Vertex `@YYYYMMDD`; trailing `-YYYYMMDD` and `-YYYY-MM-DD` dates; `-latest`.
 * Meaningful suffixes (`-mini`, `-codex`, `-sol`, `-terra`, `-high`, …) stay.
 *
 * Pure and syntactic: registered aliases are not applied (see
 * `resolveModelAlias`). Pricing lookups do not use this to reach other
 * models' prices — dated snapshots and deployments can bill differently — only
 * to match `registerModelPricing` entries.
 */
export function canonicalModelId(id: string): string {
  let value = String(id ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[1m\]/g, '')
    .trim();

  const slash = value.lastIndexOf('/');
  if (slash >= 0 && slash < value.length - 1) value = value.slice(slash + 1);

  const bedrock = BEDROCK_ANTHROPIC_RE.exec(value);
  if (bedrock && value.length > bedrock[0].length) {
    value = value.slice(bedrock[0].length).replace(BEDROCK_REVISION_RE, '$1');
  }

  // Suffixes can stack (`-20250101-latest`), so strip until nothing changes.
  for (;;) {
    const next = value
      .replace(VERTEX_VERSION_RE, '')
      .replace(LATEST_SUFFIX_RE, '')
      .replace(DASHED_DATE_SUFFIX_RE, '')
      .replace(COMPACT_DATE_SUFFIX_RE, '');
    if (next === value || !next) break;
    value = next;
  }
  return value;
}

// Names an agent CLI re-points at a different concrete model over time.
// An object literal rather than a Set keeps it free for tree-shaking.
const MOVING_MODEL_ALIASES: Record<string, true> = {
  default: true,
  auto: true,
  latest: true,
  sonnet: true,
  opus: true,
  haiku: true,
  fable: true,
  opusplan: true,
};

/**
 * True for model names an agent CLI resolves to a different concrete model
 * over time (`default`, `auto`, `latest`, `sonnet`, `opus`, `haiku`, `fable`,
 * and Claude Code's `opusplan`), so a recorded value names a moving target
 * rather than a model. Case-insensitive, trimmed, and `[1m]`-tolerant
 * (`sonnet[1m]`). Dated or versioned ids are never moving aliases.
 */
export function isMovingModelAlias(id: string): boolean {
  const value = String(id ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[1m\]/g, '')
    .trim();
  return Object.prototype.hasOwnProperty.call(MOVING_MODEL_ALIASES, value);
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
// GPT tier names, read from the parsed version (`6.1-sol`, `6-luna-2026-01-01`).
const GPT_TIER_VARIANT_RE = /^[0-9]+(?:\.[0-9]+)*-(astra|sol|terra|luna)(?=-|$)/;
const GPT_TIER_VARIANT_RANK: Record<string, number> = {
  astra: 0,
  sol: 1,
  terra: 2,
  luna: 3,
};

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
  const normalized = resolveModelAlias(modelId.replace(/\[1m\]/gi, ''));

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
    const version = gpt[1];
    const variant = GPT_TIER_VARIANT_RE.exec(version)?.[1];
    // The key is only present when set, so untiered results stay deep-equal
    // to what earlier releases returned.
    return variant
      ? { provider: 'openai', family: 'gpt', version, variant }
      : { provider: 'openai', family: 'gpt', version };
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

/** Find the longest shorter key in `keys` that is a prefix of `modelId`, or null. */
function findLongestPrefix(keys: string[], modelId: string): string | null {
  for (const key of keys) {
    if (modelId !== key && modelId.startsWith(key)) return key;
  }
  return null;
}

/**
 * Resolve pricing and disclose which layer answered and whether the result was
 * inherited by prefix.
 *
 * Order: registered entries (default mode); exact imported, catalog, and
 * static matches; registered `onlyIfMissing` entries; catalog then static
 * prefix matches; unpriced.
 */
export function resolveModelPricing(
  modelId: string,
  options?: ResolveModelPricingOptions,
): ResolvedModelPricing {
  const stripped = modelId.replace(/\[1m\]/gi, '');
  const rawId = stripped.trim().toLowerCase();
  const aliasId = resolveModelAlias(stripped);
  // The raw id is tried before its alias target at every step: pricing
  // recorded for the alias id itself is more specific than the canonical
  // fallback, so registering an alias never orphans it.
  const candidateIds = rawId === aliasId ? [aliasId] : [rawId, aliasId];

  const registered =
    options?.includeRegistered === false ? null : findRegisteredPricing(rawId, aliasId);
  const registeredResult = (match: { id: string; entry: RegisteredPricingEntry }) => ({
    modelId,
    canonicalModelId: aliasId,
    pricing: { ...match.entry.pricing },
    provenance: {
      source: 'registered' as const,
      match: 'exact' as const,
      matchedModelId: match.id,
      inheritedByPrefix: false,
    },
  });
  if (registered && !registered.entry.onlyIfMissing) return registeredResult(registered);

  const imported = ownValue(importedTable, rawId) ?? ownValue(importedTable, aliasId);
  if (imported) return { ...imported, modelId, canonicalModelId: aliasId };

  for (const id of candidateIds) {
    const exactOverride = ownValue(overrideTable, id);
    if (exactOverride) {
      return {
        modelId,
        canonicalModelId: aliasId,
        pricing: exactOverride,
        provenance: {
          source: 'catalog',
          match: 'exact',
          matchedModelId: id,
          inheritedByPrefix: false,
        },
      };
    }
  }

  for (const id of candidateIds) {
    const exactStatic = ownValue(PRICING_TABLE, id);
    if (exactStatic) {
      return {
        modelId,
        canonicalModelId: aliasId,
        pricing: exactStatic,
        provenance: {
          source: 'static',
          match: 'exact',
          matchedModelId: id,
          inheritedByPrefix: false,
        },
      };
    }
  }

  // A gap-filling registration answers once no layer has an exact price.
  if (registered) return registeredResult(registered);

  for (const id of candidateIds) {
    const overridePrefix = findLongestPrefix(overrideSortedKeys, id);
    if (overridePrefix) {
      return {
        modelId,
        canonicalModelId: aliasId,
        pricing: overrideTable[overridePrefix],
        provenance: {
          source: 'catalog',
          match: 'prefix',
          matchedModelId: overridePrefix,
          inheritedByPrefix: true,
        },
      };
    }
  }

  for (const id of candidateIds) {
    const staticPrefix = findLongestPrefix(getStaticSortedKeys(), id);
    if (staticPrefix) {
      return {
        modelId,
        canonicalModelId: aliasId,
        pricing: PRICING_TABLE[staticPrefix],
        provenance: {
          source: 'static',
          match: 'prefix',
          matchedModelId: staticPrefix,
          inheritedByPrefix: true,
        },
      };
    }
  }

  return {
    modelId,
    canonicalModelId: aliasId,
    pricing: null,
    provenance: { source: 'none', match: 'none', inheritedByPrefix: false },
  };
}

/**
 * Gets pricing for a model ID.
 *
 * Lookup order (see `resolveModelPricing` for provenance):
 *   1. Registered entries (`registerModelPricing`), exact matches only.
 *   2. Imported resolutions, then the runtime override map (from LiteLLM
 *      catalog hydration), then the static PRICING_TABLE — exact before prefix,
 *      with gap-filling registered entries between the two.
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
  return resolveModelPricing(modelId).pricing;
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

/**
 * Map the provenance `calculateNormalizedUsageCost` reports to the display
 * cost source: provider-reported costs are `reported`, costs computed from
 * explicit or catalog pricing are `estimated`, and unpriced stays `unpriced`.
 */
export function costSourceFromPricingProvenance(provenance: PricingProvenance): CostSource {
  switch (provenance) {
    case 'provider-reported':
      return 'reported';
    case 'explicit-pricing':
    case 'model-catalog':
      return 'estimated';
    default:
      return 'unpriced';
  }
}

/**
 * Merge the cost sources of a rollup's components, least certain winning (as
 * `mergeCostSources`). Components without a `source` have not been seen yet
 * and are ignored, and an `unpriced` component that contributed no tokens
 * does not taint the total. Returns `undefined` when nothing counted.
 */
export function mergeCostComponents(components: Iterable<CostComponent>): CostSource | undefined {
  let merged: CostSource | undefined;
  for (const component of components) {
    const source = component?.source;
    if (!source) continue;
    if (source === 'unpriced' && !(component.tokens > 0)) continue;
    merged = merged ? mergeCostSources(merged, source) : source;
  }
  return merged;
}

// ── Display ──

/**
 * Short display label for model IDs. Keeps historical Claude family labels
 * compact while normalizing common OpenAI labels.
 */
export function shortModelName(modelId: string): string {
  const normalized = canonicalModelId(modelId);
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
  const normalized = canonicalModelId(modelId);

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

/**
 * Order two GPT tier variants of the same family and numeric version
 * (astra > sol > terra > luna); 0 for every other pair.
 */
function compareTierVariants(a: string, b: string): number {
  const left = parseModelId(a);
  const right = parseModelId(b);
  if (!left?.variant || !right?.variant) return 0;
  if (left.provider !== right.provider || left.family !== right.family) return 0;
  if (versionRank(left.version) !== versionRank(right.version)) return 0;
  return (
    (GPT_TIER_VARIANT_RANK[left.variant] ?? Number.MAX_SAFE_INTEGER) -
    (GPT_TIER_VARIANT_RANK[right.variant] ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * Compare two model IDs using shared provider/family ranking rules. Within a
 * family and numeric version, GPT tiers rank astra > sol > terra > luna.
 */
export function compareModelIds(a: string, b: string): number {
  const left = getModelDisplayInfo(a);
  const right = getModelDisplayInfo(b);
  if (left.rank !== right.rank) return left.rank - right.rank;
  const variantOrder = compareTierVariants(a, b);
  if (variantOrder !== 0) return variantOrder;
  return a.localeCompare(b);
}

/** Return a sorted copy of model IDs using shared provider/family ranking rules. */
export function sortModelIds<T extends string>(modelIds: readonly T[]): T[] {
  return [...modelIds].sort(compareModelIds) as T[];
}
