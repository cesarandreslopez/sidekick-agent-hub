/**
 * The session monitor's activity log: a shared activity recorder plus a
 * scrubbable timeline, fed one canonical session event at a time.
 *
 * The store numbers records by `seq` within an `epoch`. A reset (a new
 * session, a reader that started over) starts a new epoch, so a view that
 * holds records from an older epoch knows to resync instead of appending.
 * Notifications are coalesced and silenced during replays; views receive the
 * replayed history in one batch when the replay ends.
 *
 * The state is checkpointed with the monitor's snapshot so a resumed session
 * keeps its history. Once the timeline has dropped old records (past
 * `maxRecords`), its totals can no longer be rebuilt from the records alone,
 * so such a log refuses to restore and the monitor replays the file instead.
 *
 * Deliberately free of any `vscode` import so it unit-tests without a mock.
 *
 * @module services/ActivityStore
 */

import {
  createActivityRecorder,
  createActivityTimeline,
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
  ProviderId,
  SessionEvent,
} from 'sidekick-shared';

export const ACTIVITY_STORE_MAX_RECORDS = 20_000;
const DEFAULT_COALESCE_MS = 100;
const DEFAULT_MAX_WAIT_MS = 250;

/** What a store persists inside the monitor's checkpoint. */
export interface PersistedActivityState {
  version: 1;
  providerId: ProviderId;
  sessionId?: string;
  /** False once records were dropped: the state cannot be rebuilt from them. */
  complete: boolean;
  recorder: ActivityRecorderState;
  records: ActivityRecord[];
}

export interface ActivityAppendEvent {
  epoch: number;
  nextSeq: number;
}

export interface ActivityStoreOptions {
  recorder: ActivityRecorderOptions;
  maxRecords?: number;
  coalesceMs?: number;
  maxWaitMs?: number;
}

export interface ActivityContextObservation {
  /** Event time, epoch ms. */
  at: number;
  usedTokens: number;
  windowTokens: number;
}

interface Disposable {
  dispose(): void;
}

export class ActivityStore {
  private recorderOptions: ActivityRecorderOptions;
  private recorder: ActivityRecorder;
  private timeline: ActivityTimeline;
  private readonly maxRecords: number;
  private readonly coalesceMs: number;
  private readonly maxWaitMs: number;
  private currentEpoch = 1;
  private appended = 0;
  private replaying = 0;
  private dirtyDuringReplay = false;
  private readonly listeners = new Set<(event: ActivityAppendEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt: number | null = null;
  private disposed = false;

  constructor(options: ActivityStoreOptions) {
    this.recorderOptions = { ...options.recorder };
    this.maxRecords = options.maxRecords ?? ACTIVITY_STORE_MAX_RECORDS;
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.recorder = createActivityRecorder(this.recorderOptions);
    this.timeline = this.newTimeline();
  }

  /** Increases on every reset; records of an older epoch are void. */
  get epoch(): number {
    return this.currentEpoch;
  }

  /** `seq` of the oldest record held (later than 0 once records were dropped). */
  get baseSeq(): number {
    return this.timeline.records()[0]?.seq ?? this.recorder.nextSeq;
  }

  /** `seq` the next record will get. */
  get nextSeq(): number {
    return this.recorder.nextSeq;
  }

  get providerId(): ProviderId {
    return this.recorderOptions.providerId;
  }

  get sessionId(): string | undefined {
    return this.recorderOptions.sessionId;
  }

  get isReplaying(): boolean {
    return this.replaying > 0;
  }

  /** Feeds one canonical event; returns how many records it produced. */
  observe(event: SessionEvent): number {
    return this.append(this.recorder.observe(event));
  }

  /** Context fill as the host measures it (the dashboard's own numbers). */
  observeContext(observation: ActivityContextObservation): number {
    const { at, usedTokens, windowTokens } = observation;
    if (!Number.isFinite(at) || !(windowTokens > 0) || !(usedTokens >= 0)) return 0;
    const percent = Math.max(0, Math.min(100, (usedTokens / windowTokens) * 100));
    return this.append(
      this.recorder.observeContext({ at, percent, tokens: usedTokens, window: windowTokens }),
    );
  }

  /** Silences notifications until the matching `endReplay`. */
  beginReplay(): void {
    this.replaying++;
  }

  /** Ends a replay; listeners hear about everything it added at once. */
  endReplay(): void {
    if (this.replaying === 0) return;
    this.replaying--;
    if (this.replaying === 0 && this.dirtyDuringReplay) {
      this.dirtyDuringReplay = false;
      this.schedule();
    }
  }

  /** Starts a new, empty log (a new session, or the same file read from the start). */
  reset(info?: { providerId?: ProviderId; sessionId?: string | null }): void {
    if (info) {
      this.recorderOptions = {
        ...this.recorderOptions,
        ...(info.providerId ? { providerId: info.providerId } : {}),
        sessionId: info.sessionId ?? undefined,
      };
    }
    this.recorder = createActivityRecorder(this.recorderOptions);
    this.timeline = this.newTimeline();
    this.appended = 0;
    this.currentEpoch++;
    this.notify();
  }

  /** New classification settings; they apply to events observed from now on. */
  reconfigure(options: Omit<ActivityRecorderOptions, 'providerId' | 'sessionId'>): void {
    const state = this.recorder.export();
    this.recorderOptions = {
      ...options,
      providerId: this.recorderOptions.providerId,
      ...(this.recorderOptions.sessionId ? { sessionId: this.recorderOptions.sessionId } : {}),
      deriveContext: this.recorderOptions.deriveContext,
    };
    this.recorder = createActivityRecorder(this.recorderOptions);
    if (!this.recorder.import(state)) {
      // An unusable state resets the recorder; the timeline keeps what it has.
      this.recorder = createActivityRecorder(this.recorderOptions);
    }
  }

  /** Every record held, oldest first. */
  records(): readonly ActivityRecord[] {
    return this.timeline.records();
  }

  /** A fresh copy of the state before the first record held (what dropped records left). */
  base(): ActivityState {
    return this.timeline.base();
  }

  /** Records from `seq` on; null when `seq` was dropped already or lies ahead. */
  recordsFrom(seq: number): ActivityRecord[] | null {
    const held = this.timeline.records();
    const base = held[0]?.seq ?? this.recorder.nextSeq;
    if (seq < base || seq > this.recorder.nextSeq) return null;
    return held.slice(seq - base);
  }

  /** The drawing view now, or as of `at` (epoch ms). */
  snapshot(at?: number): ActivitySnapshot {
    return at === undefined ? snapshotActivity(this.timeline.head()) : this.timeline.snapshotAt(at);
  }

  /** Full-session statistics now, or as of `at` (epoch ms). */
  insights(at?: number): ActivityInsights {
    return summarizeActivity(at === undefined ? this.timeline.head() : this.timeline.stateAt(at));
  }

  /** The checkpointable state. */
  serialize(): PersistedActivityState {
    const records = this.timeline.records();
    return {
      version: 1,
      providerId: this.recorderOptions.providerId,
      ...(this.recorderOptions.sessionId ? { sessionId: this.recorderOptions.sessionId } : {}),
      complete: this.appended === records.length,
      recorder: this.recorder.export(),
      records: records.slice(),
    };
  }

  /**
   * Restores a checkpointed state. False (and nothing changed) when it is
   * missing, malformed, incomplete, or from another provider or session.
   */
  restore(value: unknown): boolean {
    if (!isPersistedActivityState(value)) return false;
    if (!value.complete) return false;
    if (value.providerId !== this.recorderOptions.providerId) return false;
    if ((value.sessionId ?? undefined) !== (this.recorderOptions.sessionId ?? undefined)) {
      return false;
    }
    const recorder = createActivityRecorder(this.recorderOptions);
    if (!recorder.import(value.recorder)) return false;
    const records = value.records;
    // Records are numbered without gaps from 0; the recorder continues after them.
    for (let index = 0; index < records.length; index++) {
      if (records[index].seq !== index) return false;
    }
    if (recorder.nextSeq !== records.length) return false;
    this.recorder = recorder;
    this.timeline = this.newTimeline(records);
    this.appended = records.length;
    this.currentEpoch++;
    this.notify();
    return true;
  }

  /** Coalesced: at most one call per `coalesceMs`, and never later than `maxWaitMs`. */
  onDidAppend(listener: (event: ActivityAppendEvent) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) this.clearTimer();
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.clearTimer();
  }

  private newTimeline(records?: readonly ActivityRecord[]): ActivityTimeline {
    return createActivityTimeline(records, { maxRecords: this.maxRecords });
  }

  private append(records: ActivityRecord[]): number {
    if (records.length === 0) return 0;
    this.timeline.append(records);
    this.appended += records.length;
    this.notify();
    return records.length;
  }

  private notify(): void {
    if (this.replaying > 0) {
      this.dirtyDuringReplay = true;
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.listeners.size === 0) return;
    const now = Date.now();
    this.firstPendingAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.coalesceMs, this.firstPendingAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.timer = null;
    this.firstPendingAt = null;
    const event: ActivityAppendEvent = { epoch: this.currentEpoch, nextSeq: this.nextSeq };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A failing view never stops the log.
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.firstPendingAt = null;
  }
}

function isPersistedActivityState(value: unknown): value is PersistedActivityState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<PersistedActivityState>;
  return (
    state.version === 1 &&
    typeof state.providerId === 'string' &&
    typeof state.complete === 'boolean' &&
    !!state.recorder &&
    typeof state.recorder === 'object' &&
    Array.isArray(state.records) &&
    state.records.every(
      (record) =>
        !!record &&
        typeof record === 'object' &&
        typeof (record as ActivityRecord).seq === 'number' &&
        typeof (record as ActivityRecord).at === 'number' &&
        typeof (record as ActivityRecord).kind === 'string',
    )
  );
}
