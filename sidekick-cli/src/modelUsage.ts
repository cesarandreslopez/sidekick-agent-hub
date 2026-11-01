/**
 * Per-model usage rows merged by `canonicalModelId`, so one model logged under
 * several spellings (a dated snapshot id, a region or provider prefix, a
 * Bedrock form) reads as one row in `stats` and the dashboard, as it does in
 * the usage reports.
 */

import { canonicalModelId } from 'sidekick-shared';

export interface MergeableModelUsage {
  model: string;
  calls: number;
  tokens: number;
  cost: number;
  /** `false` when no price was known for the model; undefined means priced. */
  priced?: boolean;
}

export interface MergedModelUsage {
  /** The canonical id. */
  model: string;
  calls: number;
  tokens: number;
  /** Sum of the priced spellings' costs. */
  cost: number;
  /** `false` only when no merged spelling was priced. */
  priced?: boolean;
  /** Some merged spellings were priced and some were not: `cost` is partial. */
  partiallyPriced?: boolean;
}

/** Merge rows by canonical model id, keeping first-seen order. */
export function mergeModelUsage(rows: readonly MergeableModelUsage[]): MergedModelUsage[] {
  const merged = new Map<
    string,
    { model: string; calls: number; tokens: number; cost: number; priced: number; rows: number }
  >();
  for (const row of rows) {
    const key = canonicalModelId(row.model) || row.model;
    const entry = merged.get(key) ?? {
      model: key,
      calls: 0,
      tokens: 0,
      cost: 0,
      priced: 0,
      rows: 0,
    };
    entry.calls += row.calls;
    entry.tokens += row.tokens ?? 0;
    entry.cost += row.cost;
    entry.rows += 1;
    if (row.priced !== false) entry.priced += 1;
    merged.set(key, entry);
  }
  return [...merged.values()].map(({ priced, rows: count, ...usage }) => ({
    ...usage,
    ...(priced === 0 ? { priced: false } : {}),
    ...(priced > 0 && priced < count ? { partiallyPriced: true } : {}),
  }));
}
