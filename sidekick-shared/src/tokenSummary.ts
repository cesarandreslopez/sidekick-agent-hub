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
  /** Reasoning tokens, when the source tracks them (display only). */
  reasoningTokens?: number;
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
  /** Reasoning tokens reported by the provider (display only; may be inside `output`). */
  reasoning: number;
  /**
   * Tokens in `total` beyond the four buckets — reasoning billed outside
   * `output` by providers that report it separately. Zero when the buckets
   * already add up to `total`.
   */
  billedOutsideBuckets: number;
}

/** Column label for `TokenSummary.total` on any surface. */
export const TOKEN_TOTAL_LABEL = 'Total (incl. cache)';
/** Column label for `TokenSummary.context` on any surface. */
export const TOKEN_CONTEXT_LABEL = 'Context';
/** Label for a session's own (main-thread) tokens when subagents are shown beside it. */
export const TOKEN_MAIN_THREAD_LABEL = 'Main thread';
/** Label for the tokens a session's subagents used. */
export const TOKEN_SUBAGENTS_LABEL = 'Subagents';
/** Label for main thread plus subagents. */
export const TOKEN_SESSION_TOTAL_LABEL = 'Session total (incl. subagents)';

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
    reasoning: count(totals.reasoningTokens),
    billedOutsideBuckets: Math.max(0, total - fourBucket),
  };
}

/**
 * One-line breakdown whose parts add up to the headline:
 * `1.2M total incl. cache (12k in · 1.1M cache read · 40k cache write · 30k out)`.
 * Pass the surface's own number formatter; the default prints plain integers.
 */
export function formatTokenBreakdown(
  summary: TokenSummary,
  fmt: (n: number) => string = (n) => String(n),
): string {
  const parts = [
    `${fmt(summary.input)} in`,
    `${fmt(summary.cacheRead)} cache read`,
    `${fmt(summary.cacheWrite)} cache write`,
    `${fmt(summary.output)} out`,
  ];
  if (summary.billedOutsideBuckets > 0) {
    parts.push(`${fmt(summary.billedOutsideBuckets)} reasoning`);
  }
  return `${fmt(summary.total)} total incl. cache (${parts.join(' · ')})`;
}

/**
 * Sum several token records bucket-by-bucket before summarizing. `totalTokens`
 * is summed only when every record carries one, so provider-aware totals
 * survive the sum instead of falling back to the four-bucket arithmetic.
 */
export function sumTokenTotals(records: readonly TokenTotalsLike[]): TokenTotalsLike {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let allHaveTotal = records.length > 0;
  for (const record of records) {
    inputTokens += count(record.inputTokens);
    outputTokens += count(record.outputTokens);
    cacheWriteTokens += count(record.cacheWriteTokens);
    cacheReadTokens += count(record.cacheReadTokens);
    reasoningTokens += count(record.reasoningTokens);
    if (typeof record.totalTokens === 'number' && Number.isFinite(record.totalTokens)) {
      totalTokens += count(record.totalTokens);
    } else {
      allHaveTotal = false;
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    reasoningTokens,
    ...(allHaveTotal ? { totalTokens } : {}),
  };
}
