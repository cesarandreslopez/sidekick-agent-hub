/**
 * Cheap content signature for `StaticData`.
 *
 * The dashboard re-reads persisted project data on a timer. Handing React a
 * fresh object every tick would invalidate every memo and force a full
 * recompute of the detail pane — including the mind map — several times a
 * minute for data that rarely changes.
 *
 * Comparing fingerprints lets the poll keep the previous object identity when
 * nothing moved, so a quiet project costs a few JSON reads and no render at
 * all. Collection sizes catch adds and removes; the newest timestamp in each
 * collection catches edits.
 */

import type { StaticData } from './StaticDataLoader';

/** Newest value across the given fields, or '' when the list is empty. */
function newest(items: readonly Record<string, unknown>[], ...fields: string[]): string {
  let max = '';
  for (const item of items) {
    for (const field of fields) {
      const value = item[field];
      if (typeof value === 'string' && value > max) max = value;
    }
  }
  return max;
}

/**
 * Signature that changes whenever anything the dashboard renders has changed.
 *
 * ISO-8601 timestamps compare correctly as strings, so no parsing is needed.
 */
export function staticDataFingerprint(data: StaticData): string {
  return [
    data.tasks.length,
    newest(data.tasks as unknown as Record<string, unknown>[], 'updatedAt', 'createdAt'),
    data.notes.length,
    newest(data.notes as unknown as Record<string, unknown>[], 'updatedAt', 'createdAt'),
    data.decisions.length,
    newest(data.decisions as unknown as Record<string, unknown>[], 'timestamp'),
    data.plans.length,
    newest(data.plans as unknown as Record<string, unknown>[], 'completedAt', 'createdAt'),
    data.sessions.length,
    data.totalTokens,
    data.totalCost,
    data.totalSessions,
  ].join('|');
}
