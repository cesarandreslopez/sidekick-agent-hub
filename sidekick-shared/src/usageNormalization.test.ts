import { describe, expect, it } from 'vitest';
import {
  RAW_USAGE_FORMATS,
  calculateNormalizedUsageCost,
  normalizeProviderUsage,
  normalizeRawProviderUsage,
  priceProviderUsage,
} from './usageNormalization';
import { calculateCostWithPricing, resolveModelPricing } from './modelInfo';
import { CodexRolloutParser } from './parsers/codexParser';
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

describe('normalizeRawProviderUsage', () => {
  const disjoint = (usage: ReturnType<typeof normalizeRawProviderUsage>) => ({
    uncached: usage.uncachedInputTokens,
    read: usage.cacheReadTokens,
    write: usage.cacheWriteTokens,
    billableOutput: usage.billableOutputTokens,
    total: usage.totalTokens,
  });

  it('reads Codex token usage with cached input and reasoning already included', () => {
    const usage = normalizeRawProviderUsage('codex', {
      input_tokens: 1000,
      cached_input_tokens: 800,
      output_tokens: 300,
      reasoning_output_tokens: 200,
      cache_write_input_tokens: 50,
      total_tokens: 1300,
    });
    // cache_write_input_tokens is ignored, as the session parser ignores it.
    expect(disjoint(usage)).toEqual({
      uncached: 200,
      read: 800,
      write: 0,
      billableOutput: 300,
      total: 1300,
    });
    expect(usage).toMatchObject({
      reasoningTokens: 200,
      reasoningIncludedInOutput: true,
      provenance: { provider: 'openai', semantics: 'openai-inclusive-cache' },
    });
    expect(
      normalizeRawProviderUsage('codex', {
        inputTokens: 1000,
        cachedInputTokens: 800,
        outputTokens: 300,
        reasoningOutputTokens: 200,
      }),
    ).toEqual(usage);
  });

  it('matches what CodexRolloutParser derives from the same token_count', () => {
    const last = {
      input_tokens: 5120,
      cached_input_tokens: 4096,
      output_tokens: 640,
      reasoning_output_tokens: 128,
      total_tokens: 5760,
    };
    const parser = new CodexRolloutParser();
    const [event] = parser.convertLine({
      timestamp: '2026-11-06T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: last } },
    } as never);
    const parsed = event.message!.normalizedUsage!;
    const raw = normalizeRawProviderUsage('codex', last);
    expect(disjoint(raw)).toEqual(disjoint(parsed));
    expect(raw.reasoningTokens).toBe(parsed.reasoningTokens);
    expect(raw.reasoningIncludedInOutput).toBe(parsed.reasoningIncludedInOutput);
  });

  it('reads OpenAI Responses and Chat Completions usage', () => {
    const responses = normalizeRawProviderUsage('openai', {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 50 },
      total_tokens: 1200,
    });
    expect(disjoint(responses)).toEqual({
      uncached: 600,
      read: 300,
      write: 100,
      billableOutput: 200,
      total: 1200,
    });
    const chat = normalizeRawProviderUsage('openai', {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 300 },
      completion_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 50 },
      total_tokens: 1200,
    });
    expect(disjoint(chat)).toEqual({
      uncached: 700,
      read: 300,
      write: 0,
      billableOutput: 200,
      total: 1200,
    });
    expect(chat.reasoningTokens).toBe(50);
  });

  it('reads Anthropic usage as additive cache categories', () => {
    expect(
      disjoint(
        normalizeRawProviderUsage('anthropic', {
          input_tokens: 10,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 500,
          output_tokens: 200,
        }),
      ),
    ).toEqual({ uncached: 10, read: 3000, write: 500, billableOutput: 200, total: 3710 });
    const split = normalizeRawProviderUsage('anthropic', {
      input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 },
      output_tokens: 1,
    });
    expect(split.cacheWriteTokens).toBe(500);
    expect(split.provenance).toMatchObject({
      provider: 'anthropic',
      semantics: 'anthropic-additive-cache',
      source: 'anthropic-raw-usage',
    });
  });

  it('turns garbage into zero usage instead of throwing', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    );
    for (const format of RAW_USAGE_FORMATS) {
      for (const value of [
        null,
        undefined,
        42,
        'usage',
        [],
        [1000, 800],
        hostile,
        { input_tokens: -5, output_tokens: Number.NaN, cached_input_tokens: '7' },
        { inputTokens: Infinity, prompt_tokens: null, cache_read_input_tokens: {} },
      ]) {
        const usage = normalizeRawProviderUsage(format, value);
        expect(usage.totalTokens, `${format} ${String(value)}`).toBe(0);
        expect(normalizedUsageSchema.safeParse(usage).success).toBe(true);
      }
    }
  });

  it('rejects an unknown format', () => {
    expect(() => normalizeRawProviderUsage('gemini' as never, {})).toThrow(TypeError);
  });
});

describe('priceProviderUsage', () => {
  const codexUsage = {
    input_tokens: 1000,
    cached_input_tokens: 800,
    output_tokens: 300,
    reasoning_output_tokens: 200,
  };

  it('prices Codex usage once, unlike the deprecated calculateCost', () => {
    const result = priceProviderUsage({ provider: 'codex', usage: codexUsage, pricing });
    const expected = (200 * 10 + 800 * 1 + 300 * 20) / 1_000_000;
    expect(result.costUsd).toBeCloseTo(expected);
    expect(result).toMatchObject({ source: 'estimated', provenance: 'explicit-pricing' });
    // The usual misuse: cache-inclusive input plus cached input plus reasoning.
    const legacy = calculateCostWithPricing(
      {
        inputTokens: 1000,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        outputTokens: 300,
        reasoningTokens: 200,
      },
      pricing,
    );
    expect(legacy).toBeCloseTo((1000 * 10 + 800 * 1 + 500 * 20) / 1_000_000);
    expect(legacy).toBeGreaterThan(result.costUsd!);
  });

  it('prefers a reported cost, then explicit pricing, then the model catalog', () => {
    expect(
      priceProviderUsage({
        provider: 'codex',
        usage: codexUsage,
        pricing,
        model: 'gpt-5',
        reportedCostUsd: 0,
      }),
    ).toMatchObject({ costUsd: 0, source: 'reported', provenance: 'provider-reported' });

    const explicit = priceProviderUsage({
      provider: 'codex',
      usage: codexUsage,
      pricing,
      model: 'gpt-5',
    });
    expect(explicit).toMatchObject({ provenance: 'explicit-pricing', modelId: 'gpt-5' });
    expect(explicit.pricingMatch).toBeUndefined();

    expect(
      priceProviderUsage({ provider: 'codex', usage: codexUsage, pricing: null, model: 'gpt-5' }),
    ).toMatchObject({ costUsd: null, source: 'unpriced', provenance: 'unpriced' });

    const catalog = priceProviderUsage({ provider: 'codex', usage: codexUsage, model: 'gpt-5' });
    const rates = resolveModelPricing('gpt-5').pricing!;
    expect(catalog).toMatchObject({
      source: 'estimated',
      provenance: 'model-catalog',
      pricingMatch: { match: 'exact', matchedModelId: 'gpt-5' },
    });
    expect(catalog.costUsd).toBeCloseTo(
      (200 * rates.inputCostPerMillion +
        800 * rates.cacheReadCostPerMillion +
        300 * rates.outputCostPerMillion) /
        1_000_000,
    );
    expect(catalog.costUsd).toBeCloseTo(
      calculateNormalizedUsageCost({ usage: catalog.normalized, modelId: 'gpt-5' }).costUsd!,
    );
  });

  it('leaves unknown and missing models unpriced', () => {
    const unknown = priceProviderUsage({
      provider: 'openai',
      usage: { input_tokens: 10, output_tokens: 1 },
      model: 'never-priced-model',
    });
    expect(unknown).toMatchObject({
      costUsd: null,
      source: 'unpriced',
      provenance: 'unpriced',
      pricingMatch: { source: 'none', match: 'none' },
    });
    const none = priceProviderUsage({ provider: 'anthropic', usage: { input_tokens: 10 } });
    expect(none).toMatchObject({ costUsd: null, provenance: 'unpriced' });
    expect(none.pricingMatch).toBeUndefined();
    expect(none.modelId).toBeUndefined();
    expect(none.normalized.uncachedInputTokens).toBe(10);
  });

  it('ignores a malformed reported cost and unusable explicit rates', () => {
    expect(
      priceProviderUsage({
        provider: 'codex',
        usage: codexUsage,
        pricing,
        reportedCostUsd: Number.NaN,
      }).provenance,
    ).toBe('explicit-pricing');
    expect(
      priceProviderUsage({
        provider: 'codex',
        usage: codexUsage,
        pricing: { ...pricing, inputCostPerMillion: Number.NaN },
      }),
    ).toMatchObject({ costUsd: null, provenance: 'unpriced' });
  });
});
