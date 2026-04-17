import { afterEach, describe, it, expect } from 'vitest';
import {
  parseModelId,
  getModelPricing,
  getModelInfo,
  calculateCost,
  calculateCostWithPricing,
  formatCost,
  _setPricingOverrides,
  _clearPricingOverrides,
  _getPricingOverrides,
} from './modelInfo';

// Keep tests isolated from each other when they poke the override map.
afterEach(() => _clearPricingOverrides());

describe('parseModelId', () => {
  it('parses versioned Claude model IDs', () => {
    expect(parseModelId('claude-opus-4-20250514')).toEqual({
      provider: 'anthropic',
      family: 'opus',
      version: '4',
    });
    expect(parseModelId('claude-sonnet-4.5-20241022')).toEqual({
      provider: 'anthropic',
      family: 'sonnet',
      version: '4.5',
    });
    expect(parseModelId('claude-haiku-4.5-20251001')).toEqual({
      provider: 'anthropic',
      family: 'haiku',
      version: '4.5',
    });
  });

  it('parses OpenAI GPT model IDs', () => {
    expect(parseModelId('gpt-4o')).toEqual({
      provider: 'openai',
      family: 'gpt',
      version: '4o',
    });
    expect(parseModelId('gpt-5.4')).toEqual({
      provider: 'openai',
      family: 'gpt',
      version: '5.4',
    });
    expect(parseModelId('gpt-5.3-codex')).toEqual({
      provider: 'openai',
      family: 'gpt',
      version: '5.3-codex',
    });
  });

  it('parses OpenAI o-series reasoning model IDs', () => {
    expect(parseModelId('o1')).toEqual({ provider: 'openai', family: 'o', version: '1' });
    expect(parseModelId('o3')).toEqual({ provider: 'openai', family: 'o', version: '3' });
    expect(parseModelId('o3-mini')).toEqual({ provider: 'openai', family: 'o', version: '3-mini' });
    expect(parseModelId('o1-pro')).toEqual({ provider: 'openai', family: 'o', version: '1-pro' });
  });

  it('parses Gemini model IDs', () => {
    expect(parseModelId('gemini-1.5-pro')).toEqual({
      provider: 'google',
      family: 'gemini',
      version: '1.5-pro',
    });
    expect(parseModelId('gemini-2.0-flash')).toEqual({
      provider: 'google',
      family: 'gemini',
      version: '2.0-flash',
    });
  });

  it('returns null for unrecognized IDs', () => {
    expect(parseModelId('deepseek-coder')).toBeNull();
    expect(parseModelId('totally-made-up')).toBeNull();
    expect(parseModelId('')).toBeNull();
  });

  it('strips [1m] suffix before matching', () => {
    expect(parseModelId('claude-opus-4-6[1m]')).toEqual({
      provider: 'anthropic',
      family: 'opus',
      version: '4',
    });
  });
});

describe('getModelPricing', () => {
  it('returns exact pricing for known Claude models', () => {
    const pricing = getModelPricing('claude-sonnet-4.5-20241022');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputCostPerMillion).toBe(3.0);
    expect(pricing!.outputCostPerMillion).toBe(15.0);
  });

  it('returns pricing for known OpenAI models', () => {
    const gpt4o = getModelPricing('gpt-4o');
    expect(gpt4o).not.toBeNull();
    expect(gpt4o!.inputCostPerMillion).toBe(2.5);
    expect(gpt4o!.outputCostPerMillion).toBe(10.0);

    const o3mini = getModelPricing('o3-mini');
    expect(o3mini).not.toBeNull();
    expect(o3mini!.inputCostPerMillion).toBe(1.1);
  });

  it('matches longest-prefix for variant suffixes', () => {
    // A hypothetical fine-tune or date suffix should still resolve to the base.
    const pricing = getModelPricing('gpt-5.4-20260301');
    expect(pricing).not.toBeNull();
    expect(pricing!.outputCostPerMillion).toBe(10.0);
  });

  it('returns null for unknown models (no silent fallback)', () => {
    expect(getModelPricing('deepseek-coder')).toBeNull();
    expect(getModelPricing('made-up-model')).toBeNull();
    expect(getModelPricing('')).toBeNull();
  });

  it('runtime overrides take precedence over the static table', () => {
    _setPricingOverrides({
      'claude-sonnet-4.5': {
        inputCostPerMillion: 99.0,
        outputCostPerMillion: 99.0,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    const pricing = getModelPricing('claude-sonnet-4.5-20241022');
    expect(pricing!.inputCostPerMillion).toBe(99.0);
  });

  it('overrides can teach us new models the static table does not know', () => {
    _setPricingOverrides({
      'mystery-model-v2': {
        inputCostPerMillion: 7,
        outputCostPerMillion: 42,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    const pricing = getModelPricing('mystery-model-v2-20260101');
    expect(pricing!.outputCostPerMillion).toBe(42);
  });
});

describe('getModelInfo', () => {
  it('returns full info for a Claude model', () => {
    const info = getModelInfo('claude-opus-4-20250514');
    expect(info.provider).toBe('anthropic');
    expect(info.family).toBe('opus');
    expect(info.version).toBe('4');
    expect(info.contextWindow).toBe(200_000);
    expect(info.pricing).not.toBeNull();
    expect(info.pricing!.inputCostPerMillion).toBe(15.0);
  });

  it('returns full info for a GPT model', () => {
    const info = getModelInfo('gpt-4o');
    expect(info.provider).toBe('openai');
    expect(info.family).toBe('gpt');
    expect(info.version).toBe('4o');
    expect(info.contextWindow).toBe(128_000);
    expect(info.pricing).not.toBeNull();
  });

  it('returns null provider/family for unknown models', () => {
    const info = getModelInfo('deepseek-coder');
    expect(info.provider).toBeNull();
    expect(info.family).toBeNull();
    expect(info.version).toBeNull();
    expect(info.pricing).toBeNull();
  });
});

describe('calculateCost', () => {
  it('calculates cost for a Claude model', () => {
    const cost = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      'claude-sonnet-4-20250514',
    );
    expect(cost).toBeCloseTo(3.0, 2);
  });

  it('includes cache costs', () => {
    const cost = calculateCost(
      { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 },
      'claude-sonnet-4-20250514',
    );
    // cacheWrite: 3.75, cacheRead: 0.3
    expect(cost).toBeCloseTo(4.05, 2);
  });

  it('prices reasoning tokens at the output rate', () => {
    const cost = calculateCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 1_000_000,
      },
      'o3-mini',
    );
    // o3-mini output rate is $4.40/M
    expect(cost).toBeCloseTo(4.4, 2);
  });

  it('returns null for unknown models (not 0)', () => {
    const cost = calculateCost(
      { inputTokens: 100_000, outputTokens: 50_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      'totally-unknown-model',
    );
    expect(cost).toBeNull();
  });
});

describe('calculateCostWithPricing', () => {
  it('calculates using explicit pricing', () => {
    const cost = calculateCostWithPricing(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      { inputCostPerMillion: 3, outputCostPerMillion: 15, cacheWriteCostPerMillion: 0, cacheReadCostPerMillion: 0 },
    );
    expect(cost).toBeCloseTo(18.0, 2);
  });

  it('treats reasoning tokens as output', () => {
    const cost = calculateCostWithPricing(
      {
        inputTokens: 0,
        outputTokens: 500_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 500_000,
      },
      { inputCostPerMillion: 0, outputCostPerMillion: 10, cacheWriteCostPerMillion: 0, cacheReadCostPerMillion: 0 },
    );
    // (0.5 + 0.5) × $10 = $10
    expect(cost).toBeCloseTo(10.0, 2);
  });

  it('handles missing reasoning field as zero', () => {
    const cost = calculateCostWithPricing(
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      { inputCostPerMillion: 5, outputCostPerMillion: 15, cacheWriteCostPerMillion: 0, cacheReadCostPerMillion: 0 },
    );
    expect(cost).toBeCloseTo(5.0, 2);
  });
});

describe('formatCost', () => {
  it('formats small costs with 4 decimal places', () => {
    expect(formatCost(0.001234)).toBe('$0.0012');
  });

  it('formats normal costs with 2 decimal places', () => {
    expect(formatCost(1.234)).toBe('$1.23');
  });

  it('formats zero', () => {
    expect(formatCost(0)).toBe('$0.0000');
  });

  it("renders null as '—'", () => {
    expect(formatCost(null)).toBe('—');
  });

  it("renders undefined as '—'", () => {
    expect(formatCost(undefined)).toBe('—');
  });
});

describe('override map helpers', () => {
  it('_getPricingOverrides returns a snapshot', () => {
    _setPricingOverrides({
      'x-y-z': {
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    const snap = _getPricingOverrides();
    expect(snap['x-y-z']).toBeDefined();
    // Mutating the snapshot must not affect internal state.
    delete snap['x-y-z'];
    expect(_getPricingOverrides()['x-y-z']).toBeDefined();
  });

  it('_clearPricingOverrides wipes the map', () => {
    _setPricingOverrides({
      'a-b': {
        inputCostPerMillion: 1,
        outputCostPerMillion: 1,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    _clearPricingOverrides();
    expect(_getPricingOverrides()).toEqual({});
  });
});
