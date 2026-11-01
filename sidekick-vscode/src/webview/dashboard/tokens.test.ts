import { describe, expect, it } from 'vitest';
import {
  summarizeTokens,
  TOKEN_SESSION_TOTAL_LABEL,
  TOKEN_SUBAGENTS_LABEL,
  TOKEN_TOTAL_LABEL,
} from 'sidekick-shared/browser';
import { tokenMetricDisplay } from './tokens';

const fmt = (n: number) => String(n);

describe('tokenMetricDisplay', () => {
  it('totals every bucket like summarizeTokens and lists each one', () => {
    const state = {
      totalInputTokens: 96,
      totalOutputTokens: 100,
      totalCacheWriteTokens: 200,
      totalCacheReadTokens: 7500,
    };
    const display = tokenMetricDisplay(state, fmt);
    expect(display.value).toBe(7896);
    expect(display.value).toBe(
      summarizeTokens({
        inputTokens: 96,
        outputTokens: 100,
        cacheWriteTokens: 200,
        cacheReadTokens: 7500,
      }).total,
    );
    expect(display.lines).toEqual([
      TOKEN_TOTAL_LABEL,
      '96 in · 7500 cache read · 200 cache write · 100 out',
    ]);
  });

  it('adds subagents to the headline and shows the split', () => {
    const display = tokenMetricDisplay(
      {
        totalInputTokens: 1,
        totalOutputTokens: 2,
        totalCacheReadTokens: 3,
        subagentTokens: { count: 2, total: 50 },
      },
      fmt,
    );
    expect(display.mainTotal).toBe(6);
    expect(display.value).toBe(56);
    expect(display.lines).toEqual([
      TOKEN_SESSION_TOTAL_LABEL,
      'Main thread 6 (1 in · 3 cache read · 0 cache write · 2 out)',
      `${TOKEN_SUBAGENTS_LABEL} (2) 50`,
    ]);
  });
});
