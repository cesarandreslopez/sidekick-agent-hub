import { describe, expect, it } from 'vitest';
import { calculateNormalizedUsageCost, normalizeProviderUsage } from './usageNormalization';
import { normalizedUsageSchema } from './schemas/usageNormalization';

const pricing = {
  inputCostPerMillion: 10,
  outputCostPerMillion: 20,
  cacheWriteCostPerMillion: 12.5,
  cacheReadCostPerMillion: 1,
};

describe('normalizeProviderUsage', () => {
  it('subtracts OpenAI cached input and retains included reasoning analytically', () => {
    expect(
      normalizeProviderUsage({
        semantics: 'openai',
        provider: 'openai',
        inputTokens: 1000,
        cacheReadTokens: 300,
        outputTokens: 200,
        reasoningTokens: 40,
      }),
    ).toMatchObject({
      uncachedInputTokens: 700,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      outputTokens: 200,
      reasoningTokens: 40,
      reasoningIncludedInOutput: true,
      cacheInclusiveInputTokens: 1000,
      billableOutputTokens: 200,
      totalTokens: 1200,
      provenance: { provider: 'openai', semantics: 'openai-inclusive-cache' },
    });
  });

  it('clamps OpenAI uncached input when cached input exceeds total input', () => {
    const result = normalizeProviderUsage({
      semantics: 'openai',
      inputTokens: 50,
      cacheReadTokens: 75,
    });
    expect(result.uncachedInputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(75);
  });

  it('subtracts OpenAI/Codex cache writes from input instead of counting them twice', () => {
    const result = normalizeProviderUsage({
      semantics: 'openai',
      provider: 'openai',
      inputTokens: 1000,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      outputTokens: 200,
    });
    expect(result).toMatchObject({
      uncachedInputTokens: 600,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      cacheInclusiveInputTokens: 1000,
      totalTokens: 1200,
    });
    expect(normalizedUsageSchema.safeParse(result).success).toBe(true);
    expect(calculateNormalizedUsageCost({ usage: result, pricing }).costUsd).toBeCloseTo(
      (600 * 10 + 300 * 1 + 100 * 12.5 + 200 * 20) / 1_000_000,
    );
  });

  it('bills OpenAI cache writes as input when the model publishes no write rate', () => {
    const usage = normalizeProviderUsage({
      semantics: 'openai',
      inputTokens: 1000,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      outputTokens: 200,
    });
    const noWriteRate = { ...pricing, cacheWriteCostPerMillion: 0 };
    // The same cost as when the writes were left inside uncached input.
    expect(calculateNormalizedUsageCost({ usage, pricing: noWriteRate }).costUsd).toBeCloseTo(
      (700 * 10 + 300 * 1 + 200 * 20) / 1_000_000,
    );
    // Additive Anthropic writes keep their own (here zero) rate.
    const anthropic = normalizeProviderUsage({
      semantics: 'anthropic',
      inputTokens: 600,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      outputTokens: 200,
    });
    expect(
      calculateNormalizedUsageCost({ usage: anthropic, pricing: noWriteRate }).costUsd,
    ).toBeCloseTo((600 * 10 + 300 * 1 + 200 * 20) / 1_000_000);
  });

  it('clamps OpenAI uncached input when cache reads and writes exceed input', () => {
    const result = normalizeProviderUsage({
      semantics: 'openai',
      inputTokens: 100,
      cacheReadTokens: 80,
      cacheWriteTokens: 40,
    });
    expect(result.uncachedInputTokens).toBe(0);
    expect(result.cacheInclusiveInputTokens).toBe(120);
  });

  it('keeps Anthropic cache fields additive', () => {
    const result = normalizeProviderUsage({
      semantics: 'anthropic',
      inputTokens: 1000,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      outputTokens: 200,
    });
    expect(result.cacheInclusiveInputTokens).toBe(1400);
    expect(result.totalTokens).toBe(1600);
  });

  it('sanitizes negative and non-finite counters', () => {
    const result = normalizeProviderUsage({
      semantics: 'sidekick',
      reasoningIncludedInOutput: false,
      inputTokens: -1,
      outputTokens: Number.POSITIVE_INFINITY,
      cacheReadTokens: Number.NaN,
      reasoningTokens: 4,
    });
    expect(result).toMatchObject({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 4,
      billableOutputTokens: 4,
      totalTokens: 4,
    });
  });
});

describe('calculateNormalizedUsageCost', () => {
  it('does not double bill reasoning included in output', () => {
    const usage = normalizeProviderUsage({
      semantics: 'openai',
      inputTokens: 1000,
      cacheReadTokens: 300,
      outputTokens: 200,
      reasoningTokens: 40,
    });
    const result = calculateNormalizedUsageCost({ usage, pricing });
    expect(result.costUsd).toBeCloseTo((700 * 10 + 300 * 1 + 200 * 20) / 1_000_000);
    expect(result).toMatchObject({ source: 'explicit-pricing', usage });
  });

  it('treats provider-reported zero as authoritative', () => {
    const usage = normalizeProviderUsage({
      semantics: 'anthropic',
      inputTokens: 100,
      reportedCostUsd: 0,
    });
    expect(calculateNormalizedUsageCost({ usage, pricing })).toMatchObject({
      costUsd: 0,
      source: 'provider-reported',
    });
  });

  it('leaves unknown models unpriced', () => {
    const usage = normalizeProviderUsage({
      semantics: 'sidekick',
      reasoningIncludedInOutput: false,
      inputTokens: 100,
    });
    expect(calculateNormalizedUsageCost({ usage, modelId: 'unknown-never-priced' })).toMatchObject({
      costUsd: null,
      source: 'unpriced',
    });
  });
});

describe('normalizedUsageSchema', () => {
  it('validates derived totals instead of accepting inconsistent normalized data', () => {
    const usage = normalizeProviderUsage({
      semantics: 'sidekick',
      reasoningIncludedInOutput: false,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(normalizedUsageSchema.safeParse(usage).success).toBe(true);
    expect(normalizedUsageSchema.safeParse({ ...usage, totalTokens: 999 }).success).toBe(false);
  });
});
