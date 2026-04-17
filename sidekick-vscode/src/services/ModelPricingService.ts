/**
 * @fileoverview Model pricing service — thin wrapper around sidekick-shared.
 *
 * Kept for backward compatibility with existing call sites. New code should
 * import directly from `sidekick-shared`. Signatures now return `null` for
 * unknown models so callers render "—" instead of a wrong dollar figure.
 *
 * @module services/ModelPricingService
 */

import {
  parseModelId,
  getModelPricing,
  calculateCostWithPricing,
  formatCost as sharedFormatCost,
  type ModelPricing as SharedModelPricing,
  type CostTokenUsage,
  type ParsedModelId,
} from 'sidekick-shared';

/** Pricing information for a model. All costs are per million tokens in USD. */
export type ModelPricing = SharedModelPricing;

/** Token usage for cost calculation. */
export type TokenUsage = CostTokenUsage;

/**
 * Service for model pricing lookup and cost calculation.
 *
 * Delegates to sidekick-shared/modelInfo. Unknown models return null — callers
 * must check and render "—" rather than silently invent a price.
 */
export class ModelPricingService {
  static parseModelId(modelId: string): ParsedModelId | null {
    return parseModelId(modelId);
  }

  /**
   * Returns pricing for a model, or null if unknown. Callers must handle null.
   */
  static getPricing(modelId: string): ModelPricing | null {
    return getModelPricing(modelId);
  }

  /**
   * Calculates cost given token usage and pricing.
   * If `pricing` is null, returns null (caller should render "—").
   */
  static calculateCost(usage: TokenUsage, pricing: ModelPricing | null): number | null {
    if (!pricing) return null;
    return calculateCostWithPricing(usage, pricing);
  }

  /** Formats cost as `$X.YZ`, or `—` for null/undefined. */
  static formatCost(cost: number | null | undefined): string {
    return sharedFormatCost(cost);
  }
}
