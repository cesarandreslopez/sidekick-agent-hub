/**
 * Centralized model ID → context window size lookup.
 * Single source of truth used by all providers and the CLI dashboard.
 *
 * Resolution is layered, most-trusted first:
 *   1. Runtime-reported — providers that self-report their window (Codex) apply
 *      it in `getContextWindowLimit`, ahead of this module.
 *   2. Observed overrides — the last window a provider actually reported for a
 *      model, persisted across runs by `observedContextWindows.ts`. Reflects the
 *      effective window for this account/tier, which can be well below the
 *      model's published maximum.
 *   3. Imported resolutions — exact entries hydrated from another realm via
 *      `importResolvedModelCatalog()`. Below local observed data (a window this
 *      realm saw first-hand is fresher than a transferred snapshot), above the
 *      catalog.
 *   4. Catalog overrides — `max_input_tokens` from the LiteLLM catalog, hydrated
 *      by `pricingCatalog.ts`. Keeps new models correct without a code change.
 *   5. The static table below — offline baseline of last resort.
 *
 * Within that order, match quality comes first: every layer is tried for an
 * exact hit before any layer is tried for a prefix hit. See
 * `getModelContextWindowSize`. The raw (alias) id is tried before its
 * canonical target at every step, so registering an alias never orphans data
 * recorded under the alias itself.
 *
 * Layers 2 and 3 are pushed in by Node-only modules through the `_set*` hooks,
 * so this file stays browser-safe (no node:fs, no fetch) and can be bundled for
 * webviews. Same pattern as `_setPricingOverrides` in `modelInfo.ts`.
 */

import { resolveModelAlias } from './modelAliases';

/** Known model context window sizes (in tokens); current models verified 2026-09-05. */
const MODEL_CONTEXT_SIZES: Record<string, number> = {
  // Claude — native 1M context (Fable 5+, Opus 4.6+, Sonnet 4.6+)
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5.1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-7': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  // Claude 4 family
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  // Claude 3.5 family
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  // Claude 4.5 / Haiku
  'claude-haiku-4-5': 200_000,
  // Claude 3 family
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  // OpenAI GPT-4.1 series (1M context)
  'gpt-4.1': 1_048_576,
  // OpenAI GPT-5/6 series (keys sorted longest-first below; explicit entries
  // for every variant so prefix matching can't misclassify a new one).
  // These are published model maxima. Codex reports a smaller *effective*
  // window per account tier via token_count; that value wins through the
  // observed-override layer.
  'gpt-6-astra': 1_050_000,
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.6': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.4-nano': 400_000,
  'gpt-5.4': 1_050_000,
  'gpt-5.3-codex-spark': 128_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5': 400_000,
  // OpenAI reasoning
  o1: 200_000,
  o3: 200_000,
  o4: 200_000,
  // OpenAI GPT-4 series
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  // Gemini
  gemini: 1_000_000,
  // DeepSeek
  deepseek: 128_000,
};

/** Prefix keys sorted longest-first for correct prefix matching. */
const SORTED_KEYS = sortKeysLongestFirst(MODEL_CONTEXT_SIZES);

/** Default context window size when model is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export type ModelContextWindowSource =
  | 'explicit-1m'
  | 'imported'
  | 'observed'
  | 'catalog'
  | 'static'
  | 'default';
export type ModelCatalogMatch = 'exact' | 'prefix' | 'default';

export interface ModelContextWindowProvenance {
  source: ModelContextWindowSource;
  match: ModelCatalogMatch;
  matchedModelId?: string;
}

export interface ResolvedModelContextWindow {
  modelId: string;
  canonicalModelId: string;
  published: number | null;
  observed: number | null;
  tierEffective: number;
  provenance: ModelContextWindowProvenance;
}

// ── Override Tables (populated at runtime by Node-only modules) ──

let observedTable: Record<string, number> = {};
let observedSortedKeys: string[] = [];
let catalogTable: Record<string, number> = {};
let catalogSortedKeys: string[] = [];
let importedTable: Record<string, ResolvedModelContextWindow> = {};

function sortKeysLongestFirst(table: Record<string, number>): string[] {
  return Object.keys(table).sort((a, b) => b.length - a.length);
}

/**
 * Lowercase keys so lookups match regardless of how the source spelled them.
 * The LiteLLM catalog publishes some IDs mixed-case; the static table and the
 * lookup path are both lowercase. Drops non-positive and non-finite values.
 */
function normalizeOverrides(overrides: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    out[key.trim().toLowerCase()] = value;
  }
  return out;
}

/**
 * Internal: replace the observed-context-window map. Called by
 * `observedContextWindows.ts` on load and on each newly observed value.
 * Not part of the stable public API.
 */
export function _setObservedContextWindows(overrides: Record<string, number>): void {
  observedTable = normalizeOverrides(overrides);
  observedSortedKeys = sortKeysLongestFirst(observedTable);
}

/** Internal: snapshot observed overrides (test + diagnostics). */
export function _getObservedContextWindows(): Record<string, number> {
  return { ...observedTable };
}

/** Internal: clear observed overrides (used by tests). */
export function _clearObservedContextWindows(): void {
  observedTable = {};
  observedSortedKeys = [];
}

/**
 * Internal: replace the catalog-context-window map. Called by
 * `pricingCatalog.ts` after a successful LiteLLM hydration.
 * Not part of the stable public API.
 */
export function _setCatalogContextWindows(overrides: Record<string, number>): void {
  catalogTable = normalizeOverrides(overrides);
  catalogSortedKeys = sortKeysLongestFirst(catalogTable);
}

/** Internal: snapshot catalog overrides (test + diagnostics). */
export function _getCatalogContextWindows(): Record<string, number> {
  return { ...catalogTable };
}

/** Internal: clear catalog overrides (used by tests and when disabling hydration). */
export function _clearCatalogContextWindows(): void {
  catalogTable = {};
  catalogSortedKeys = [];
}

/**
 * Internal: hydrate exact, already-resolved context data from another realm.
 * Merges so successive partial imports accumulate (aliases already merge);
 * use `_clearImportedResolvedContextWindows` to reset.
 */
export function _setImportedResolvedContextWindows(
  values: Record<string, ResolvedModelContextWindow>,
): void {
  importedTable = { ...importedTable, ...values };
}

/** Internal test hook. */
export function _clearImportedResolvedContextWindows(): void {
  importedTable = {};
}

/** Internal: list every ID known to the context resolver. */
export function _getModelContextIds(): string[] {
  return Array.from(
    new Set([
      ...Object.keys(MODEL_CONTEXT_SIZES),
      ...Object.keys(catalogTable),
      ...Object.keys(observedTable),
      ...Object.keys(importedTable),
    ]),
  );
}

// ── Lookup ──

/** Exact match against one table. */
function exactWindow(table: Record<string, number>, modelId: string): number | null {
  const hit = table[modelId];
  return hit === undefined ? null : hit;
}

interface WindowMatch {
  value: number;
  match: Exclude<ModelCatalogMatch, 'default'>;
  matchedModelId: string;
}

function exactWindowMatch(table: Record<string, number>, modelId: string): WindowMatch | null {
  const exact = exactWindow(table, modelId);
  return exact === null ? null : { value: exact, match: 'exact', matchedModelId: modelId };
}

function prefixWindowMatch(
  table: Record<string, number>,
  sortedKeys: string[],
  modelId: string,
): WindowMatch | null {
  for (const key of sortedKeys) {
    if (modelId !== key && modelId.startsWith(key)) {
      return { value: table[key], match: 'prefix', matchedModelId: key };
    }
  }
  return null;
}

/** Resolve published, observed, and tier-effective context windows with provenance. */
export function resolveModelContextWindow(modelId?: string): ResolvedModelContextWindow {
  const rawModelId = modelId ?? '';
  const stripped = rawModelId
    .replace(/\[1m\]/gi, '')
    .trim()
    .toLowerCase();
  const canonicalModelId = resolveModelAlias(stripped);

  if (/\[1m\]/i.test(rawModelId) || /\[1m\]/i.test(canonicalModelId)) {
    return {
      modelId: rawModelId,
      canonicalModelId: canonicalModelId.replace(/\[1m\]/gi, ''),
      published: 1_000_000,
      observed: null,
      tierEffective: 1_000_000,
      provenance: { source: 'explicit-1m', match: 'exact', matchedModelId: canonicalModelId },
    };
  }

  // The raw id is tried before its alias target at every step: data recorded
  // for the alias id itself is more specific than the canonical fallback.
  const candidateIds =
    stripped === canonicalModelId ? [canonicalModelId] : [stripped, canonicalModelId];
  const firstMatch = (lookup: (id: string) => WindowMatch | null): WindowMatch | null => {
    for (const id of candidateIds) {
      const hit = lookup(id);
      if (hit) return hit;
    }
    return null;
  };

  const observedExact = firstMatch((id) => exactWindowMatch(observedTable, id));

  // Imported resolutions rank below local observed data: a window this realm
  // saw first-hand is fresher than a snapshot transferred from another realm.
  if (!observedExact) {
    const imported = importedTable[stripped] ?? importedTable[canonicalModelId];
    if (imported) {
      return { ...imported, modelId: rawModelId, canonicalModelId };
    }
  }

  const catalogExact = firstMatch((id) => exactWindowMatch(catalogTable, id));
  const staticExact = firstMatch((id) => exactWindowMatch(MODEL_CONTEXT_SIZES, id));
  const observedPrefix = firstMatch((id) =>
    prefixWindowMatch(observedTable, observedSortedKeys, id),
  );
  const catalogPrefix = firstMatch((id) => prefixWindowMatch(catalogTable, catalogSortedKeys, id));
  const staticPrefix = firstMatch((id) => prefixWindowMatch(MODEL_CONTEXT_SIZES, SORTED_KEYS, id));
  const published = catalogExact ?? staticExact ?? catalogPrefix ?? staticPrefix;
  const effective =
    observedExact ?? catalogExact ?? staticExact ?? observedPrefix ?? catalogPrefix ?? staticPrefix;

  return {
    modelId: rawModelId,
    canonicalModelId,
    published: published?.value ?? null,
    observed: (observedExact ?? observedPrefix)?.value ?? null,
    tierEffective: effective?.value ?? DEFAULT_CONTEXT_WINDOW,
    provenance: effective
      ? {
          source:
            effective === observedExact || effective === observedPrefix
              ? 'observed'
              : effective === catalogExact || effective === catalogPrefix
                ? 'catalog'
                : 'static',
          match: effective.match,
          matchedModelId: effective.matchedModelId,
        }
      : { source: 'default', match: 'default' },
  };
}

/**
 * Returns the context window size for a model ID.
 *
 * Input is trimmed and lowercased before lookup, so padded or mixed-case
 * IDs (e.g. "Claude-Opus-5 ") resolve without caller-side normalization.
 *
 * Lookup order:
 * 1. Explicit "[1m]" suffix (Claude Code's 1M-variant marker) → 1_000_000
 * 2. Exact match, most-trusted layer first: observed → catalog → static
 * 3. Longest-prefix match, same layer order
 *    (e.g. "claude-opus-4-6-20250414" → "claude-opus-4-6")
 * 4. DEFAULT_CONTEXT_WINDOW
 *
 * Match quality outranks layer trust: an exact hit in *any* layer beats a
 * prefix guess in *every* layer. Resolving each layer fully before moving on
 * would let a catalog key that merely happens to be a prefix shadow a curated
 * static entry — e.g. the catalog has no "claude-sonnet-4-7", and prefix-first
 * would hand it "claude-sonnet-4" (128K, a GitHub Copilot deployment) instead
 * of the static table's exact 1M.
 */
export function getModelContextWindowSize(modelId?: string): number {
  return resolveModelContextWindow(modelId).tierEffective;
}
