/**
 * The activity feed: newest rows first, consecutive finished calls at one
 * station folded into one row.
 *
 * Two entries fold when both finished `ok`, carry no mark, and share the
 * station, the origin and the subagent. Anything else — a running call, an
 * error, a denial, a prompt, a model switch — stands alone, so a fault is
 * never hidden inside a "+N".
 *
 * Pure.
 *
 * @module activity/feed
 */

import type { ActivityEntry, ActivityFeedOptions, ActivityFeedRow } from './types';

/** A model step: an unmarked entry at the Model station (switches and compactions are marked). */
function isStep(entry: ActivityEntry): boolean {
  return entry.station === 'model' && entry.mark === undefined;
}

function isPlain(entry: ActivityEntry): boolean {
  return entry.outcome === 'ok' && entry.mark === undefined && entry.endedAt !== undefined;
}

function took(entry: ActivityEntry): number {
  return entry.endedAt === undefined ? 0 : Math.max(0, entry.endedAt - entry.startedAt);
}

export function foldActivityFeed(
  entries: readonly ActivityEntry[],
  options: ActivityFeedOptions = {},
): ActivityFeedRow[] {
  const max = Math.max(0, Math.floor(options.max ?? 16));
  const hideSteps = options.hideSteps ?? true;
  const rows: ActivityFeedRow[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (hideSteps && isStep(entry)) continue;
    if (options.station !== undefined && entry.station !== options.station) continue;
    const last = rows[rows.length - 1];
    if (
      last !== undefined &&
      isPlain(entry) &&
      isPlain(last.entry) &&
      last.entry.station === entry.station &&
      last.entry.from === entry.from &&
      last.entry.agentId === entry.agentId
    ) {
      last.times++;
      last.tookMs += took(entry);
      continue;
    }
    if (rows.length === max) break;
    rows.push({ entry, times: 1, tookMs: took(entry) });
  }
  return rows;
}
