import {
  _getModelContextIds,
  _setImportedResolvedContextWindows,
  resolveModelContextWindow,
  type ResolvedModelContextWindow,
} from './modelContext';
import {
  _getModelPricingIds,
  _setImportedResolvedPricing,
  resolveModelPricing,
  type ModelPricing,
  type ResolvedModelPricing,
} from './modelInfo';
import {
  _getModelAliases,
  _importModelAliases,
  registerModelAlias,
  resolveModelAlias,
} from './modelAliases';

export const RESOLVED_MODEL_CATALOG_SCHEMA_VERSION = 1 as const;

export interface ResolvedModelCatalogEntry {
  id: string;
  canonicalId: string;
  contextWindow: ResolvedModelContextWindow;
  pricing: ResolvedModelPricing;
}

export interface ResolvedModelCatalogSnapshot {
  schemaVersion: typeof RESOLVED_MODEL_CATALOG_SCHEMA_VERSION;
  models: Record<string, ResolvedModelCatalogEntry>;
  aliases: Record<string, string>;
}

export interface ImportResolvedModelCatalogResult {
  imported: number;
  diagnostics: string[];
}

function normalizedIds(ids?: readonly string[]): string[] {
  if (ids) {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  }
  const aliases = _getModelAliases();
  return Array.from(
    new Set([
      ..._getModelContextIds(),
      ..._getModelPricingIds(),
      ...Object.keys(aliases),
      ...Object.values(aliases),
    ]),
  ).sort();
}

/**
 * Export an entirely serializable catalog suitable for IPC to another JS realm.
 * Each entry records published, observed, and tier-effective context windows,
 * plus pricing match provenance (including prefix inheritance).
 */
export function exportResolvedModelCatalog(ids?: readonly string[]): ResolvedModelCatalogSnapshot {
  const models: Record<string, ResolvedModelCatalogEntry> = {};
  const selectedIds = normalizedIds(ids);
  for (const id of selectedIds) {
    const canonicalId = resolveModelAlias(id);
    models[id] = {
      id,
      canonicalId,
      contextWindow: resolveModelContextWindow(id),
      pricing: resolveModelPricing(id),
    };
  }

  const selectedCanonicalIds = new Set(
    Object.values(models).flatMap(({ id, canonicalId }) => [id, canonicalId]),
  );
  const aliases = Object.fromEntries(
    Object.entries(_getModelAliases()).filter(
      ([alias, canonicalId]) =>
        selectedCanonicalIds.has(alias) || selectedCanonicalIds.has(canonicalId),
    ),
  );
  return { schemaVersion: RESOLVED_MODEL_CATALOG_SCHEMA_VERSION, models, aliases };
}

/**
 * Hydrate exact model resolutions exported by another bundle realm.
 * Invalid entries are skipped and reported; import never partially mutates an
 * entry or throws for malformed IPC data.
 */
export function importResolvedModelCatalog(snapshot: unknown): ImportResolvedModelCatalogResult {
  const diagnostics: string[] = [];
  if (!isRecord(snapshot) || snapshot.schemaVersion !== RESOLVED_MODEL_CATALOG_SCHEMA_VERSION) {
    return { imported: 0, diagnostics: ['unsupported resolved model catalog snapshot'] };
  }

  const aliases = isStringRecord(snapshot.aliases) ? snapshot.aliases : {};
  _importModelAliases(aliases);

  const contexts: Record<string, ResolvedModelContextWindow> = {};
  const prices: Record<string, ResolvedModelPricing> = {};
  const models = isRecord(snapshot.models) ? snapshot.models : {};
  let imported = 0;
  for (const [key, rawEntry] of Object.entries(models)) {
    if (!isResolvedEntry(rawEntry)) {
      diagnostics.push(`ignored invalid model catalog entry: ${key}`);
      continue;
    }
    const entry = rawEntry;
    const normalizedKey = key.trim().toLowerCase();
    const canonicalId = entry.canonicalId.trim().toLowerCase();
    const context = cloneContext(entry.contextWindow, entry.id, canonicalId);
    const pricing = clonePricing(entry.pricing, entry.id, canonicalId);
    // Unresolved facets are not importable facts: pinning a 'default' window
    // or 'none' pricing would outrank data the importing realm can resolve
    // (or later learn) on its own.
    const contextResolved = context.provenance.source !== 'default';
    const pricingResolved = pricing.provenance.source !== 'none';
    if (!contextResolved && !pricingResolved) {
      diagnostics.push(`skipped unresolved model catalog entry: ${key}`);
      continue;
    }
    for (const id of new Set([normalizedKey, entry.id.trim().toLowerCase(), canonicalId])) {
      if (!id) continue;
      if (contextResolved) contexts[id] = context;
      if (pricingResolved) prices[id] = pricing;
    }
    imported++;
  }

  _setImportedResolvedContextWindows(contexts);
  _setImportedResolvedPricing(prices);
  return { imported, diagnostics };
}

function cloneContext(
  value: ResolvedModelContextWindow,
  modelId: string,
  canonicalModelId: string,
): ResolvedModelContextWindow {
  return {
    ...value,
    modelId,
    canonicalModelId,
    provenance: { ...value.provenance },
  };
}

function clonePricing(
  value: ResolvedModelPricing,
  modelId: string,
  canonicalModelId: string,
): ResolvedModelPricing {
  return {
    ...value,
    modelId,
    canonicalModelId,
    pricing: value.pricing ? { ...value.pricing } : null,
    provenance: { ...value.provenance },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function validPricing(value: unknown): value is ModelPricing {
  if (!isRecord(value)) return false;
  return [
    value.inputCostPerMillion,
    value.outputCostPerMillion,
    value.cacheWriteCostPerMillion,
    value.cacheReadCostPerMillion,
  ].every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0);
}

function isResolvedEntry(value: unknown): value is ResolvedModelCatalogEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.canonicalId !== 'string') {
    return false;
  }
  const context = value.contextWindow;
  const pricing = value.pricing;
  if (!isRecord(context) || !isRecord(pricing)) return false;
  if (
    typeof context.tierEffective !== 'number' ||
    !Number.isFinite(context.tierEffective) ||
    context.tierEffective <= 0 ||
    (context.published !== null && typeof context.published !== 'number') ||
    (context.observed !== null && typeof context.observed !== 'number') ||
    !isRecord(context.provenance) ||
    !isRecord(pricing.provenance)
  ) {
    return false;
  }
  return pricing.pricing === null || validPricing(pricing.pricing);
}

export { registerModelAlias, resolveModelAlias };
