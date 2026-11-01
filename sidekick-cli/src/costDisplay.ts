/**
 * One rule for every aggregate cost the CLI prints, so a table cell, a
 * dashboard line, and a prompt dump never disagree about what a figure means:
 *
 * - nothing priced                → `—` (never `$0`, which reads as "free")
 * - any part estimated from catalog pricing (alone or beside provider-reported
 *   figures)                      → `$1.23 (est.)`
 * - some calls could not be priced → `$1.23 (partial)`: the figure covers the
 *   priced calls only, so the real cost is higher
 * - both                          → `$1.23 (est., partial)`
 *
 * Provider-reported, fully priced figures print bare, as `formatCost` does.
 */

import { costSourceFromPricingProvenance, formatCost, mergeCostComponents } from 'sidekick-shared';
import type {
  AggregatedCostProvenance,
  BillingBlock,
  CostSource,
  UsageEventRecord,
} from 'sidekick-shared';

export interface CostDisplay {
  /** Sum of the priced part; null when nothing was priced. */
  cost: number | null;
  /** Provenance of the priced part. */
  source?: CostSource;
  /** True when some calls contributed tokens but no price. */
  partial: boolean;
}

/**
 * The display source of an aggregate. `mixed` (some reported, some estimated)
 * reads as estimated: the least certain part decides, as `mergeCostSources`.
 */
export function costSourceFromAggregate(
  provenance: AggregatedCostProvenance | undefined,
): CostSource | undefined {
  switch (provenance) {
    case 'reported':
      return 'reported';
    case 'estimated':
    case 'mixed':
      return 'estimated';
    case 'unpriced':
      return 'unpriced';
    default:
      return undefined;
  }
}

export function formatCostDisplay(display: CostDisplay): string {
  if (display.cost === null || display.source === 'unpriced') return '—';
  if (!display.partial) return formatCost(display.cost, { source: display.source });
  const marks = display.source === 'estimated' ? 'est., partial' : 'partial';
  return `${formatCost(display.cost)} (${marks})`;
}

export interface AggregateCostInput {
  costUsd: number;
  /** Sum of priced calls, null when none was priced (usage rows since 0.29). */
  pricedCostUsd?: number | null;
  costProvenance?: AggregatedCostProvenance;
  unpricedCalls?: number;
}

/** Display model for a usage row, totals, block, or session aggregate. */
export function aggregateCostDisplay(input: AggregateCostInput): CostDisplay {
  const source = costSourceFromAggregate(input.costProvenance);
  const cost =
    source === 'unpriced'
      ? null
      : input.pricedCostUsd !== undefined
        ? input.pricedCostUsd
        : input.costUsd;
  return { cost, source, partial: cost !== null && (input.unpricedCalls ?? 0) > 0 };
}

export function formatAggregateCost(input: AggregateCostInput): string {
  return formatCostDisplay(aggregateCostDisplay(input));
}

/**
 * A billing block's cost and end-of-block projection. The projection carries
 * the block's markers; a block with nothing priced has nothing to project, and
 * a closed block projects nothing.
 */
export function blockCostCells(
  block: Pick<
    BillingBlock,
    'costUsd' | 'costProvenance' | 'unpricedCalls' | 'isActive' | 'projectedCostUsd'
  >,
): { cost: string; projected: string } {
  const display = aggregateCostDisplay(block);
  return {
    cost: formatCostDisplay(display),
    projected:
      block.isActive && display.cost !== null
        ? formatCostDisplay({ ...display, cost: block.projectedCostUsd })
        : '—',
  };
}

/**
 * Display model for a set of usage events (for example the calls that
 * answered one prompt). Zero-token unpriced calls do not make a sum partial:
 * they carried nothing to price.
 */
export function eventsCostDisplay(
  events: ReadonlyArray<Pick<UsageEventRecord, 'costUsd' | 'costProvenance' | 'tokens'>>,
): CostDisplay {
  let cost: number | null = null;
  let partial = false;
  const components: Array<{ source: CostSource; tokens: number }> = [];
  for (const event of events) {
    if (event.costUsd === null) {
      if (event.tokens.totalTokens > 0) partial = true;
      continue;
    }
    cost = (cost ?? 0) + event.costUsd;
    components.push({
      source: costSourceFromPricingProvenance(event.costProvenance),
      tokens: event.tokens.totalTokens,
    });
  }
  return { cost, source: cost === null ? 'unpriced' : mergeCostComponents(components), partial };
}
