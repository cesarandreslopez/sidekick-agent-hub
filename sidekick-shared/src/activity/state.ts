/**
 * The activity reducer: one state, folded record by record, for live
 * updates, replay and scrubbing alike.
 *
 * Pure and deterministic.
 *
 * @module activity/state
 */

import type { SessionProviderId } from '../providerIds';
import type {
  ActivityRecord,
  ActivitySnapshot,
  ActivityState,
  ActivityStateOptions,
} from './types';

export function createActivityState(
  _meta?: { providerId?: SessionProviderId; sessionId?: string },
  _options?: ActivityStateOptions,
): ActivityState {
  throw new Error('activity/state: not implemented');
}

/** Folds one record into `state` (mutates it). */
export function applyActivityRecord(_state: ActivityState, _record: ActivityRecord): void {
  throw new Error('activity/state: not implemented');
}

export function applyActivityRecords(
  _state: ActivityState,
  _records: readonly ActivityRecord[],
): void {
  throw new Error('activity/state: not implemented');
}

export function cloneActivityState(_state: ActivityState): ActivityState {
  throw new Error('activity/state: not implemented');
}

/** Restores a state persisted with `JSON.stringify`; null when unusable. */
export function restoreActivityState(_value: unknown): ActivityState | null {
  throw new Error('activity/state: not implemented');
}

export function snapshotActivity(_state: ActivityState): ActivitySnapshot {
  throw new Error('activity/state: not implemented');
}
