/**
 * Records over time: build a snapshot at any moment, append live records,
 * and export a session's activity.
 *
 * Pure.
 *
 * @module activity/timeline
 */

import type { SessionProviderId } from '../providerIds';
import type {
  ActivityExport,
  ActivityInsights,
  ActivityRecord,
  ActivitySnapshot,
  ActivityStateOptions,
  ActivityTimeline,
  ActivityTimelineOptions,
} from './types';

/** Applies start corrections, sorts by time (stable) and renumbers `seq`. */
export function normalizeActivityRecords(_records: readonly ActivityRecord[]): ActivityRecord[] {
  throw new Error('activity/timeline: not implemented');
}

export function createActivityTimeline(
  _records?: readonly ActivityRecord[],
  _options?: ActivityTimelineOptions,
): ActivityTimeline {
  throw new Error('activity/timeline: not implemented');
}

/** Snapshot of `records` folded up to `until` (default: all). */
export function buildActivitySnapshot(
  _records: readonly ActivityRecord[],
  _options?: ActivityStateOptions & { until?: number },
): ActivitySnapshot {
  throw new Error('activity/timeline: not implemented');
}

export function exportActivity(_input: {
  snapshot: ActivitySnapshot;
  insights: ActivityInsights;
  records?: readonly ActivityRecord[];
  providerId?: SessionProviderId;
  sessionId?: string;
  at?: number;
}): ActivityExport {
  throw new Error('activity/timeline: not implemented');
}
