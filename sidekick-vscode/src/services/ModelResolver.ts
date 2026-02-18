/**
 * @fileoverview Central model resolution logic.
 *
 * Converts user-facing model config values ("auto", "haiku", "fast", etc.)
 * into the concrete model identifier expected by each inference provider.
 *
 * @module services/ModelResolver
 */

import {
  type InferenceProviderId,
  type ModelTier,
  LEGACY_TIER_MAP,
  DEFAULT_MODEL_MAPPINGS,
  FEATURE_AUTO_TIERS,
} from '../types/inferenceProvider';

/**
 * Resolves a user-facing model config value to a concrete model ID
 * appropriate for the active inference provider.
 *
 * Resolution order:
 * 1. "auto" → look up the feature's default tier in FEATURE_AUTO_TIERS
 * 2. Legacy name (haiku/sonnet/opus) → map to tier via LEGACY_TIER_MAP
 * 3. Tier name (fast/balanced/powerful) → map to provider model via DEFAULT_MODEL_MAPPINGS
 * 4. Anything else → pass through as a literal model ID
 *
 * @param configValue - Value from the per-feature VS Code setting
 * @param providerId - Active inference provider
 * @param featureKey - Setting key (e.g. "inlineModel") for auto-tier lookup
 * @returns Concrete model identifier for the provider's client
 */
export function resolveModel(
  configValue: string,
  providerId: InferenceProviderId,
  featureKey: string,
): string {
  // "auto" -> feature's default tier
  if (configValue === 'auto') {
    configValue = FEATURE_AUTO_TIERS[featureKey] ?? 'balanced';
  }

  // Legacy names -> tier
  if (configValue in LEGACY_TIER_MAP) {
    configValue = LEGACY_TIER_MAP[configValue];
  }

  // Tier -> provider-specific model
  if (configValue === 'fast' || configValue === 'balanced' || configValue === 'powerful') {
    return DEFAULT_MODEL_MAPPINGS[providerId][configValue as ModelTier];
  }

  // Full model ID passthrough
  return configValue;
}
