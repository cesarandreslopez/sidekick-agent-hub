/**
 * Cost text and model labels (typed) for the dashboard.
 *
 * Costs use the shared `formatCost`, so a missing value renders "—" instead
 * of throwing or reading as `$0.0000`. Totals and rows that leave models
 * unpriced say so: "—" when nothing was priced, "(partial)" or an
 * "N models unpriced" note when only part was.
 *
 * @module webview/dashboard/cost
 */

import { formatCost as sharedFormatCost, parseModelId } from 'sidekick-shared/pricing';

/** `$0.0123` / `$1.23`, or `—` for a missing (unpriced) value. */
export function formatCost(cost: number | null | undefined): string {
  return sharedFormatCost(cost);
}

/** `1 model unpriced` / `2 models unpriced`, or '' for none. */
export function unpricedNote(count: number | undefined): string {
  const n = count ?? 0;
  return n > 0 ? `${n} model${n === 1 ? '' : 's'} unpriced` : '';
}

/** A total that may leave models unpriced: "—" when nothing was priced. */
export function totalCostText(cost: number, unpricedCount: number | undefined): string {
  return (unpricedCount ?? 0) > 0 && !(cost > 0) ? '—' : formatCost(cost);
}

/** A model row: "—" when wholly unpriced, "(partial)" when only part of it was priced. */
export function rowCostText(row: { cost: number; priced?: boolean }): string {
  if (row.priced !== false) return formatCost(row.cost);
  return row.cost > 0 ? `${formatCost(row.cost)} (partial)` : '—';
}

/**
 * A billing-block amount: "—" when no call in the block was priced,
 * "(partial)" when some were not. Reported-plus-estimated (`mixed`) blocks
 * are fully priced.
 */
export function blockCostText(
  cost: number,
  block: { costProvenance?: string; unpricedCalls?: number },
): string {
  if (block.costProvenance === 'unpriced') return '—';
  const text = `$${cost.toFixed(2)}`;
  return (block.unpricedCalls ?? 0) > 0 ? `${text} (partial)` : text;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Short model label: `Opus 4.5`, `GPT-6.1 Sol`, `GPT-5.1-codex-max`; anything
 * else (`o3-mini`, unknown ids) is shown as is. Rows arrive keyed by
 * `canonicalModelId` (no dates, `[1m]`, or deployment prefixes), so the id is
 * parsed directly.
 */
export function modelLabel(modelId: string): string {
  const parsed = parseModelId(modelId);
  if (parsed?.provider === 'anthropic') return `${capitalize(parsed.family)} ${parsed.version}`;
  if (parsed?.family === 'gpt') {
    const version = parsed.variant
      ? parsed.version.replace(`-${parsed.variant}`, ` ${capitalize(parsed.variant)}`)
      : parsed.version;
    return `GPT-${version}`;
  }
  return modelId;
}
