import { afterEach, describe, expect, it } from 'vitest';
import {
  _clearPricingOverrides,
  _setPricingOverrides,
  calculateCost,
  clearRegisteredModelPricing,
  getModelInfo,
  getModelPricing,
  registerModelPricing,
  resolveModelPricing,
} from './modelInfo';
import {
  _clearCatalogContextWindows,
  _clearObservedContextWindows,
  _setObservedContextWindows,
  DEFAULT_CONTEXT_WINDOW,
  getModelContextWindowSize,
  resolveModelContextWindow,
} from './modelContext';
import { calculateNormalizedUsageCost, normalizeProviderUsage } from './usageNormalization';
import { normalizeToolName } from './parsers/openCodeParser';
import { formatToolSummary } from './formatters/toolSummary';
import { parseZaiQuotaError } from './zaiQuota';
import { exportResolvedModelCatalog } from './modelCatalog';

// Names inherited from Object.prototype that a plain `table[key]` would find.
const PROTOTYPE_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];

const PRICE = {
  inputCostPerMillion: 1,
  outputCostPerMillion: 2,
  cacheWriteCostPerMillion: 1.25,
  cacheReadCostPerMillion: 0.1,
};

afterEach(() => {
  _clearPricingOverrides();
  clearRegisteredModelPricing();
  _clearObservedContextWindows();
  _clearCatalogContextWindows();
});

describe('lookups keyed by ids that collide with Object.prototype', () => {
  for (const name of PROTOTYPE_NAMES) {
    describe(JSON.stringify(name), () => {
      it('resolves as an unpriced model with provenance', () => {
        expect(getModelPricing(name)).toBeNull();
        const resolved = resolveModelPricing(name);
        expect(resolved.pricing).toBeNull();
        expect(resolved.provenance).toEqual({
          source: 'none',
          match: 'none',
          inheritedByPrefix: false,
        });
        expect(getModelInfo(name).pricing).toBeNull();
        expect(
          calculateCost(
            { inputTokens: 1000, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0 },
            name,
          ),
        ).toBeNull();
        const usage = normalizeProviderUsage({
          provider: 'claude-code',
          model: name,
          inputTokens: 1000,
          outputTokens: 10,
        });
        expect(calculateNormalizedUsageCost({ usage }).source).toBe('unpriced');
      });

      it('falls back to the default context window', () => {
        expect(getModelContextWindowSize(name)).toBe(DEFAULT_CONTEXT_WINDOW);
        const resolved = resolveModelContextWindow(name);
        expect(resolved.tierEffective).toBe(DEFAULT_CONTEXT_WINDOW);
        expect(resolved.provenance.source).toBe('default');
      });

      it('formats as an ordinary tool name', () => {
        expect(typeof normalizeToolName(name)).toBe('string');
        expect(typeof formatToolSummary(name, { file_path: '/tmp/a.ts' })).toBe('string');
        expect(typeof formatToolSummary(`mcp__server__${name}`, { query: 'x' })).toBe('string');
      });

      it('is not a z.ai error code', () => {
        expect(parseZaiQuotaError({ code: name, message: 'x' })).toBeNull();
      });
    });
  }

  it('still prices such ids when a layer lists them explicitly', () => {
    registerModelPricing({ constructor: PRICE });
    expect(resolveModelPricing('constructor').provenance.source).toBe('registered');
    clearRegisteredModelPricing();

    _setPricingOverrides({ constructor: PRICE, ['__proto__']: PRICE });
    expect(getModelPricing('constructor')).toEqual(PRICE);
    expect(getModelPricing('__proto__')).toEqual(PRICE);
    expect(resolveModelPricing('__proto__').provenance.source).toBe('catalog');
  });

  it('keeps an observed __proto__ window as data', () => {
    _setObservedContextWindows(JSON.parse('{"__proto__": 123456}') as Record<string, number>);
    expect(getModelContextWindowSize('__proto__')).toBe(123456);
    expect(getModelContextWindowSize('constructor')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('exports a __proto__ id as an own catalog entry', () => {
    const snapshot = exportResolvedModelCatalog(['__proto__']);
    expect(Object.keys(snapshot.models)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(snapshot.models)).toBe(Object.prototype);
  });
});
