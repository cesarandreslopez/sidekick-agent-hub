/**
 * @fileoverview Model pricing service for calculating Claude API costs.
 *
 * Thin wrapper around sidekick-shared/modelInfo for backward compatibility.
 * New code should import directly from sidekick-shared.
 *
 * @module services/ModelPricingService
 */

import {
  parseModelId,
  getModelPricing,
  calculateCostWithPricing,
  formatCost as sharedFormatCost,
} from 'sidekick-shared/dist/modelInfo';
import type { ModelPricing as SharedModelPricing, CostTokenUsage } from 'sidekick-shared/dist/modelInfo';

/**
 * Pricing information for a Claude model.
 * All costs are per million tokens in USD.
 */
export type ModelPricing = SharedModelPricing;

/**
 * Token usage for cost calculation.
 */
export type TokenUsage = CostTokenUsage;

/**
 * Service for model pricing lookup and cost calculation.
 *
 * Delegates to sidekick-shared/modelInfo. Existing callers can continue
 * using ModelPricingService.getPricing() etc. without changes.
 */
export class ModelPricingService {
  static parseModelId(modelId: string): { family: string; version: string } | null {
    return parseModelId(modelId);
  }

  static getPricing(modelId: string): ModelPricing {
    // Shared module returns null for non-Claude; preserve original behavior (sonnet-4.5 fallback)
    return getModelPricing(modelId) ?? getModelPricing('claude-sonnet-4.5')!;
  }

  static calculateCost(usage: TokenUsage, pricing: ModelPricing): number {
    return calculateCostWithPricing(usage, pricing);
  }

  static formatCost(cost: number): string {
    return sharedFormatCost(cost);
  }
}
