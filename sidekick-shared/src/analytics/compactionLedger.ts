import type { CompactionEvent } from '../types/sessionEvent';
import { calculateNormalizedUsageCost, normalizeProviderUsage } from '../usageNormalization';

export interface CompactionLedger {
  count: number;
  tokensEvicted: number;
  reestablishmentCostUsd: number | null;
  source: 'reported' | 'heuristic' | 'mixed';
  reportedCount: number;
  heuristicCount: number;
}

export function calculateCompactionLedger(
  events: CompactionEvent[],
  model?: string | null,
): CompactionLedger {
  const tokensEvicted = events.reduce((sum, event) => sum + Math.max(0, event.tokensReclaimed), 0);
  const reportedCount = events.filter((event) => event.source === 'reported').length;
  const heuristicCount = events.length - reportedCount;
  // Re-establishing evicted context means sending it again as uncached input.
  // Price it through the same normalized path every other cost figure uses so
  // the ledger can never disagree with the session total on the same tokens.
  const reestablishment = model
    ? calculateNormalizedUsageCost({
        usage: normalizeProviderUsage({
          semantics: 'sidekick',
          inputTokens: tokensEvicted,
          reasoningIncludedInOutput: true,
        }),
        modelId: model,
      })
    : null;
  return {
    count: events.length,
    tokensEvicted,
    reestablishmentCostUsd: reestablishment?.costUsd ?? null,
    source:
      reportedCount > 0 && heuristicCount > 0
        ? 'mixed'
        : reportedCount > 0
          ? 'reported'
          : 'heuristic',
    reportedCount,
    heuristicCount,
  };
}

export function formatCompactionLedger(ledger: CompactionLedger): string {
  const cost =
    ledger.reestablishmentCostUsd == null
      ? 'cost unavailable'
      : `~$${ledger.reestablishmentCostUsd.toFixed(2)} re-establishing context`;
  return `${ledger.count} compaction${ledger.count === 1 ? '' : 's'} · ${ledger.tokensEvicted.toLocaleString()} tokens evicted · ${cost} · ${ledger.source}`;
}
