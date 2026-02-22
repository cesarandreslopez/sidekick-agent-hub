/**
 * Model ID → context window size lookup.
 * Used to compute the context gauge (% of window used).
 */

/** Known model context window sizes (in tokens). */
const MODEL_CONTEXT_SIZES: Record<string, number> = {
  // Claude 4 family
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  // Claude 3.5 family
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  // Claude 3 family
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  // OpenAI models (for codex provider)
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'o1': 200_000,
  'o3': 200_000,
  'o4-mini': 200_000,
  // Default
  'default': 200_000,
};

/**
 * Returns the context window size for a model ID.
 * Uses prefix matching: "claude-sonnet-4-20250514" matches "claude-sonnet-4".
 */
export function getContextWindowSize(modelId: string | undefined): number {
  if (!modelId) return MODEL_CONTEXT_SIZES['default'];

  // Exact match first
  if (MODEL_CONTEXT_SIZES[modelId] !== undefined) {
    return MODEL_CONTEXT_SIZES[modelId];
  }

  // Prefix match: try progressively shorter prefixes
  // Sort keys by length descending so longer prefixes match first
  const keys = Object.keys(MODEL_CONTEXT_SIZES)
    .filter(k => k !== 'default')
    .sort((a, b) => b.length - a.length);

  for (const key of keys) {
    if (modelId.startsWith(key)) {
      return MODEL_CONTEXT_SIZES[key];
    }
  }

  return MODEL_CONTEXT_SIZES['default'];
}
