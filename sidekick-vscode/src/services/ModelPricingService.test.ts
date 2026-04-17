/**
 * @fileoverview Unit tests for ModelPricingService.
 */

import { describe, it, expect } from 'vitest';
import { ModelPricingService } from './ModelPricingService';

describe('ModelPricingService', () => {
  describe('parseModelId', () => {
    it('parses Opus 4 model ID', () => {
      const result = ModelPricingService.parseModelId('claude-opus-4-20250514');
      expect(result).toEqual({ provider: 'anthropic', family: 'opus', version: '4' });
    });

    it('parses Sonnet 4.5 model ID', () => {
      const result = ModelPricingService.parseModelId('claude-sonnet-4.5-20241022');
      expect(result).toEqual({ provider: 'anthropic', family: 'sonnet', version: '4.5' });
    });

    it('parses Haiku 4.5 model ID', () => {
      const result = ModelPricingService.parseModelId('claude-haiku-4.5-20251215');
      expect(result).toEqual({ provider: 'anthropic', family: 'haiku', version: '4.5' });
    });

    it('parses GPT model IDs', () => {
      expect(ModelPricingService.parseModelId('gpt-4o')).toEqual({
        provider: 'openai',
        family: 'gpt',
        version: '4o',
      });
      expect(ModelPricingService.parseModelId('gpt-5.4')).toEqual({
        provider: 'openai',
        family: 'gpt',
        version: '5.4',
      });
    });

    it('parses o-series reasoning model IDs', () => {
      expect(ModelPricingService.parseModelId('o3-mini')).toEqual({
        provider: 'openai',
        family: 'o',
        version: '3-mini',
      });
    });

    it('returns null for completely unrecognized model IDs', () => {
      expect(ModelPricingService.parseModelId('deepseek-coder')).toBeNull();
      expect(ModelPricingService.parseModelId('invalid-model-id')).toBeNull();
      expect(ModelPricingService.parseModelId('')).toBeNull();
    });

    it('handles case-insensitive family names', () => {
      const result = ModelPricingService.parseModelId('claude-OPUS-4-20250514');
      expect(result).toEqual({ provider: 'anthropic', family: 'opus', version: '4' });
    });
  });

  describe('getPricing', () => {
    it('returns correct pricing for Opus 4.5', () => {
      const pricing = ModelPricingService.getPricing('claude-opus-4.5-20250514');
      expect(pricing).toEqual({
        inputCostPerMillion: 5.0,
        outputCostPerMillion: 25.0,
        cacheWriteCostPerMillion: 6.25,
        cacheReadCostPerMillion: 0.5,
      });
    });

    it('returns correct pricing for Haiku 4.5', () => {
      const pricing = ModelPricingService.getPricing('claude-haiku-4.5-20251215');
      expect(pricing).toEqual({
        inputCostPerMillion: 1.0,
        outputCostPerMillion: 5.0,
        cacheWriteCostPerMillion: 1.25,
        cacheReadCostPerMillion: 0.1,
      });
    });

    it('returns correct pricing for Sonnet 4.5', () => {
      const pricing = ModelPricingService.getPricing('claude-sonnet-4.5-20241022');
      expect(pricing).toEqual({
        inputCostPerMillion: 3.0,
        outputCostPerMillion: 15.0,
        cacheWriteCostPerMillion: 3.75,
        cacheReadCostPerMillion: 0.3,
      });
    });

    it('returns correct pricing for Sonnet 4', () => {
      const pricing = ModelPricingService.getPricing('claude-sonnet-4-20240229');
      expect(pricing).toEqual({
        inputCostPerMillion: 3.0,
        outputCostPerMillion: 15.0,
        cacheWriteCostPerMillion: 3.75,
        cacheReadCostPerMillion: 0.3,
      });
    });

    it('returns GPT-4o pricing', () => {
      const pricing = ModelPricingService.getPricing('gpt-4o');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputCostPerMillion).toBe(2.5);
      expect(pricing!.outputCostPerMillion).toBe(10.0);
    });

    it('returns null for completely unknown models (no silent fallback)', () => {
      expect(ModelPricingService.getPricing('deepseek-coder')).toBeNull();
      expect(ModelPricingService.getPricing('made-up-vendor-model')).toBeNull();
    });
  });

  describe('calculateCost', () => {
    it('calculates cost for simple input/output (haiku)', () => {
      const pricing = ModelPricingService.getPricing('claude-haiku-4.5-20251215');
      const cost = ModelPricingService.calculateCost(
        { inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
        pricing,
      );
      // 1000 tokens at $1.00 per million = $0.001
      expect(cost).toBeCloseTo(0.001, 6);
    });

    it('calculates cost for input and output', () => {
      const pricing = ModelPricingService.getPricing('claude-haiku-4.5-20251215');
      const cost = ModelPricingService.calculateCost(
        { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0 },
        pricing,
      );
      // Input: 1000 * $1.00 / 1M = $0.001
      // Output: 500 * $5.00 / 1M = $0.0025
      // Total: $0.0035
      expect(cost).toBeCloseTo(0.0035, 6);
    });

    it('calculates cost with cache write tokens', () => {
      const pricing = ModelPricingService.getPricing('claude-haiku-4.5-20251215');
      const cost = ModelPricingService.calculateCost(
        { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000, cacheReadTokens: 0 },
        pricing,
      );
      expect(cost).toBeCloseTo(0.006, 6);
    });

    it('calculates cost with cache read tokens', () => {
      const pricing = ModelPricingService.getPricing('claude-haiku-4.5-20251215');
      const cost = ModelPricingService.calculateCost(
        { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 5000 },
        pricing,
      );
      expect(cost).toBeCloseTo(0.004, 6);
    });

    it('calculates cost with all token types', () => {
      const pricing = ModelPricingService.getPricing('claude-sonnet-4.5-20241022');
      const cost = ModelPricingService.calculateCost(
        { inputTokens: 10000, outputTokens: 5000, cacheWriteTokens: 3000, cacheReadTokens: 8000 },
        pricing,
      );
      expect(cost).toBeCloseTo(0.11865, 6);
    });

    it('prices reasoning tokens at the output rate', () => {
      const pricing = ModelPricingService.getPricing('o3-mini');
      const cost = ModelPricingService.calculateCost(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          reasoningTokens: 1_000_000,
        },
        pricing,
      );
      // o3-mini output rate is $4.40/M
      expect(cost).toBeCloseTo(4.4, 2);
    });

    it('returns 0 for zero tokens', () => {
      const pricing = ModelPricingService.getPricing('claude-haiku-4.5-20251215');
      const cost = ModelPricingService.calculateCost(
        { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
        pricing,
      );
      expect(cost).toBe(0);
    });

    it('returns null when pricing is null', () => {
      const cost = ModelPricingService.calculateCost(
        { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0 },
        null,
      );
      expect(cost).toBeNull();
    });

    it('handles large token counts (millions)', () => {
      const pricing = ModelPricingService.getPricing('claude-opus-4.5-20250514');
      const cost = ModelPricingService.calculateCost(
        { inputTokens: 1_000_000, outputTokens: 500_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
        pricing,
      );
      expect(cost).toBeCloseTo(17.5, 6);
    });
  });

  describe('formatCost', () => {
    it('formats very small costs with 4 decimals', () => {
      expect(ModelPricingService.formatCost(0.001234)).toBe('$0.0012');
    });

    it('formats small costs under $0.01 with 4 decimals', () => {
      expect(ModelPricingService.formatCost(0.00567)).toBe('$0.0057');
    });

    it('formats costs >= $0.01 with 2 decimals', () => {
      expect(ModelPricingService.formatCost(0.15)).toBe('$0.15');
    });

    it('formats costs >= $1 with 2 decimals', () => {
      expect(ModelPricingService.formatCost(1.234)).toBe('$1.23');
    });

    it('formats large costs with 2 decimals', () => {
      expect(ModelPricingService.formatCost(17.5)).toBe('$17.50');
    });

    it('formats zero cost', () => {
      expect(ModelPricingService.formatCost(0)).toBe('$0.0000');
    });

    it('rounds at boundary ($0.01)', () => {
      expect(ModelPricingService.formatCost(0.01)).toBe('$0.01');
    });

    it('formats cost just below $0.01', () => {
      expect(ModelPricingService.formatCost(0.00999)).toBe('$0.0100');
    });

    it("renders null as '—'", () => {
      expect(ModelPricingService.formatCost(null)).toBe('—');
    });

    it("renders undefined as '—'", () => {
      expect(ModelPricingService.formatCost(undefined)).toBe('—');
    });
  });
});
