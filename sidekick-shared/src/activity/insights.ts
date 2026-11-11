/**
 * Full-session statistics: where the time, the faults and the context went.
 *
 * Pure.
 *
 * @module activity/insights
 */

import type { ActivityInsights, ActivityState } from './types';

export function summarizeActivity(_state: ActivityState): ActivityInsights {
  throw new Error('activity/insights: not implemented');
}
