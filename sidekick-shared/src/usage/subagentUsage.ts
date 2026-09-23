/**
 * Accumulate normalized usage into a subagent's token fields so every
 * provider's `scanSubagents()` reports the same four buckets and the same
 * cache-inclusive total as `summarizeTokens()`.
 *
 * Browser-safe: no Node imports.
 *
 * @module usage/subagentUsage
 */

import type { NormalizedUsage } from '../usageNormalization';
import type { SubagentStats } from '../types/sessionEvent';

/** Add one usage record (a call or a correction) to a subagent's token totals. */
export function addUsageToSubagent(stats: SubagentStats, usage: NormalizedUsage): void {
  stats.inputTokens += usage.uncachedInputTokens;
  stats.outputTokens += usage.outputTokens;
  stats.cacheReadTokens = (stats.cacheReadTokens ?? 0) + usage.cacheReadTokens;
  stats.cacheWriteTokens = (stats.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
  stats.reasoningTokens = (stats.reasoningTokens ?? 0) + usage.reasoningTokens;
  stats.totalTokens = (stats.totalTokens ?? 0) + usage.totalTokens;
}
