/**
 * The activity map of one session as it grows: canonical session events go
 * in (live or replayed), snapshots and insights come out.
 *
 * A thin host around the shared recorder and reducer. The dashboard keeps one
 * per followed session and checkpoints it with the rest of its state; the
 * `map --follow` view keeps the records too, so a paused view can scrub back.
 */

import {
  applyActivityRecords,
  cloneActivityState,
  createActivityRecorder,
  createActivityState,
  createActivityTimeline,
  restoreActivityState,
  snapshotActivity,
  summarizeActivity,
} from 'sidekick-shared';
import type {
  ActivityInsights,
  ActivityRecord,
  ActivityRecorder,
  ActivityRecorderOptions,
  ActivityRecorderState,
  ActivitySnapshot,
  ActivityState,
  ActivityTimeline,
  SessionEvent,
  ProviderId,
} from 'sidekick-shared';

/** Classification options a host may set (labels, overrides, memory). */
export type LiveActivityRecorderOptions = Omit<ActivityRecorderOptions, 'providerId' | 'sessionId'>;

export interface LiveActivityOptions {
  providerId: ProviderId;
  sessionId?: string;
  recorder?: LiveActivityRecorderOptions;
  /**
   * Keep up to this many records for scrubbing (`snapshotAt`). 0, the
   * default, keeps none: the state is folded as records arrive.
   */
  keepRecords?: number;
}

/** What a checkpoint stores: the recorder's open calls and the folded state. */
export interface PersistedLiveActivity {
  version: 1;
  recorder: ActivityRecorderState;
  state: unknown;
}

export class LiveActivity {
  private recorder: ActivityRecorder;
  private state: ActivityState;
  private timeline: ActivityTimeline | null;
  private _version = 0;
  private snapshotCache: { version: number; snapshot: ActivitySnapshot } | null = null;
  private insightsCache: { version: number; insights: ActivityInsights } | null = null;

  constructor(private options: LiveActivityOptions) {
    this.recorder = this.createRecorder();
    this.state = createActivityState({
      providerId: options.providerId,
      sessionId: options.sessionId,
    });
    this.timeline = this.createTimeline();
  }

  /** Changes whenever the snapshot would. */
  get version(): number {
    return this._version;
  }

  get providerId(): ProviderId {
    return this.options.providerId;
  }

  get sessionId(): string | undefined {
    return this.options.sessionId;
  }

  /** Feeds one event; returns how many records it produced. */
  observe(event: SessionEvent): number {
    return this.apply(this.recorder.observe(event));
  }

  observeMany(events: readonly SessionEvent[]): number {
    return this.apply(this.recorder.observeMany(events));
  }

  /** Ends every open call (the session is over or the process exits). */
  settle(at: number): number {
    return this.apply(this.recorder.settle(at));
  }

  /** Forgets everything; with a session id, starts over for that session. */
  reset(sessionId?: string, providerId?: ProviderId): void {
    if (sessionId !== undefined) this.options = { ...this.options, sessionId };
    if (providerId !== undefined) this.options = { ...this.options, providerId };
    this.recorder = this.createRecorder();
    this.state = createActivityState({
      providerId: this.options.providerId,
      sessionId: this.options.sessionId,
    });
    this.timeline = this.createTimeline();
    this._version++;
  }

  /** The current snapshot; the same object while nothing changed. */
  snapshot(): ActivitySnapshot {
    if (this.snapshotCache?.version !== this._version) {
      this.snapshotCache = { version: this._version, snapshot: snapshotActivity(this.state) };
    }
    return this.snapshotCache.snapshot;
  }

  /** The snapshot as of `at`; without kept records, the current one. */
  snapshotAt(at: number): ActivitySnapshot {
    if (!this.timeline || this.timeline.length === 0) return this.snapshot();
    const end = this.timeline.endAt;
    if (end !== undefined && at >= end) return this.snapshot();
    return this.timeline.snapshotAt(at);
  }

  insights(): ActivityInsights {
    if (this.insightsCache?.version !== this._version) {
      this.insightsCache = { version: this._version, insights: summarizeActivity(this.state) };
    }
    return this.insightsCache.insights;
  }

  /** First and last record times, or null before anything happened. */
  range(): { startMs: number; endMs: number } | null {
    if (this.timeline && this.timeline.length > 0) {
      const start = this.timeline.startAt;
      const end = this.timeline.endAt;
      if (start !== undefined && end !== undefined) return { startMs: start, endMs: end };
    }
    const snapshot = this.snapshot();
    if (snapshot.startedAt === undefined || !Number.isFinite(snapshot.at)) return null;
    return { startMs: snapshot.startedAt, endMs: Math.max(snapshot.startedAt, snapshot.at) };
  }

  serialize(): PersistedLiveActivity {
    return { version: 1, recorder: this.recorder.export(), state: cloneActivityState(this.state) };
  }

  /** Restores a checkpoint; false (and a fresh start) when it is unusable. */
  restore(value: unknown): boolean {
    const persisted = value as Partial<PersistedLiveActivity> | null | undefined;
    if (!persisted || persisted.version !== 1) {
      this.reset();
      return false;
    }
    const recorder = this.createRecorder();
    const state = restoreActivityState(persisted.state);
    if (!state || !recorder.import(persisted.recorder)) {
      this.reset();
      return false;
    }
    this.recorder = recorder;
    this.state = state;
    // Records before the checkpoint are gone; scrubbing starts from here.
    this.timeline = this.createTimeline();
    this._version++;
    return true;
  }

  private apply(records: readonly ActivityRecord[]): number {
    if (records.length === 0) return 0;
    applyActivityRecords(this.state, records);
    this.timeline?.append(records);
    this._version++;
    return records.length;
  }

  private createRecorder(): ActivityRecorder {
    return createActivityRecorder({
      ...this.options.recorder,
      providerId: this.options.providerId,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
    });
  }

  private createTimeline(): ActivityTimeline | null {
    const keep = this.options.keepRecords ?? 0;
    return keep > 0 ? createActivityTimeline([], { maxRecords: keep }) : null;
  }
}
