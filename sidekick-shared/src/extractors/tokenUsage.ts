/**
 * Pure extraction of normalized TokenUsage from a SessionEvent.
 *
 * Provides a standalone function to extract camelCase TokenUsage from
 * a raw session event without requiring an EventAggregator instance.
 *
 * @module extractors/tokenUsage
 */

import type { SessionEvent, TokenUsage } from '../types/sessionEvent';

/**
 * Extracts normalized TokenUsage from a SessionEvent.
 *
 * Looks for `message.usage` on assistant events and normalizes
 * the snake_case API fields to the camelCase TokenUsage shape.
 *
 * @param event - A parsed session event
 * @returns TokenUsage if the event contains usage data, null otherwise
 *
 * @example
 * ```typescript
 * const usage = extractTokenUsage(event);
 * if (usage) {
 *   console.log(`Input: ${usage.inputTokens}, Output: ${usage.outputTokens}`);
 * }
 * ```
 */
export function extractTokenUsage(event: SessionEvent): TokenUsage | null {
  const usage = event.message?.usage;
  if (!usage) return null;

  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    model: event.message.model ?? 'unknown',
    timestamp: new Date(event.timestamp),
    reportedCost: usage.reported_cost,
    reasoningTokens: usage.reasoning_tokens,
  };
}
