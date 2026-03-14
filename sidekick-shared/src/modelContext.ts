/**
 * Centralized model ID → context window size lookup.
 * Single source of truth used by all providers and the CLI dashboard.
 */

/** Known model context window sizes (in tokens). */
const MODEL_CONTEXT_SIZES: Record<string, number> = {
  // Claude 4.6 family (1M context)
  'claude-opus-4-6': 1_000_000,
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
  // OpenAI GPT-5 series
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
 * 1. Exact match against MODEL_CONTEXT_SIZES
 * 2. Longest-prefix match (e.g. "claude-opus-4-6-20250414" → "claude-opus-4-6")
 * 3. DEFAULT_CONTEXT_WINDOW
 */
export function getModelContextWindowSize(modelId?: string): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;

  // Exact match
  if (MODEL_CONTEXT_SIZES[modelId] !== undefined) {
    return MODEL_CONTEXT_SIZES[modelId];
  }

  // Longest-prefix match
  for (const key of SORTED_KEYS) {
    if (modelId.startsWith(key)) {
      return MODEL_CONTEXT_SIZES[key];
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}
