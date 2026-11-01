/**
 * Tokens metric (typed): the dashboard's headline token numbers in the shared
 * vocabulary — every billed bucket, cache included — with a breakdown whose
 * parts add up to the headline, plus the session's subagents.
 *
 * The labels are sidekick-shared's `TOKEN_*_LABEL`, from its browser entry.
 * The four-bucket sum is the same arithmetic as the shared `summarizeTokens`
 * (tokens.test.ts pins it), done here so the bundle does not carry the whole
 * summary for one addition.
 *
 * @module webview/dashboard/tokens
 */

import {
  TOKEN_MAIN_THREAD_LABEL,
  TOKEN_SESSION_TOTAL_LABEL,
  TOKEN_SUBAGENTS_LABEL,
  TOKEN_TOTAL_LABEL,
} from 'sidekick-shared/browser';

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
          TOKEN_SESSION_TOTAL_LABEL,
          `${TOKEN_MAIN_THREAD_LABEL} ${fmt(mainTotal)} (${breakdown})`,
          `${TOKEN_SUBAGENTS_LABEL} (${subagents.count}) ${fmt(subagentTotal)}`,
        ]
      : [TOKEN_TOTAL_LABEL, breakdown];
  return {
    mainTotal,
    sessionTotal: mainTotal + subagentTotal,
    value: mainTotal + subagentTotal,
    lines,
  };
}
