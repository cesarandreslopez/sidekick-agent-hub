import type { AggregatedCostProvenance, AggregatedTokens } from './types';

/** The fields `describeCostProvenance` reads; any `AggregatedTokens` qualifies. */
export type AggregatedCostProvenanceInput = Pick<
  AggregatedTokens,
  'costProvenance' | 'unpricedCalls'
>;

const PROVENANCE_LABELS: Record<AggregatedCostProvenance, string> = {
  reported: 'provider-reported',
  estimated: 'estimated from catalog pricing',
  mixed: 'partly provider-reported, partly estimated',
  unpriced: 'unpriced',
  none: '',
};

/**
 * Human-readable qualifier for an aggregate cost, for report footers and
 * table cells. Empty when there is nothing to qualify.
 */
export function describeCostProvenance(tokens: AggregatedCostProvenanceInput): string {
  const base = PROVENANCE_LABELS[tokens.costProvenance] ?? '';
  const unpriced =
    tokens.unpricedCalls > 0
      ? `${tokens.unpricedCalls} unpriced call${tokens.unpricedCalls === 1 ? '' : 's'}`
      : '';
  if (base && unpriced) return `${base} · ${unpriced}`;
  return base || unpriced;
}

/** Classify a cost breakdown by how many events fell into each bucket. */
export function classifyCostProvenance(counts: {
  reportedCalls: number;
  estimatedCalls: number;
  unpricedCalls: number;
}): AggregatedCostProvenance {
  const { reportedCalls, estimatedCalls, unpricedCalls } = counts;
  if (reportedCalls > 0 && estimatedCalls > 0) return 'mixed';
  if (reportedCalls > 0) return 'reported';
  if (estimatedCalls > 0) return 'estimated';
  return unpricedCalls > 0 ? 'unpriced' : 'none';
}
