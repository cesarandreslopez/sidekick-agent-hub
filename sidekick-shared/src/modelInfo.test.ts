import { describe, it, expect } from 'vitest';
import {
  parseModelId,
  getModelPricing,
  getModelInfo,
  calculateCost,
  calculateCostWithPricing,
  formatCost,
} from './modelInfo';

describe('parseModelId', () => {
  it('parses versioned Claude model IDs', () => {
    expect(parseModelId('claude-opus-4-20250514')).toEqual({ family: 'opus', version: '4' });
    expect(parseModelId('claude-sonnet-4.5-20241022')).toEqual({ family: 'sonnet', version: '4.5' });
    expect(parseModelId('claude-haiku-4.5-20251001')).toEqual({ family: 'haiku', version: '4.5' });
  });

  it('parses short Claude model IDs', () => {
    expect(parseModelId('claude-opus-4.6')).toEqual({ family: 'opus', version: '4.6' });
    expect(parseModelId('claude-sonnet-4')).toEqual({ family: 'sonnet', version: '4' });
  });

  it('returns null for non-Claude models', () => {
    expect(parseModelId('gpt-4o')).toBeNull();
    expect(parseModelId('gemini-pro')).toBeNull();
    expect(parseModelId('deepseek-coder')).toBeNull();
  });
});

describe('getModelPricing', () => {
  it('returns exact pricing for known models', () => {
    const pricing = getModelPricing('claude-sonnet-4-20250514');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputCostPerMillion).toBe(3.0);
    expect(pricing!.outputCostPerMillion).toBe(15.0);
  });

  it('falls back to latest family version for unknown versions', () => {
    const pricing = getModelPricing('claude-opus-99-20290101');
    expect(pricing).not.toBeNull();
    // Should fall back to highest opus version in table
    expect(pricing!.inputCostPerMillion).toBeGreaterThan(0);
  });

  it('returns null for non-Claude models', () => {
    expect(getModelPricing('gpt-4o')).toBeNull();
  });
});

describe('getModelInfo', () => {
  it('returns full info for a Claude model', () => {
    const info = getModelInfo('claude-opus-4-20250514');
    expect(info.family).toBe('opus');
    expect(info.version).toBe('4');
    expect(info.contextWindow).toBe(200_000);
    expect(info.pricing).not.toBeNull();
    expect(info.pricing!.inputCostPerMillion).toBe(15.0);
  });

  it('returns partial info for non-Claude models', () => {
    const info = getModelInfo('gpt-4o');
    expect(info.family).toBeNull();
    expect(info.version).toBeNull();
    expect(info.contextWindow).toBe(128_000);
    expect(info.pricing).toBeNull();
  });

  it('resolves 4.6 models with 1M context', () => {
    const info = getModelInfo('claude-opus-4-6');
    expect(info.contextWindow).toBe(1_000_000);
  });
});

describe('calculateCost', () => {
  it('calculates cost for a Claude model', () => {
    const cost = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      'claude-sonnet-4-20250514'
    );
    expect(cost).toBeCloseTo(3.0, 2);
  });

  it('includes cache costs', () => {
    const cost = calculateCost(
      { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 },
      'claude-sonnet-4-20250514'
    );
    // cacheWrite: 3.75, cacheRead: 0.3
    expect(cost).toBeCloseTo(4.05, 2);
  });

  it('returns 0 for non-Claude models', () => {
    const cost = calculateCost(
      { inputTokens: 100000, outputTokens: 50000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      'gpt-4o'
    );
    expect(cost).toBe(0);
  });
});

describe('calculateCostWithPricing', () => {
  it('calculates using explicit pricing', () => {
    const cost = calculateCostWithPricing(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      { inputCostPerMillion: 3, outputCostPerMillion: 15, cacheWriteCostPerMillion: 0, cacheReadCostPerMillion: 0 }
    );
    expect(cost).toBeCloseTo(18.0, 2);
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
});
