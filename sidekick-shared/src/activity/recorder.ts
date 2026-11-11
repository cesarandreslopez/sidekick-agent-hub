/**
 * Turns canonical session events into activity records.
 *
 * Pure: no clock, no filesystem.
 *
 * @module activity/recorder
 */

import type { ActivityRecorder, ActivityRecorderOptions } from './types';

export function createActivityRecorder(_options: ActivityRecorderOptions): ActivityRecorder {
  throw new Error('activity/recorder: not implemented');
}
