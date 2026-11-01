/**
 * @fileoverview `sidekick.customModelPricing`: user-supplied model prices.
 *
 * Entries are validated and registered with sidekick-shared's
 * `registerModelPricing` layer, which survives catalog hydration. Applying
 * replaces the previous registration, so a settings change takes effect in
 * place. By default entries win over every other source (as in the CLI's
 * `cli-config.json` pricing); with `sidekick.customModelPricingOnlyIfMissing`
 * an entry only fills gaps — models the built-in table and the LiteLLM
 * catalog cannot price exactly.
 *
 * @module services/customModelPricing
 */

import {
  clearRegisteredModelPricing,
  registerModelPricing,
  type ModelPricing,
} from 'sidekick-shared';

export interface CustomModelPricingStatus {
  /** Model ids registered from the setting. */
  applied: string[];
  /** Keys skipped because their value was not a valid price. */
  invalid: string[];
  onlyIfMissing: boolean;
}

export interface ParsedCustomModelPricing {
  entries: Record<string, ModelPricing>;
  invalid: string[];
}

let lastStatus: CustomModelPricingStatus | undefined;

function rate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Validate the setting's value: an object of model id → `{ inputCostPerMillion,
 * outputCostPerMillion, cacheWriteCostPerMillion?, cacheReadCostPerMillion? }`
 * (USD per million tokens, finite and nonnegative). Omitted cache rates
 * default to the input rate. Anything else is listed in `invalid`.
 */
export function parseCustomModelPricing(raw: unknown): ParsedCustomModelPricing {
  const entries: Record<string, ModelPricing> = {};
  const invalid: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { entries, invalid };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim();
    const price = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    const input = rate(price?.inputCostPerMillion);
    const output = rate(price?.outputCostPerMillion);
    const cacheWrite =
      price?.cacheWriteCostPerMillion === undefined ? input : rate(price.cacheWriteCostPerMillion);
    const cacheRead =
      price?.cacheReadCostPerMillion === undefined ? input : rate(price.cacheReadCostPerMillion);
    if (
      !id ||
      input === undefined ||
      output === undefined ||
      cacheWrite === undefined ||
      cacheRead === undefined
    ) {
      invalid.push(key);
      continue;
    }
    entries[id] = {
      inputCostPerMillion: input,
      outputCostPerMillion: output,
      cacheWriteCostPerMillion: cacheWrite,
      cacheReadCostPerMillion: cacheRead,
    };
  }
  return { entries, invalid };
}

/** Replace the registered custom prices with the setting's current value. */
export function applyCustomModelPricing(
  raw: unknown,
  onlyIfMissing: boolean,
): CustomModelPricingStatus {
  const { entries, invalid } = parseCustomModelPricing(raw);
  clearRegisteredModelPricing();
  const applied = Object.keys(entries);
  if (applied.length > 0) registerModelPricing(entries, { onlyIfMissing });
  lastStatus = { applied, invalid, onlyIfMissing };
  return lastStatus;
}

/** The last `applyCustomModelPricing` result, for the Health tab and doctor. */
export function getCustomModelPricingStatus(): CustomModelPricingStatus | undefined {
  return lastStatus;
}
