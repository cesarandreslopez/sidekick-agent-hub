import { describe, expect, it } from 'vitest';
import {
  aggregateCostDisplay,
  blockCostCells,
  costSourceFromAggregate,
  eventsCostDisplay,
  formatAggregateCost,
  formatCostDisplay,
} from './costDisplay';

describe('costSourceFromAggregate', () => {
  it('reads mixed as estimated and none as unknown', () => {
    expect(costSourceFromAggregate('reported')).toBe('reported');
    expect(costSourceFromAggregate('estimated')).toBe('estimated');
    expect(costSourceFromAggregate('mixed')).toBe('estimated');
    expect(costSourceFromAggregate('unpriced')).toBe('unpriced');
    expect(costSourceFromAggregate('none')).toBeUndefined();
    expect(costSourceFromAggregate(undefined)).toBeUndefined();
  });
});

describe('formatAggregateCost', () => {
  it('never prints $0 for an unpriced aggregate', () => {
    expect(formatAggregateCost({ costUsd: 0, costProvenance: 'unpriced', unpricedCalls: 3 })).toBe(
      '—',
    );
    expect(
      formatAggregateCost({ costUsd: 0, pricedCostUsd: null, costProvenance: 'unpriced' }),
    ).toBe('—');
  });

  it('marks estimates and partially priced figures', () => {
    expect(formatAggregateCost({ costUsd: 1.5, costProvenance: 'reported' })).toBe('$1.50');
    expect(formatAggregateCost({ costUsd: 1.5, costProvenance: 'estimated' })).toBe('$1.50 (est.)');
    expect(formatAggregateCost({ costUsd: 1.5, costProvenance: 'mixed' })).toBe('$1.50 (est.)');
    expect(
      formatAggregateCost({ costUsd: 1.5, costProvenance: 'reported', unpricedCalls: 2 }),
    ).toBe('$1.50 (partial)');
    expect(
      formatAggregateCost({ costUsd: 1.5, costProvenance: 'estimated', unpricedCalls: 2 }),
    ).toBe('$1.50 (est., partial)');
  });

  it('prefers the priced sum when the row carries one', () => {
    expect(
      aggregateCostDisplay({ costUsd: 9, pricedCostUsd: 0.004, costProvenance: 'estimated' }),
    ).toEqual({ cost: 0.004, source: 'estimated', partial: false });
    expect(formatAggregateCost({ costUsd: 0, costProvenance: 'none' })).toBe('$0.0000');
  });
});

describe('blockCostCells', () => {
  const block = {
    costUsd: 0.5,
    costProvenance: 'estimated' as const,
    unpricedCalls: 0,
    isActive: true,
    projectedCostUsd: 1.25,
  };

  it('projects with the block markers, and projects nothing when unpriced or closed', () => {
    expect(blockCostCells(block)).toEqual({ cost: '$0.50 (est.)', projected: '$1.25 (est.)' });
    expect(blockCostCells({ ...block, unpricedCalls: 1 })).toEqual({
      cost: '$0.50 (est., partial)',
      projected: '$1.25 (est., partial)',
    });
    expect(blockCostCells({ ...block, costUsd: 0, costProvenance: 'unpriced' })).toEqual({
      cost: '—',
      projected: '—',
    });
    expect(blockCostCells({ ...block, isActive: false }).projected).toBe('—');
  });
});

describe('eventsCostDisplay', () => {
  const event = (costUsd: number | null, costProvenance: string, totalTokens = 100) =>
    ({ costUsd, costProvenance, tokens: { totalTokens } }) as never;

  it('sums priced calls and flags unpriced calls that carried tokens', () => {
    expect(
      eventsCostDisplay([event(0.25, 'model-catalog'), event(0.5, 'provider-reported')]),
    ).toEqual({ cost: 0.75, source: 'estimated', partial: false });
    expect(eventsCostDisplay([event(0.25, 'provider-reported'), event(null, 'unpriced')])).toEqual({
      cost: 0.25,
      source: 'reported',
      partial: true,
    });
    // A zero-token unpriced call carried nothing to price.
    expect(
      eventsCostDisplay([event(0.25, 'model-catalog'), event(null, 'unpriced', 0)]).partial,
    ).toBe(false);
    expect(formatCostDisplay(eventsCostDisplay([event(null, 'unpriced')]))).toBe('—');
    expect(formatCostDisplay(eventsCostDisplay([]))).toBe('—');
  });
});
