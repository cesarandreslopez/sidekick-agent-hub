import { afterEach, describe, expect, it } from 'vitest';
import {
  _clearCatalogContextWindows,
  _clearImportedResolvedContextWindows,
  _clearObservedContextWindows,
  _setCatalogContextWindows,
  _setObservedContextWindows,
  getModelContextWindowSize,
} from './modelContext';
import {
  _clearImportedResolvedPricing,
  _clearPricingOverrides,
  _setPricingOverrides,
  getModelPricing,
  resolveModelPricing,
} from './modelInfo';
import { _clearModelAliases, registerModelAlias } from './modelAliases';
import { exportResolvedModelCatalog, importResolvedModelCatalog } from './modelCatalog';

afterEach(() => {
  _clearObservedContextWindows();
  _clearCatalogContextWindows();
  _clearPricingOverrides();
  _clearImportedResolvedContextWindows();
  _clearImportedResolvedPricing();
  _clearModelAliases();
});

describe('resolved model catalog', () => {
  it('round-trips exact effective windows and pricing across realms', () => {
    _setObservedContextWindows({ 'gpt-5.6-sol': 258_400 });
    _setCatalogContextWindows({ 'gpt-5.6-sol': 1_050_000 });
    _setPricingOverrides({
      'gpt-5.6-sol': {
        inputCostPerMillion: 4,
        outputCostPerMillion: 24,
        cacheWriteCostPerMillion: 5,
        cacheReadCostPerMillion: 0.4,
      },
    });
    const snapshot = JSON.parse(
      JSON.stringify(exportResolvedModelCatalog(['gpt-5.6-sol', 'gpt-5.6-luna'])),
    );
    expect(snapshot.models['gpt-5.6-sol'].contextWindow).toMatchObject({
      published: 1_050_000,
      observed: 258_400,
      tierEffective: 258_400,
    });

    _clearObservedContextWindows();
    _clearCatalogContextWindows();
    _clearPricingOverrides();
    expect(importResolvedModelCatalog(snapshot)).toEqual({ imported: 2, diagnostics: [] });

    for (const id of Object.keys(snapshot.models)) {
      expect(getModelContextWindowSize(id)).toBe(snapshot.models[id].contextWindow.tierEffective);
      expect(getModelPricing(id)).toEqual(snapshot.models[id].pricing.pricing);
    }
  });

  it('registers aliases and carries them in the snapshot', () => {
    expect(registerModelAlias('sonnet', 'claude-sonnet-5')).toBe(true);
    expect(getModelContextWindowSize('sonnet')).toBe(1_000_000);
    expect(getModelPricing('sonnet')).toEqual(getModelPricing('claude-sonnet-5'));
    const snapshot = exportResolvedModelCatalog(['sonnet']);
    expect(snapshot.aliases).toEqual({ sonnet: 'claude-sonnet-5' });
  });

  it('marks prefix-inherited pricing so callers can refuse it', () => {
    expect(resolveModelPricing('gpt-5.6-unlisted').provenance).toMatchObject({
      match: 'prefix',
      matchedModelId: 'gpt-5.6',
      inheritedByPrefix: true,
    });
    expect(resolveModelPricing('gpt-5.6-luna').provenance).toMatchObject({
      match: 'exact',
      inheritedByPrefix: false,
    });
  });

  it('fails soft for an invalid IPC snapshot', () => {
    expect(importResolvedModelCatalog({ schemaVersion: 999 })).toEqual({
      imported: 0,
      diagnostics: ['unsupported resolved model catalog snapshot'],
    });
  });
});
