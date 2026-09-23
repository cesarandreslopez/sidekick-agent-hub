/**
 * Tokens metric (typed): the dashboard's headline token numbers in the shared
 * vocabulary — every billed bucket, cache included — with a breakdown whose
 * parts add up to the headline, plus the session's subagents.
 *
 * Kept local rather than imported from sidekick-shared/browser (the shared
 * package is CommonJS, so one helper would pull the whole browser entry into
 * this bundle). tokens.test.ts pins the arithmetic and labels to the shared
 * `summarizeTokens` / `TOKEN_*_LABEL` so the two cannot drift.
 *
 * @module webview/dashboard/tokens
 */

/** Mirrors `TOKEN_TOTAL_LABEL` in sidekick-shared. */
export const TOTAL_LABEL = 'Total (incl. cache)';
/** Mirrors `TOKEN_SUBAGENTS_LABEL` in sidekick-shared. */
export const SUBAGENTS_LABEL = 'Subagents';
/** Mirrors `TOKEN_SESSION_TOTAL_LABEL` in sidekick-shared. */
export const SESSION_TOTAL_LABEL = 'Session total (incl. subagents)';

export interface TokenMetricState {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens?: number;
  totalCacheReadTokens?: number;
  subagentTokens?: { count: number; total: number } | null;
}

export interface TokenMetricDisplay {
  /** Main-thread total, cache included (`summarizeTokens().total`). */
  mainTotal: number;
  /** Main thread plus subagents. */
  sessionTotal: number;
  /** Headline value: the session total. */
  value: number;
  /** Subtitle lines: the headline's label, then the parts that add up to it. */
  lines: string[];
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Headline and breakdown for the Tokens metric. */
export function tokenMetricDisplay(
  state: TokenMetricState,
  fmt: (n: number) => string,
): TokenMetricDisplay {
  const input = count(state.totalInputTokens);
  const output = count(state.totalOutputTokens);
  const cacheRead = count(state.totalCacheReadTokens);
  const cacheWrite = count(state.totalCacheWriteTokens);
  const mainTotal = input + cacheRead + cacheWrite + output;
  const subagents = state.subagentTokens;
  const subagentTotal = subagents ? count(subagents.total) : 0;
  const breakdown = `${fmt(input)} in · ${fmt(cacheRead)} cache read · ${fmt(cacheWrite)} cache write · ${fmt(output)} out`;
  const lines =
    subagents && subagents.count > 0
      ? [
          SESSION_TOTAL_LABEL,
          `Main thread ${fmt(mainTotal)} (${breakdown})`,
          `${SUBAGENTS_LABEL} (${subagents.count}) ${fmt(subagentTotal)}`,
        ]
      : [TOTAL_LABEL, breakdown];
  return {
    mainTotal,
    sessionTotal: mainTotal + subagentTotal,
    value: mainTotal + subagentTotal,
    lines,
  };
}
