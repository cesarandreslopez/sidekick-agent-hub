/**
 * The activity feed: newest rows first, consecutive finished calls at one
 * station folded into one row.
 *
 * Pure.
 *
 * @module activity/feed
 */

import type { ActivityEntry, ActivityFeedOptions, ActivityFeedRow } from './types';

export function foldActivityFeed(
  _entries: readonly ActivityEntry[],
  _options?: ActivityFeedOptions,
): ActivityFeedRow[] {
  throw new Error('activity/feed: not implemented');
}
