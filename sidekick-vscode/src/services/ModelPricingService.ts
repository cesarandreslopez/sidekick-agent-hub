/**
 * @fileoverview Model pricing service for calculating Claude API costs.
 *
 * This service maps Claude model IDs to per-token pricing and calculates
 * session costs based on token usage. Pricing includes cache multipliers:
 * - Cache write: 1.25x input cost (5-minute cache TTL)
 * - Cache read: 0.1x input cost
 *
 * Pricing source: Anthropic API docs (2026-01-29)
 * https://platform.claude.com/docs/en/about-claude/pricing
 *
 * IMPORTANT: Update PRICING_TABLE when new models are released.
 *
 * @module services/ModelPricingService
 */

/**
 * Pricing information for a Claude model.
 * All costs are per million tokens in USD.
 */
export interface ModelPricing {
  /** Cost per million input tokens */
  inputCostPerMillion: number;
  /** Cost per million output tokens */
  outputCostPerMillion: number;
  /** Cost per million cache write tokens (1.25x input) */
  cacheWriteCostPerMillion: number;
  /** Cost per million cache read tokens (0.1x input) */
  cacheReadCostPerMillion: number;
}

/**
 * Token usage for cost calculation.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/**
 * Service for model pricing lookup and cost calculation.
 *
 * Handles model family detection (haiku/sonnet/opus), version parsing,
 * and graceful fallbacks for unknown models.
 *
 * @example
 * ```typescript
 * const pricing = ModelPricingService.getPricing('claude-opus-4-20250514');
 * const cost = ModelPricingService.calculateCost(
 *   { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0 },
 *   pricing
 * );
 * console.log(ModelPricingService.formatCost(cost)); // "$0.01"
 * ```
 */
export class ModelPricingService {
  /**
   * Pricing table for Claude models.
   * Key format: "{family}-{version}" (e.g., "haiku-4.5", "sonnet-4")
   *
   * Source: Anthropic API pricing (2026-01-29)
   */
  private static readonly PRICING_TABLE: Record<string, ModelPricing> = {
    'haiku-4.5': {
      inputCostPerMillion: 1.0,
      outputCostPerMillion: 5.0,
      cacheWriteCostPerMillion: 1.25,
      cacheReadCostPerMillion: 0.1,
    },
    'haiku-3.5': {
      inputCostPerMillion: 0.8,
      outputCostPerMillion: 4.0,
      cacheWriteCostPerMillion: 1.0,
      cacheReadCostPerMillion: 0.08,
    },
    'sonnet-4.5': {
      inputCostPerMillion: 3.0,
      outputCostPerMillion: 15.0,
      cacheWriteCostPerMillion: 3.75,
      cacheReadCostPerMillion: 0.3,
    },
    'sonnet-4': {
      inputCostPerMillion: 3.0,
      outputCostPerMillion: 15.0,
      cacheWriteCostPerMillion: 3.75,
      cacheReadCostPerMillion: 0.3,
    },
    'opus-4.5': {
      inputCostPerMillion: 5.0,
      outputCostPerMillion: 25.0,
      cacheWriteCostPerMillion: 6.25,
      cacheReadCostPerMillion: 0.5,
    },
    'opus-4': {
      inputCostPerMillion: 15.0,
      outputCostPerMillion: 75.0,
      cacheWriteCostPerMillion: 18.75,
      cacheReadCostPerMillion: 1.5,
    },
  };

  /**
   * Parses a Claude model ID to extract family and version.
   *
   * @param modelId - Model ID like "claude-opus-4-20250514" or "claude-sonnet-4.5-20241022"
   * @returns Object with family and version, or null if unparseable
   *
   * @example
   * ```typescript
   * parseModelId('claude-opus-4-20250514')
   * // => { family: 'opus', version: '4' }
   *
   * parseModelId('claude-sonnet-4.5-20241022')
   * // => { family: 'sonnet', version: '4.5' }
   *
   * parseModelId('gpt-4')
   * // => null
   * ```
   */
  static parseModelId(modelId: string): { family: string; version: string } | null {
    const match = modelId.match(/claude-(haiku|sonnet|opus)-([0-9.]+)/i);
    if (!match) {
      return null;
    }

    const [, family, version] = match;
    return {
      family: family.toLowerCase(),
      version,
    };
  }

  /**
   * Gets pricing for a Claude model.
   *
   * Fallback strategy:
   * 1. Exact match on family-version
   * 2. Latest version in same family
   * 3. Sonnet 4.5 pricing (safe middle-ground)
   *
   * Logs a warning when using fallback pricing.
   *
   * @param modelId - Model ID like "claude-opus-4-20250514"
   * @returns Pricing information for the model
   *
   * @example
   * ```typescript
   * getPricing('claude-haiku-4.5-20251215')
   * // => { inputCostPerMillion: 1.0, ... }
   *
   * getPricing('claude-opus-5-20270101') // Unknown model
   * // => { inputCostPerMillion: 5.0, ... } (falls back to opus-4.5)
   * ```
   */
  static getPricing(modelId: string): ModelPricing {
    const parsed = this.parseModelId(modelId);

    if (!parsed) {
      // Non-Claude models (GPT, Gemini, etc.) are expected in OpenCode sessions.
      // Callers should check parseModelId() first and only call getPricing()
      // for known Claude models.
      return this.PRICING_TABLE['sonnet-4.5'];
    }

    const { family, version } = parsed;
    const key = `${family}-${version}`;

    // Exact match
    if (this.PRICING_TABLE[key]) {
      return this.PRICING_TABLE[key];
    }

    // Fallback to latest version in family
    const familyKeys = Object.keys(this.PRICING_TABLE)
      .filter((k) => k.startsWith(family))
      .sort()
      .reverse();

    if (familyKeys.length > 0) {
      console.warn(
        `[ModelPricingService] Unknown version "${version}" for ${family}, using ${familyKeys[0]} pricing`
      );
      return this.PRICING_TABLE[familyKeys[0]];
    }

    // Ultimate fallback
    console.warn(
      `[ModelPricingService] Unknown family "${family}", using sonnet-4.5 pricing`
    );
    return this.PRICING_TABLE['sonnet-4.5'];
  }

  /**
   * Calculates the total cost of a completion based on token usage.
   *
   * Cost components:
   * - Input tokens: Base input cost
   * - Output tokens: Base output cost
   * - Cache write tokens: 1.25x input cost
   * - Cache read tokens: 0.1x input cost
   *
   * @param usage - Token usage breakdown
   * @param pricing - Pricing information for the model
   * @returns Total cost in USD
   *
   * @example
   * ```typescript
   * const pricing = getPricing('claude-haiku-4.5-20251215');
   * const cost = calculateCost(
   *   { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0 },
   *   pricing
   * );
   * // => 0.0035 ($0.001 input + $0.0025 output)
   * ```
   */
  static calculateCost(usage: TokenUsage, pricing: ModelPricing): number {
    const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion;
    const cacheWriteCost =
      (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWriteCostPerMillion;
    const cacheReadCost =
      (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadCostPerMillion;

    return inputCost + outputCost + cacheWriteCost + cacheReadCost;
  }

  /**
   * Formats a cost as a USD currency string.
   *
   * Precision rules:
   * - < $0.01: 4 decimal places for visibility
   * - >= $0.01: 2 decimal places (standard currency)
   *
   * @param cost - Cost in USD
   * @returns Formatted currency string
   *
   * @example
   * ```typescript
   * formatCost(0.001234) // => "$0.0012"
   * formatCost(0.15)     // => "$0.15"
   * formatCost(1.234)    // => "$1.23"
   * formatCost(0)        // => "$0.00"
   * ```
   */
  static formatCost(cost: number): string {
    if (cost < 0.01) {
      // Show more precision for very small costs
      return `$${cost.toFixed(4)}`;
    }
    // Standard currency formatting
    return `$${cost.toFixed(2)}`;
  }
}
