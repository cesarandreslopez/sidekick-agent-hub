import { describe, expect, it } from 'vitest';
import {
  TOKEN_CONTEXT_LABEL,
  TOKEN_TOTAL_LABEL,
  summarizeTokens,
  sumTokenTotals,
} from './tokenSummary';
import { normalizeProviderUsage } from './usageNormalization';

describe('summarizeTokens', () => {
  it('counts every billable bucket in total and excludes output from context', () => {
    const summary = summarizeTokens({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheWriteTokens: 2_000,
      cacheReadTokens: 30_000,
    });
    expect(summary.total).toBe(33_500);
    expect(summary.context).toBe(33_000);
    expect(summary.output).toBe(500);
    expect(summary.cacheHitRatio).toBeCloseTo(30_000 / 33_000);
  });

  it('treats missing cache buckets as zero', () => {
    const summary = summarizeTokens({ inputTokens: 10, outputTokens: 5 });
    expect(summary.total).toBe(15);
    expect(summary.context).toBe(10);
    expect(summary.cacheRead).toBe(0);
    expect(summary.cacheWrite).toBe(0);
  });

  it('prefers a provider-semantics total when the source computed one', () => {
    // Reasoning billed outside output: the normalized total is larger than the four buckets.
    const usage = normalizeProviderUsage({
      semantics: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 25,
      reasoningIncludedInOutput: false,
    });
    const summary = summarizeTokens({
      inputTokens: usage.uncachedInputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: usage.totalTokens,
    });
    expect(summary.total).toBe(175);
    expect(summary.context).toBe(100);
  });

  it('clamps negative and non-finite counts to zero', () => {
    const summary = summarizeTokens({
      inputTokens: -5,
      outputTokens: Number.NaN,
      cacheReadTokens: Number.POSITIVE_INFINITY,
    });
    expect(summary).toMatchObject({ total: 0, context: 0, cacheHitRatio: null });
  });

  it('matches the normalized-usage total for every provider semantics', () => {
    for (const semantics of ['anthropic', 'openai'] as const) {
      const usage = normalizeProviderUsage({
        semantics,
        inputTokens: 5_000,
        outputTokens: 400,
        cacheReadTokens: 3_000,
        cacheWriteTokens: 1_000,
      });
      const summary = summarizeTokens({
        inputTokens: usage.uncachedInputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      });
      expect(summary.total).toBe(usage.totalTokens);
      expect(summary.context).toBe(usage.cacheInclusiveInputTokens);
    }
  });

  it('exposes stable column labels', () => {
    expect(TOKEN_TOTAL_LABEL).toBe('Total (incl. cache)');
    expect(TOKEN_CONTEXT_LABEL).toBe('Context');
  });
});

describe('sumTokenTotals', () => {
  it('adds bucket-by-bucket and summarizes consistently', () => {
    const summed = sumTokenTotals([
      { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 },
      { inputTokens: 10, outputTokens: 20 },
    ]);
    expect(summed).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheWriteTokens: 3,
      cacheReadTokens: 4,
    });
    expect(summarizeTokens(summed).total).toBe(40);
  });
});
