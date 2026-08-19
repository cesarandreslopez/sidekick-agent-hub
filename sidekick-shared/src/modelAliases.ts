const aliases = new Map<string, string>();

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Register a short or host-specific model name that resolves to a canonical ID.
 * Invalid and cyclic registrations are rejected without changing the registry.
 */
export function registerModelAlias(alias: string, canonicalId: string): boolean {
  const normalizedAlias = normalizeAlias(alias);
  const normalizedCanonicalId = normalizeAlias(canonicalId);
  if (!normalizedAlias || !normalizedCanonicalId || normalizedAlias === normalizedCanonicalId) {
    return false;
  }

  let candidate = normalizedCanonicalId;
  const visited = new Set([normalizedAlias]);
  while (aliases.has(candidate)) {
    if (visited.has(candidate)) return false;
    visited.add(candidate);
    candidate = aliases.get(candidate)!;
  }
  if (candidate === normalizedAlias) return false;

  aliases.set(normalizedAlias, normalizedCanonicalId);
  return true;
}

/** Resolve a registered alias, returning normalized input when no alias exists. */
export function resolveModelAlias(modelId: string): string {
  let current = normalizeAlias(modelId);
  const visited = new Set<string>();
  while (aliases.has(current) && !visited.has(current)) {
    visited.add(current);
    current = aliases.get(current)!;
  }
  return current;
}

/** Internal snapshot used by the cross-realm catalog serializer. */
export function _getModelAliases(): Record<string, string> {
  return Object.fromEntries(aliases);
}

/** Internal hydration hook used by the cross-realm catalog importer. */
export function _importModelAliases(values: Record<string, string>): void {
  for (const [alias, canonicalId] of Object.entries(values)) {
    registerModelAlias(alias, canonicalId);
  }
}

/** Internal test hook. */
export function _clearModelAliases(): void {
  aliases.clear();
}
