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
      JSON.stringify(
        exportResolvedModelCatalog([
          'gpt-5.6-sol',
          'gpt-5.6-luna',
          'gpt-6-astra',
          'claude-fable-5-1',
          'claude-fable-5.1',
        ]),
      ),
    );
    expect(snapshot.models['gpt-5.6-sol'].contextWindow).toMatchObject({
      published: 1_050_000,
      observed: 258_400,
      tierEffective: 258_400,
    });

    _clearObservedContextWindows();
    _clearCatalogContextWindows();
    _clearPricingOverrides();
    expect(importResolvedModelCatalog(snapshot)).toEqual({ imported: 5, diagnostics: [] });

    for (const id of Object.keys(snapshot.models)) {
      expect(getModelContextWindowSize(id)).toBe(snapshot.models[id].contextWindow.tierEffective);
      expect(getModelPricing(id)).toEqual(snapshot.models[id].pricing.pricing);
    }
  });

  it('exports new models as exact baseline entries for browser consumers', () => {
    const { models } = exportResolvedModelCatalog();
    for (const id of ['gpt-6-astra', 'claude-fable-5-1', 'claude-fable-5.1']) {
      expect(models[id].pricing.provenance).toMatchObject({
        source: 'static',
        match: 'exact',
        matchedModelId: id,
        inheritedByPrefix: false,
      });
      expect(models[id].contextWindow.provenance).toMatchObject({
        source: 'static',
        match: 'exact',
        matchedModelId: id,
      });
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

  it('keeps overrides recorded under an alias id after the alias is registered', () => {
    _setObservedContextWindows({ 'gpt-5.6-sol': 258_400 });
    _setPricingOverrides({
      'gpt-5.6-sol': {
        inputCostPerMillion: 4,
        outputCostPerMillion: 24,
        cacheWriteCostPerMillion: 5,
        cacheReadCostPerMillion: 0.4,
      },
    });

    expect(registerModelAlias('gpt-5.6-sol', 'gpt-5.6')).toBe(true);

    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(258_400);
    expect(getModelPricing('gpt-5.6-sol')).toMatchObject({ inputCostPerMillion: 4 });
    // The alias still resolves ids without their own data to the canonical id.
    expect(getModelContextWindowSize('gpt-5.6')).toBe(1_050_000);
  });

  it('keeps overrides recorded while an alias already exists', () => {
    expect(registerModelAlias('gpt-5.6-sol', 'gpt-5.6')).toBe(true);
    _setObservedContextWindows({ 'gpt-5.6-sol': 258_400 });

    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(258_400);
  });

  it('does not pin unresolved snapshot entries over local data', () => {
    const snapshot = JSON.parse(JSON.stringify(exportResolvedModelCatalog(['mystery-model-x'])));
    expect(snapshot.models['mystery-model-x'].contextWindow.provenance.source).toBe('default');

    const result = importResolvedModelCatalog(snapshot);

    expect(result.imported).toBe(0);
    expect(result.diagnostics).toEqual(['skipped unresolved model catalog entry: mystery-model-x']);
    _setCatalogContextWindows({ 'mystery-model-x': 999_999 });
    expect(getModelContextWindowSize('mystery-model-x')).toBe(999_999);
  });

  it('merges successive partial imports and yields to local observations', () => {
    _setObservedContextWindows({ 'gpt-5.6-sol': 258_400, 'gpt-5.6-luna': 111_111 });
    const first = JSON.parse(JSON.stringify(exportResolvedModelCatalog(['gpt-5.6-sol'])));
    const second = JSON.parse(JSON.stringify(exportResolvedModelCatalog(['gpt-5.6-luna'])));
    _clearObservedContextWindows();

    importResolvedModelCatalog(first);
    importResolvedModelCatalog(second);

    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(258_400);
    expect(getModelContextWindowSize('gpt-5.6-luna')).toBe(111_111);

    // A window this realm observes first-hand outranks the imported snapshot.
    _setObservedContextWindows({ 'gpt-5.6-sol': 131_072 });
    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(131_072);
  });
});
