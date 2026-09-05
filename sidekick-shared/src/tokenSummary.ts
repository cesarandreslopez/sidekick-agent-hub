/**
 * One vocabulary for token totals across every Sidekick surface.
 *
 * Every report, dashboard, status bar, and export derives its headline token
 * numbers from here so "Total" means the same thing everywhere:
 *
 * - `total`   — every token the provider billed: uncached input, cache writes,
 *               cache reads, and output. Matches `NormalizedUsage.totalTokens`
 *               and the per-model `tokens` the `EventAggregator` keeps.
 * - `context` — tokens that occupied the context window on the last request:
 *               uncached input, cache writes, and cache reads. Output is
 *               excluded, matching the input-only formula Claude Code uses for
 *               its status-line `used_percentage`.
 * - `output`  — output tokens as billed.
 *
 * Cache reads are usually the majority of a coding-agent session's tokens, so
 * an "input + output" total silently drops most of the work. Sidekick used to
 * do that on some surfaces and not others; this helper is the single place the
 * arithmetic lives.
 *
 * Browser-safe: no Node imports.
 *
 * @module tokenSummary
 */

/** Any object carrying the four billable token buckets. */
export interface TokenTotalsLike {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /**
   * A provider-semantics-aware total, when the source already computed one
   * (for example `AggregatedTokens.totalTokens`). Preferred over the
   * four-bucket sum because it already accounts for whether reasoning tokens
   * were billed inside or outside `outputTokens`.
   */
  totalTokens?: number;
}

export interface TokenSummary {
  /** Everything billed: uncached input + cache writes + cache reads + output. */
  total: number;
  /** Tokens occupying the context window: uncached input + cache writes + cache reads. */
  context: number;
  /** Uncached input tokens. */
  input: number;
  /** Output tokens as billed. */
  output: number;
  /** Tokens read from the prompt cache. */
  cacheRead: number;
  /** Tokens written to the prompt cache. */
  cacheWrite: number;
  /** Fraction of context tokens that came from cache reads (0..1), or null with no input. */
  cacheHitRatio: number | null;
}

/** Column label for `TokenSummary.total` on any surface. */
export const TOKEN_TOTAL_LABEL = 'Total (incl. cache)';
/** Column label for `TokenSummary.context` on any surface. */
export const TOKEN_CONTEXT_LABEL = 'Context';

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Derive the shared token vocabulary from any four-bucket token record. */
export function summarizeTokens(totals: TokenTotalsLike): TokenSummary {
  const input = count(totals.inputTokens);
  const output = count(totals.outputTokens);
  const cacheRead = count(totals.cacheReadTokens);
  const cacheWrite = count(totals.cacheWriteTokens);
  const context = input + cacheWrite + cacheRead;
  const fourBucket = context + output;
  const provided = totals.totalTokens;
  const total =
    typeof provided === 'number' && Number.isFinite(provided) && provided >= 0
      ? Math.floor(provided)
      : fourBucket;
  return {
    total,
    context,
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheHitRatio: context > 0 ? cacheRead / context : null,
  };
}

/** Sum several token records bucket-by-bucket before summarizing. */
export function sumTokenTotals(records: readonly TokenTotalsLike[]): TokenTotalsLike {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  for (const record of records) {
    inputTokens += count(record.inputTokens);
    outputTokens += count(record.outputTokens);
    cacheWriteTokens += count(record.cacheWriteTokens);
    cacheReadTokens += count(record.cacheReadTokens);
  }
  return { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens };
}
