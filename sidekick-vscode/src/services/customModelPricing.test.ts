import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredModelPricing,
  getModelPricing,
  getPricingCatalogInfo,
} from 'sidekick-shared';
import {
  applyCustomModelPricing,
  getCustomModelPricingStatus,
  parseCustomModelPricing,
} from './customModelPricing';

afterEach(() => clearRegisteredModelPricing());

describe('parseCustomModelPricing', () => {
  it('accepts valid entries and defaults cache rates to the input rate', () => {
    expect(
      parseCustomModelPricing({
        ' my-local-model ': { inputCostPerMillion: 0.5, outputCostPerMillion: 1.5 },
        full: {
          inputCostPerMillion: 1,
          outputCostPerMillion: 2,
          cacheWriteCostPerMillion: 1.25,
          cacheReadCostPerMillion: 0.1,
        },
      }),
    ).toEqual({
      entries: {
        'my-local-model': {
          inputCostPerMillion: 0.5,
          outputCostPerMillion: 1.5,
          cacheWriteCostPerMillion: 0.5,
          cacheReadCostPerMillion: 0.5,
        },
        full: {
          inputCostPerMillion: 1,
          outputCostPerMillion: 2,
          cacheWriteCostPerMillion: 1.25,
          cacheReadCostPerMillion: 0.1,
        },
      },
      invalid: [],
    });
  });

  it('lists entries it cannot use', () => {
    const parsed = parseCustomModelPricing({
      missingOutput: { inputCostPerMillion: 1 },
      negative: { inputCostPerMillion: -1, outputCostPerMillion: 1 },
      text: { inputCostPerMillion: '1', outputCostPerMillion: 1 },
      badCache: { inputCostPerMillion: 1, outputCostPerMillion: 1, cacheReadCostPerMillion: NaN },
      notAnObject: 3,
      '  ': { inputCostPerMillion: 1, outputCostPerMillion: 1 },
    });
    expect(parsed.entries).toEqual({});
    expect(parsed.invalid).toEqual([
      'missingOutput',
      'negative',
      'text',
      'badCache',
      'notAnObject',
      '  ',
    ]);
    expect(parseCustomModelPricing(undefined)).toEqual({ entries: {}, invalid: [] });
    expect(parseCustomModelPricing([1])).toEqual({ entries: {}, invalid: [] });
  });
});

describe('applyCustomModelPricing', () => {
  it('registers entries, replacing the previous registration', () => {
    applyCustomModelPricing(
      { 'my-local-model': { inputCostPerMillion: 0.5, outputCostPerMillion: 1.5 } },
      true,
    );
    expect(getModelPricing('my-local-model')?.outputCostPerMillion).toBe(1.5);
    expect(getPricingCatalogInfo().registeredEntries).toBe(1);
    expect(getCustomModelPricingStatus()).toEqual({
      applied: ['my-local-model'],
      invalid: [],
      onlyIfMissing: true,
    });

    applyCustomModelPricing({}, true);
    expect(getModelPricing('my-local-model')).toBeNull();
    expect(getPricingCatalogInfo().registeredEntries).toBe(0);
  });

  it('fills gaps only unless told to override', () => {
    const builtIn = getModelPricing('claude-haiku-4.5')!;
    const custom = { 'claude-haiku-4.5': { inputCostPerMillion: 99, outputCostPerMillion: 99 } };
    applyCustomModelPricing(custom, true);
    expect(getModelPricing('claude-haiku-4.5')).toEqual(builtIn);
    applyCustomModelPricing(custom, false);
    expect(getModelPricing('claude-haiku-4.5')?.inputCostPerMillion).toBe(99);
  });
});
