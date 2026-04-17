/**
 * Centralized model ID → context window size lookup.
 * Single source of truth used by all providers and the CLI dashboard.
 */

/** Known model context window sizes (in tokens). */
const MODEL_CONTEXT_SIZES: Record<string, number> = {
  // Claude — native 1M context (Opus 4.6+, Sonnet 4.6+)
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
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
  // for every variant so prefix matching can't misclassify a new one)
  'gpt-5.4': 1_050_000,
  'gpt-5.3-codex-spark': 128_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5': 400_000,
  // OpenAI reasoning
  'o1': 200_000,
  'o3': 200_000,
  'o4': 200_000,
  // OpenAI GPT-4 series
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  // Gemini
  'gemini': 1_000_000,
  // DeepSeek
  'deepseek': 128_000,
};

/** Prefix keys sorted longest-first for correct prefix matching. */
const SORTED_KEYS = Object.keys(MODEL_CONTEXT_SIZES)
  .sort((a, b) => b.length - a.length);

/** Default context window size when model is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Returns the context window size for a model ID.
 *
 * Lookup order:
 * 1. Explicit "[1m]" suffix (Claude Code's 1M-variant marker) → 1_000_000
 * 2. Exact match against MODEL_CONTEXT_SIZES
 * 3. Longest-prefix match (e.g. "claude-opus-4-6-20250414" → "claude-opus-4-6")
 * 4. DEFAULT_CONTEXT_WINDOW
 */
export function getModelContextWindowSize(modelId?: string): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;

  // Claude Code tags the 1M-context variant with a "[1m]" suffix on the
  // model ID. If we see it, honor it regardless of the base family.
  if (/\[1m\]/i.test(modelId)) return 1_000_000;

  // Strip the suffix if present, so the normal lookup still succeeds when
  // a caller passes e.g. "claude-opus-4-7[1m]" and we've already handled it.
  const normalized = modelId.replace(/\[1m\]/gi, '');

  // Exact match
  if (MODEL_CONTEXT_SIZES[normalized] !== undefined) {
    return MODEL_CONTEXT_SIZES[normalized];
  }

  // Longest-prefix match
  for (const key of SORTED_KEYS) {
    if (normalized.startsWith(key)) {
      return MODEL_CONTEXT_SIZES[key];
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}
