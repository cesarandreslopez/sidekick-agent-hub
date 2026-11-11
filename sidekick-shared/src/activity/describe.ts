/**
 * Plain-text descriptions of the map, for accessibility, terminals and MCP.
 *
 * Pure.
 *
 * @module activity/describe
 */

import type { ActivityStrings } from './strings';
import type {
  ActivityInsights,
  ActivityPattern,
  ActivitySnapshot,
  DescribeActivityInsightsOptions,
  DescribeActivityOptions,
} from './types';

/** One line: what is running now, and how full the context is. */
export function describeActivityNow(
  _snapshot: ActivitySnapshot,
  _options?: DescribeActivityOptions,
): string {
  throw new Error('activity/describe: not implemented');
}

/** A few lines: where the session's time, faults and context went, and any patterns. */
export function describeActivityInsights(
  _insights: ActivityInsights,
  _options?: DescribeActivityInsightsOptions,
): string {
  throw new Error('activity/describe: not implemented');
}

export function describeActivityPattern(
  _pattern: ActivityPattern,
  _strings?: Partial<ActivityStrings>,
): string {
  throw new Error('activity/describe: not implemented');
}
