/**
 * @fileoverview Token estimation and diff truncation utilities.
 *
 * Provides fast local token estimation and intelligent diff truncation
 * to ensure diffs stay within Claude's optimal input range without
 * breaking mid-hunk.
 *
 * Note: Uses character-based estimation (4 chars ≈ 1 token) for speed.
 * The Claude SDK provides a countTokens API for precise counting, but
 * that would add ~200ms latency per estimation. For truncation decisions,
 * character-based estimation is sufficient and instant.
 *
 * @module tokenEstimator
 */

/**
 * Default maximum token count for diffs.
 *
 * Set to 8000 tokens (~32KB) to allow larger diffs while staying
 * reasonable for commit message generation. Sonnet/Opus have 200K
 * context so this leaves plenty of headroom.
 */
export const DEFAULT_MAX_TOKENS = 8000;

/**
 * Estimates the token count for a text string.
 *
 * Uses a conservative character-to-token ratio (4 chars ≈ 1 token)
 * which is appropriate for code and diffs. This provides instant
 * estimation without API calls.
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 *
 * @example
 * ```typescript
 * const diff = "...large diff content...";
 * const tokens = estimateTokens(diff);
 * if (tokens > 3500) {
 *   diff = truncateDiffIntelligently(diff);
 * }
 * ```
 */
export function estimateTokens(text: string): number {
  // 4 characters ≈ 1 token (conservative estimate for code)
  return Math.ceil(text.length / 4);
}

/**
 * Truncates a diff intelligently to fit within token limit.
 *
 * Splits the diff into file sections (by "diff --git" markers) and
 * keeps complete sections from the start until adding another would
 * exceed the limit. This ensures we never break mid-hunk, which would
 * confuse Claude's commit message generation.
 *
 * The truncation strategy:
 * - Parse diff into complete file sections
 * - Keep sections sequentially from the start
 * - Stop when adding next section would exceed limit
 * - Return truncated diff with only complete sections
 *
 * @param diff - Git diff output to truncate
 * @param maxTokens - Maximum token count (defaults to 3500)
 * @returns Truncated diff with complete file sections only
 *
 * @example
 * ```typescript
 * const largeDiff = "...10,000 token diff...";
 * const truncated = truncateDiffIntelligently(largeDiff);
 * // Returns first ~3500 tokens worth of complete file sections
 *
 * const smallDiff = "...500 token diff...";
 * const unchanged = truncateDiffIntelligently(smallDiff);
 * // Returns original diff (already under limit)
 * ```
 */
export function truncateDiffIntelligently(
  diff: string,
  maxTokens: number = DEFAULT_MAX_TOKENS
): string {
  // Convert token limit to character limit using conservative estimate
  const maxChars = maxTokens * 4;

  // If diff already fits, return as-is
  if (diff.length <= maxChars) {
    return diff;
  }

  // Split into file sections by "diff --git" markers
  // Using positive lookahead to keep the marker with each section
  const sections = diff.split(/^(?=diff --git )/m);
  let result = '';

  for (const section of sections) {
    const testResult = result + section;
    if (testResult.length <= maxChars) {
      // Adding this section keeps us under limit
      result = testResult;
    } else {
      // Adding this section would exceed limit, stop here
      break;
    }
  }

  return result;
}
