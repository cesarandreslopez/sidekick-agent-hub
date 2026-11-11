import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveModelPricing,
  resolvePricingTier,
  getModelInfo,
  _clearPricingOverrides,
  _setPricingOverrides,
  _clearImportedResolvedPricing,
} from './modelInfo';
import {
  resolveModelContextWindow,
  _clearCatalogContextWindows,
  _setCatalogContextWindows,
  _clearObservedContextWindows,
  _setObservedContextWindows,
  _clearImportedResolvedContextWindows,
} from './modelContext';
import { exportResolvedModelCatalog, importResolvedModelCatalog } from './modelCatalog';
import { hydratePricingCatalog } from './pricingCatalog';

// Expected published API baselines as of 2026-11-11, including accepted aliases.
// GPT-5.6/6/6.1 windows are the maximum input (1.05M total minus 128K output).
const cases: Array<[string, string, number, number, number, number, number]> = [
  ['anthropic', 'claude-fable-5-2', 8, 40, 10, 0.2, 1_000_000],
  ['anthropic', 'claude-fable-5.2', 8, 40, 10, 0.2, 1_000_000],
  ['anthropic', 'claude-mythos-5-2', 8, 40, 10, 0.2, 1_000_000],
  ['anthropic', 'claude-mythos-5.2', 8, 40, 10, 0.2, 1_000_000],
  ['anthropic', 'claude-opus-5-5', 4, 20, 5, 0.2, 1_000_000],
  ['anthropic', 'claude-opus-5.5', 4, 20, 5, 0.2, 1_000_000],
  ['openai', 'gpt-6-astra', 10, 50, 12.5, 1, 922_000],
  ['openai', 'gpt-6-sol', 2, 10, 2.5, 0.2, 922_000],
  ['openai', 'gpt-6-luna', 0.1, 0.5, 0.125, 0.01, 922_000],
  ['openai', 'gpt-6-cyber', 20, 100, 25, 2, 922_000],
  ['openai', 'gpt-6-rosalind', 15, 75, 18.75, 1.5, 922_000],
  ['openai', 'gpt-6-astra-law', 10, 50, 0, 1, 922_000],
  ['openai', 'gpt-6.1-sol', 2, 10, 2.5, 0.1, 922_000],
  ['openai', 'gpt-6.1-terra', 1, 5, 1.25, 0.05, 922_000],
  ['anthropic', 'claude-sonnet-5-5', 2, 10, 2.5, 0.1, 1_000_000],
  ['anthropic', 'claude-sonnet-5.5', 2, 10, 2.5, 0.1, 1_000_000],
  ['anthropic', 'claude-haiku-5-5', 0.1, 0.5, 0.125, 0.01, 1_000_000],
  ['anthropic', 'claude-haiku-5.5', 0.1, 0.5, 0.125, 0.01, 1_000_000],
  ['gemini', 'gemini-4-argon', 2, 10, 0, 0.1, 1_048_576],
  ['gemini', 'gemini-3.8-flash', 0.75, 3.75, 0, 0.075, 1_048_576],
  ['deepseek', 'deepseek-flash', 0.3, 1.2, 0, 0.006, 1_000_000],
  ['deepseek', 'deepseek-v4-flash', 0.3, 1.2, 0, 0.006, 1_000_000],
  ['deepseek', 'deepseek-v4-flash-vision-exp', 0.3, 1.2, 0, 0.006, 1_000_000],
  ['deepseek', 'deepseek-v4-pro', 1.32, 3.96, 0, 0.044, 1_000_000],
  ['zai', 'glm-5.3', 1.4, 4.4, 0, 0.26, 1_000_000],
  ['zai', 'glm-5.3-flash', 0.15, 0.5, 0, 0.03, 1_000_000],
  ['zai', 'glm-5.3-flashx', 0.37, 1.25, 0, 0.075, 1_000_000],
];
function reset() {
  _clearPricingOverrides();
  _clearCatalogContextWindows();
  _clearObservedContextWindows();
  _clearImportedResolvedPricing();
  _clearImportedResolvedContextWindows();
}
afterEach(reset);

describe('current coding model offline baselines', () => {
  it.each(cases)(
    '%s/%s has exact offline metadata',
    (provider, id, input, output, write, read, window) => {
      const pricing = {
        inputCostPerMillion: input,
        outputCostPerMillion: output,
        cacheWriteCostPerMillion: write,
        cacheReadCostPerMillion: read,
      };
      for (const key of [id, `${provider}/${id}`]) {
        expect(resolveModelPricing(key)).toMatchObject({
          pricing,
          provenance: {
            source: 'static',
            match: 'exact',
            matchedModelId: key,
            inheritedByPrefix: false,
          },
        });
        expect(resolveModelContextWindow(key)).toMatchObject({
          published: window,
          tierEffective: window,
          provenance: { source: 'static', match: 'exact', matchedModelId: key },
        });
        expect(getModelInfo(` ${key.toUpperCase()} `)).toMatchObject({
          pricing,
          contextWindow: window,
        });
        expect(resolveModelPricing(`${key}-20261030`)).toMatchObject({
          pricing,
          provenance: { match: 'prefix', matchedModelId: key },
        });
        expect(resolveModelContextWindow(`${key}-20261030`).tierEffective).toBe(window);
      }
    },
  );

  it('preserves predecessor rates and unknown pricing', () => {
    expect(resolveModelPricing('gpt-6-sol').pricing?.cacheReadCostPerMillion).toBe(0.2);
    expect(resolveModelPricing('claude-sonnet-5').pricing?.cacheReadCostPerMillion).toBe(0.2);
    expect(resolveModelPricing('claude-haiku-4-5').pricing?.inputCostPerMillion).toBe(1);
    expect(resolveModelPricing('deepseek-coder').pricing).toBeNull();
    expect(resolveModelPricing('made-up-model').pricing).toBeNull();
    expect(resolveModelPricing('other-deployment/gpt-6.1-sol').pricing).toBeNull();
  });

  it('keeps exact catalog rates and observed account windows ahead of the baseline', () => {
    const id = 'gpt-6.1-sol';
    _setPricingOverrides({
      [id]: {
        inputCostPerMillion: 9,
        outputCostPerMillion: 18,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 1,
      },
    });
    _setCatalogContextWindows({ [id]: 922_000 });
    expect(resolveModelPricing(id).provenance.source).toBe('catalog');
    expect(resolveModelPricing(id).pricing?.inputCostPerMillion).toBe(9);
    expect(resolveModelContextWindow(id).tierEffective).toBe(922_000);
    _setObservedContextWindows({ [id]: 500_000 });
    expect(resolveModelContextWindow(id)).toMatchObject({
      published: 922_000,
      observed: 500_000,
      tierEffective: 500_000,
      provenance: { source: 'observed' },
    });
  });

  it('exports every new baseline for browser consumers and round-trips it', () => {
    const ids = cases.flatMap(([provider, id]) => [id, `${provider}/${id}`]);
    const snapshot = JSON.parse(JSON.stringify(exportResolvedModelCatalog()));
    for (const id of ids) {
      expect(snapshot.models[id].pricing.provenance.match).toBe('exact');
      expect(snapshot.models[id].contextWindow.provenance.match).toBe('exact');
    }
    expect(importResolvedModelCatalog(snapshot).diagnostics).toEqual([]);
    for (const id of ids) {
      expect(resolveModelPricing(id).pricing).toEqual(snapshot.models[id].pricing.pricing);
      expect(resolveModelContextWindow(id).tierEffective).toBe(
        snapshot.models[id].contextWindow.tierEffective,
      );
    }
  });

  it.each([true, false])(
    'retains the baselines with an empty cache (offline=%s)',
    async (offline) => {
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-model-baselines-'));
      const fetchImpl = vi.fn(async () => {
        throw new Error('network unavailable');
      });
      try {
        expect((await hydratePricingCatalog({ cacheDir, offline, fetchImpl })).source).toBe(
          'offline',
        );
        expect(fetchImpl).toHaveBeenCalledTimes(offline ? 0 : 1);
        for (const [provider, id, input, , , , window] of cases) {
          for (const key of [id, `${provider}/${id}`]) {
            expect(resolveModelPricing(key).pricing?.inputCostPerMillion).toBe(input);
            expect(resolveModelContextWindow(key).tierEffective).toBe(window);
          }
        }
      } finally {
        await fs.rm(cacheDir, { recursive: true, force: true });
      }
    },
  );
});

describe('older and inherited model rates (2026-11-11)', () => {
  it('keeps the previous Fable and Mythos cache-read rates', () => {
    for (const id of [
      'claude-fable-5-1',
      'claude-fable-5.1',
      'claude-mythos-5-1',
      'claude-mythos-5.1',
    ]) {
      expect(resolveModelPricing(id).pricing).toMatchObject({
        inputCostPerMillion: 10,
        outputCostPerMillion: 50,
        cacheReadCostPerMillion: 0.25,
      });
    }
    for (const id of ['claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview']) {
      expect(resolveModelPricing(id).pricing).toMatchObject({
        inputCostPerMillion: 10,
        cacheReadCostPerMillion: 1,
      });
      expect(resolveModelContextWindow(id).tierEffective).toBe(1_000_000);
    }
  });

  it('prices Fable 5.2 on its own rates rather than the Fable 5 prefix', () => {
    const fable52 = resolveModelPricing('claude-fable-5-2-20261101');
    expect(fable52.provenance.matchedModelId).toBe('claude-fable-5-2');
    expect(fable52.pricing?.cacheReadCostPerMillion).toBe(0.2);
  });

  it('locks in the Codex-era ids an older key already prices exactly', () => {
    for (const id of ['gpt-5-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max']) {
      expect(resolveModelPricing(id)).toMatchObject({
        pricing: {
          inputCostPerMillion: 1.25,
          outputCostPerMillion: 10,
          cacheReadCostPerMillion: 0.125,
        },
        provenance: { match: 'prefix', matchedModelId: 'gpt-5' },
      });
    }
    expect(resolveModelPricing('gpt-5.2-codex')).toMatchObject({
      pricing: { inputCostPerMillion: 1.75, outputCostPerMillion: 14 },
      provenance: { match: 'prefix', matchedModelId: 'gpt-5.2' },
    });
  });

  it('prices o4-mini and the cyber specialties exactly, not by a cheaper prefix', () => {
    expect(resolveModelPricing('o4-mini')).toMatchObject({
      pricing: {
        inputCostPerMillion: 1.1,
        outputCostPerMillion: 4.4,
        cacheReadCostPerMillion: 0.275,
      },
      provenance: { match: 'exact' },
    });
    expect(resolveModelPricing('gpt-5.6-cyber').pricing?.inputCostPerMillion).toBe(12.5);
    expect(resolveModelContextWindow('gpt-5.6-cyber').tierEffective).toBe(272_000);
    expect(resolveModelPricing('gpt-5.5-cyber').pricing?.outputCostPerMillion).toBe(75);
    expect(resolveModelPricing('gpt-6-astra-law').pricing?.tiers).toBeUndefined();
  });

  it('gives dotted Opus 4.x and Sonnet 4.6 ids their 1M window', () => {
    for (const id of [
      'claude-opus-4.8',
      'claude-opus-4.7',
      'claude-opus-4.6',
      'claude-sonnet-4.6',
    ]) {
      expect(resolveModelContextWindow(id).tierEffective).toBe(1_000_000);
    }
  });
});

describe('long-context tier boundaries', () => {
  it.each([
    ['claude-haiku-5-5', 100_000, 0.1, 0.5],
    ['anthropic/claude-haiku-5.5', 100_000, 0.1, 0.5],
    ['gpt-6.1-sol', 272_000, 2, 4],
    ['openai/gpt-6.1-sol', 272_000, 2, 4],
    ['gpt-6-astra', 272_000, 10, 20],
    ['openai/gpt-6-astra', 272_000, 10, 20],
    ['gpt-5.6-sol', 272_000, 4, 8],
    ['gpt-5.5', 272_000, 5, 10],
  ])('%s switches to its tier strictly above %d prompt tokens', (id, threshold, base, tiered) => {
    const pricing = resolveModelPricing(id).pricing;
    expect(pricing?.inputCostPerMillion).toBe(base);
    expect(resolvePricingTier(pricing, threshold)).toBeNull();
    expect(resolvePricingTier(pricing, threshold + 1)?.inputCostPerMillion).toBe(tiered);
    expect(resolvePricingTier(pricing, threshold + 1)?.aboveInputTokens).toBe(threshold);
  });

  it('round-trips tiers through a catalog export', () => {
    const snapshot = JSON.parse(JSON.stringify(exportResolvedModelCatalog(['gpt-6-astra'])));
    expect(snapshot.models['gpt-6-astra'].pricing.pricing.tiers).toHaveLength(1);
    expect(importResolvedModelCatalog(snapshot).diagnostics).toEqual([]);
    expect(resolveModelPricing('gpt-6-astra').pricing?.tiers?.[0]).toMatchObject({
      aboveInputTokens: 272_000,
      outputCostPerMillion: 75,
    });
  });
});
