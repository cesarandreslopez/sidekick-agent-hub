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
 *   3. Catalog overrides — `max_input_tokens` from the LiteLLM catalog, hydrated
 *      by `pricingCatalog.ts`. Keeps new models correct without a code change.
 *   4. The static table below — offline baseline of last resort.
 *
 * Within that order, match quality comes first: every layer is tried for an
 * exact hit before any layer is tried for a prefix hit. See
 * `getModelContextWindowSize`.
 *
 * Layers 2 and 3 are pushed in by Node-only modules through the `_set*` hooks,
 * so this file stays browser-safe (no node:fs, no fetch) and can be bundled for
 * webviews. Same pattern as `_setPricingOverrides` in `modelInfo.ts`.
 */

/** Known model context window sizes (in tokens). */
const MODEL_CONTEXT_SIZES: Record<string, number> = {
  // Claude — native 1M context (Fable 5, Opus 4.6+, Sonnet 4.6+)
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
  // OpenAI GPT-5 series (keys sorted longest-first below; explicit entries
  // for every variant so prefix matching can't misclassify a new one).
  // These are published model maxima. Codex reports a smaller *effective*
  // window per account tier via token_count; that value wins through the
  // observed-override layer.
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.6': 1_050_000,
  'gpt-5.5': 1_050_000,
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

// ── Override Tables (populated at runtime by Node-only modules) ──

let observedTable: Record<string, number> = {};
let observedSortedKeys: string[] = [];
let catalogTable: Record<string, number> = {};
let catalogSortedKeys: string[] = [];

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

// ── Lookup ──

/** Exact match against one table. */
function exactWindow(table: Record<string, number>, modelId: string): number | null {
  const hit = table[modelId];
  return hit === undefined ? null : hit;
}

/** Longest-prefix match against one table. */
function prefixWindow(
  table: Record<string, number>,
  sortedKeys: string[],
  modelId: string,
): number | null {
  for (const key of sortedKeys) {
    if (modelId.startsWith(key)) return table[key];
  }
  return null;
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
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;

  // Claude Code tags the 1M-context variant with a "[1m]" suffix on the
  // model ID. If we see it, honor it regardless of the base family.
  if (/\[1m\]/i.test(modelId)) return 1_000_000;

  // Strip the suffix if present, so the normal lookup still succeeds when
  // a caller passes e.g. "claude-opus-5[1m]" and we've already handled it.
  // Trim/lowercase so padded or mixed-case IDs match the lowercase table keys.
  const normalized = modelId
    .replace(/\[1m\]/gi, '')
    .trim()
    .toLowerCase();

  // Pass 1 — exact matches, most-trusted layer first.
  const exact =
    exactWindow(observedTable, normalized) ??
    exactWindow(catalogTable, normalized) ??
    exactWindow(MODEL_CONTEXT_SIZES, normalized);
  if (exact !== null) return exact;

  // Pass 2 — longest-prefix matches, same layer order. Resolves versioned IDs
  // that no layer spells out, e.g. "claude-opus-4-6-20250414".
  const prefix =
    prefixWindow(observedTable, observedSortedKeys, normalized) ??
    prefixWindow(catalogTable, catalogSortedKeys, normalized) ??
    prefixWindow(MODEL_CONTEXT_SIZES, SORTED_KEYS, normalized);
  if (prefix !== null) return prefix;

  return DEFAULT_CONTEXT_WINDOW;
}
