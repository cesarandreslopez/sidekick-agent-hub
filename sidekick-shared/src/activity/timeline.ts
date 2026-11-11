/**
 * Records over time: build a snapshot at any moment, append live records,
 * and export a session's activity.
 *
 * A timeline keeps the records, a key array (`key[i] = max(key[i-1],
 * records[i].at)`, so slightly out-of-order live records still search
 * correctly), and a state checkpoint every `checkpointEvery` records. The
 * state at a moment is the nearest checkpoint before it, cloned, plus at
 * most `checkpointEvery` records: scrubbing costs the same anywhere in a
 * long session.
 *
 * Pure.
 *
 * @module activity/timeline
 */

import type { SessionProviderId } from '../providerIds';
import {
  applyActivityRecord,
  cloneActivityState,
  createActivityState,
  snapshotActivity,
} from './state';
import type { ActivityStationId } from './stations';
import type {
  ActivityExport,
  ActivityInsights,
  ActivityMarker,
  ActivityRecord,
  ActivitySnapshot,
  ActivityState,
  ActivityStateOptions,
  ActivityTimeline,
  ActivityTimelineOptions,
} from './types';

const DEFAULT_CHECKPOINT_EVERY = 256;

/** Applies start corrections, sorts by time (stable) and renumbers `seq`. */
export function normalizeActivityRecords(records: readonly ActivityRecord[]): ActivityRecord[] {
  // A toolEnd that knows its call's real start (OpenCode) moves the start back.
  const corrected = new Map<string, number>();
  for (const record of records) {
    if (record.kind === 'toolEnd' && typeof record.startedAt === 'number') {
      corrected.set(`${record.agentId ?? ''}\u0000${record.id}`, record.startedAt);
    }
  }
  const indexed = records.map((record, index) => {
    if (record.kind === 'toolStart') {
      const start = corrected.get(`${record.agentId ?? ''}\u0000${record.id}`);
      if (start !== undefined && start < record.at)
        return { record: { ...record, at: start }, index };
    }
    return { record, index };
  });
  indexed.sort((a, b) => a.record.at - b.record.at || a.index - b.index);
  return indexed.map(({ record }, seq) => ({ ...record, seq }) as ActivityRecord);
}

/** Snapshot of `records` folded up to `until` (default: all). */
export function buildActivitySnapshot(
  records: readonly ActivityRecord[],
  options?: ActivityStateOptions & { until?: number },
): ActivitySnapshot {
  const state = createActivityState(undefined, options);
  const until = options?.until;
  for (const record of records) {
    if (until !== undefined && record.at > until) break;
    applyActivityRecord(state, record);
  }
  return snapshotActivity(state);
}

class Timeline implements ActivityTimeline {
  private list: ActivityRecord[] = [];
  private keys: number[] = [];
  private checkpoints: ActivityState[] = [];
  private current: ActivityState;
  private readonly every: number;
  private readonly maxRecords: number;

  constructor(
    records: readonly ActivityRecord[],
    private readonly options: ActivityTimelineOptions = {},
  ) {
    this.every = Math.max(16, Math.floor(options.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY));
    this.maxRecords =
      typeof options.maxRecords === 'number' && options.maxRecords > 0
        ? Math.max(this.every * 2, Math.floor(options.maxRecords))
        : Number.POSITIVE_INFINITY;
    this.current = options.base
      ? cloneActivityState(options.base)
      : createActivityState(undefined, options);
    // Checkpoint 0: the state before the first record held.
    this.checkpoints.push(cloneActivityState(this.current));
    this.append(records);
  }

  get length(): number {
    return this.list.length;
  }

  get startAt(): number | undefined {
    return this.list[0]?.at;
  }

  get endAt(): number | undefined {
    return this.keys[this.keys.length - 1];
  }

  append(records: readonly ActivityRecord[]): void {
    for (const record of records) {
      const key = Math.max(record.at, this.keys[this.keys.length - 1] ?? record.at);
      this.list.push(record);
      this.keys.push(key);
      applyActivityRecord(this.current, record);
      if (this.list.length % this.every === 0) {
        this.checkpoints.push(cloneActivityState(this.current));
      }
    }
    if (this.list.length > this.maxRecords) this.trim();
  }

  head(): Readonly<ActivityState> {
    return this.current;
  }

  stateAt(at: number): ActivityState {
    // Records with a key ≤ at, by binary search.
    let low = 0;
    let high = this.keys.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.keys[mid] <= at) low = mid + 1;
      else high = mid;
    }
    const count = low;
    if (count === this.list.length) return cloneActivityState(this.current);
    const checkpoint = Math.min(Math.floor(count / this.every), this.checkpoints.length - 1);
    const state = cloneActivityState(this.checkpoints[checkpoint]);
    for (let index = checkpoint * this.every; index < count; index++) {
      applyActivityRecord(state, this.list[index]);
    }
    return state;
  }

  snapshotAt(at: number): ActivitySnapshot {
    return snapshotActivity(this.stateAt(at));
  }

  markers(): ActivityMarker[] {
    const markers: ActivityMarker[] = [];
    const stations = new Map<string, ActivityStationId>();
    let model: string | undefined;
    for (const record of this.list) {
      switch (record.kind) {
        case 'prompt':
          markers.push({ at: record.at, kind: 'prompt', station: 'you' });
          break;
        case 'turnEnd':
          markers.push({ at: record.at, kind: 'turnEnd', station: 'you' });
          break;
        case 'compaction':
          markers.push({ at: record.at, kind: 'compaction', station: 'model' });
          break;
        case 'toolStart':
          stations.set(`${record.agentId ?? ''}\u0000${record.id}`, record.station);
          break;
        case 'toolEnd':
          if (record.outcome === 'error' || record.outcome === 'denied') {
            const station = stations.get(`${record.agentId ?? ''}\u0000${record.id}`);
            markers.push({ at: record.at, kind: 'fault', ...(station ? { station } : {}) });
          }
          break;
        case 'hook':
          if (record.outcome === 'blocked' || record.outcome === 'error') {
            markers.push({ at: record.at, kind: 'fault', station: 'hooks' });
          }
          break;
        case 'step':
          if (record.agentId === undefined && record.model) {
            if (model !== undefined && model !== record.model) {
              markers.push({ at: record.at, kind: 'modelSwitch', station: 'model' });
            }
            model = record.model;
          }
          break;
        default:
          break;
      }
    }
    const state = this.current as ActivityState & {
      patterns?: Array<{
        startAt: number;
        kind: string;
        station?: ActivityStationId;
        stations?: ActivityStationId[];
      }>;
    };
    for (const pattern of state.patterns ?? []) {
      const station = pattern.station ?? pattern.stations?.[0];
      markers.push({ at: pattern.startAt, kind: 'pattern', ...(station ? { station } : {}) });
    }
    return markers.sort((a, b) => a.at - b.at);
  }

  records(): readonly ActivityRecord[] {
    return this.list;
  }

  base(): ActivityState {
    return cloneActivityState(this.checkpoints[0]);
  }

  /** Drops the oldest quarter: their effect stays in a new base checkpoint. */
  private trim(): void {
    const drop = Math.floor(this.list.length / 4 / this.every) * this.every || this.every;
    const base = cloneActivityState(
      this.checkpoints[Math.floor(drop / this.every)] ?? this.current,
    );
    this.list = this.list.slice(drop);
    this.keys = this.keys.slice(drop);
    this.checkpoints = [base];
    const replay = cloneActivityState(base);
    for (let index = 0; index < this.list.length; index++) {
      applyActivityRecord(replay, this.list[index]);
      if ((index + 1) % this.every === 0) this.checkpoints.push(cloneActivityState(replay));
    }
  }
}

export function createActivityTimeline(
  records?: readonly ActivityRecord[],
  options?: ActivityTimelineOptions,
): ActivityTimeline {
  return new Timeline(records ?? [], options);
}

export function exportActivity(input: {
  snapshot: ActivitySnapshot;
  insights: ActivityInsights;
  records?: readonly ActivityRecord[];
  providerId?: SessionProviderId;
  sessionId?: string;
  at?: number;
}): ActivityExport {
  const providerId = input.providerId ?? input.snapshot.providerId;
  const sessionId = input.sessionId ?? input.snapshot.sessionId;
  return {
    schemaVersion: 1,
    kind: 'sidekick-activity',
    ...(providerId ? { providerId } : {}),
    ...(sessionId ? { sessionId } : {}),
    at: input.at ?? input.snapshot.at,
    snapshot: input.snapshot,
    insights: input.insights,
    ...(input.records ? { records: input.records.map((record) => ({ ...record })) } : {}),
  };
}
