/**
 * @fileoverview Unit tests for ModelPricingService.
 */

import { describe, it, expect } from 'vitest';
import { normalizeProviderUsage } from 'sidekick-shared';
import {
  addUsageToPricing,
  ModelPricingService,
  priceModelUsage,
  priceSessionModelUsage,
} from './ModelPricingService';

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

    it('returns correct pricing for Opus 4.8', () => {
      const pricing = ModelPricingService.getPricing('claude-opus-4-8');
      expect(pricing).toEqual({
        inputCostPerMillion: 5.0,
        outputCostPerMillion: 25.0,
        cacheWriteCostPerMillion: 6.25,
        cacheReadCostPerMillion: 0.5,
      });
    });

    it('returns correct pricing for Fable 5', () => {
      const pricing = ModelPricingService.getPricing('claude-fable-5');
      expect(pricing).toEqual({
        inputCostPerMillion: 10.0,
        outputCostPerMillion: 50.0,
        cacheWriteCostPerMillion: 12.5,
        cacheReadCostPerMillion: 1.0,
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

  describe('priceModelUsage', () => {
    const row = (
      model: string,
      usage: Partial<{
        inputTokens: number;
        outputTokens: number;
        cacheWriteTokens: number;
        cacheReadTokens: number;
      }>,
    ) => {
      const entry = {
        calls: 1,
        tokens: 0,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
      };
      return priceModelUsage(model, entry);
    };

    it('calculates cost for simple input/output (haiku)', () => {
      // 1000 tokens at $1.00 per million = $0.001
      expect(row('claude-haiku-4.5-20251215', { inputTokens: 1000 }).cost).toBeCloseTo(0.001, 6);
    });

    it('calculates cost for input and output', () => {
      // Input: 1000 * $1.00 / 1M = $0.001; output: 500 * $5.00 / 1M = $0.0025
      expect(
        row('claude-haiku-4.5-20251215', { inputTokens: 1000, outputTokens: 500 }).cost,
      ).toBeCloseTo(0.0035, 6);
    });

    it('calculates cost with cache write and cache read tokens', () => {
      expect(
        row('claude-haiku-4.5-20251215', {
          inputTokens: 1000,
          outputTokens: 500,
          cacheWriteTokens: 2000,
        }).cost,
      ).toBeCloseTo(0.006, 6);
      expect(
        row('claude-haiku-4.5-20251215', {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 5000,
        }).cost,
      ).toBeCloseTo(0.004, 6);
    });

    it('calculates cost with all token types', () => {
      const priced = row('claude-sonnet-4.5-20241022', {
        inputTokens: 10000,
        outputTokens: 5000,
        cacheWriteTokens: 3000,
        cacheReadTokens: 8000,
      });
      expect(priced).toMatchObject({ priced: true, source: 'estimated' });
      expect(priced.cost).toBeCloseTo(0.11865, 6);
    });

    it('handles large token counts (millions)', () => {
      expect(
        row('claude-opus-4.5-20250514', { inputTokens: 1_000_000, outputTokens: 500_000 }).cost,
      ).toBeCloseTo(17.5, 6);
    });

    it('returns a priced zero for zero tokens', () => {
      expect(row('claude-haiku-4.5-20251215', {})).toEqual({ cost: 0, priced: true });
    });

    it('marks unknown models unpriced with a zero contribution', () => {
      expect(row('made-up-vendor-model', { inputTokens: 1000, outputTokens: 500 })).toEqual({
        cost: 0,
        source: 'unpriced',
        priced: false,
      });
    });

    it('does not price Codex reasoning twice (output already includes it)', () => {
      // input 1000 incl. 200 cached, output 500 incl. 300 reasoning, as the
      // Codex parser normalizes a token_count event.
      const usage = normalizeProviderUsage({
        semantics: 'openai',
        model: 'gpt-6-sol',
        inputTokens: 1000,
        cacheReadTokens: 200,
        outputTokens: 500,
        reasoningTokens: 300,
      });
      const entry = {
        calls: 1,
        tokens: usage.totalTokens,
        inputTokens: usage.uncachedInputTokens,
        outputTokens: usage.outputTokens,
        cacheWriteTokens: 0,
        cacheReadTokens: usage.cacheReadTokens,
        reasoningTokens: usage.reasoningTokens,
      };
      addUsageToPricing(entry, 'gpt-6-sol', usage);
      // 800 × $2 + 200 × $0.20 + 500 × $10 per million. The deprecated
      // calculator added the 300 reasoning tokens again: $0.00964.
      expect(priceModelUsage('gpt-6-sol', entry).cost).toBeCloseTo(0.00664, 8);
    });

    it('bills reasoning reported apart from output at the output rate', () => {
      const entry = {
        calls: 1,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      };
      addUsageToPricing(
        entry,
        'o3-mini',
        normalizeProviderUsage({
          semantics: 'sidekick',
          reasoningTokens: 1_000_000,
          reasoningIncludedInOutput: false,
        }),
      );
      // o3-mini output rate is $4.40/M
      expect(priceModelUsage('o3-mini', entry).cost).toBeCloseTo(4.4, 2);
    });

    it('keeps provider-reported spend and prices only the rest', () => {
      const entry = {
        calls: 2,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      };
      addUsageToPricing(
        entry,
        'claude-haiku-4.5-20251215',
        normalizeProviderUsage({
          semantics: 'anthropic',
          inputTokens: 5000,
          reportedCostUsd: 0.5,
        }),
      );
      addUsageToPricing(
        entry,
        'claude-haiku-4.5-20251215',
        normalizeProviderUsage({ semantics: 'anthropic', inputTokens: 1000 }),
      );
      const priced = priceModelUsage('claude-haiku-4.5-20251215', entry);
      expect(priced.cost).toBeCloseTo(0.501, 6);
      expect(priced.source).toBe('estimated');
    });

    it('prices each merged raw id with its own price', () => {
      const entry = {
        calls: 2,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      };
      addUsageToPricing(
        entry,
        'claude-haiku-4.5-20251215',
        normalizeProviderUsage({ semantics: 'anthropic', inputTokens: 1000 }),
      );
      addUsageToPricing(
        entry,
        'unknown-deployment/claude-haiku-4.5',
        normalizeProviderUsage({ semantics: 'anthropic', inputTokens: 1000 }),
      );
      // The priced part counts; the row is partial.
      expect(priceModelUsage('claude-haiku-4.5', entry)).toEqual({
        cost: expect.closeTo(0.001, 6),
        source: 'unpriced',
        priced: false,
      });
    });
  });

  describe('priceSessionModelUsage', () => {
    it('sums priced rows and lists unpriced ones', () => {
      const result = priceSessionModelUsage(
        new Map([
          [
            'claude-haiku-4.5',
            {
              calls: 1,
              tokens: 1000,
              inputTokens: 1000,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
            },
          ],
          [
            'made-up-vendor-model',
            {
              calls: 2,
              tokens: 10,
              inputTokens: 10,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
            },
          ],
        ]),
      );
      expect(result.totalCost).toBeCloseTo(0.001, 6);
      expect(result.unpricedModelIds).toEqual(['made-up-vendor-model']);
      expect(result.source).toBe('unpriced');
      expect(result.rows.map((r) => [r.model, r.calls, r.priced])).toEqual([
        ['claude-haiku-4.5', 1, true],
        ['made-up-vendor-model', 2, false],
      ]);
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
