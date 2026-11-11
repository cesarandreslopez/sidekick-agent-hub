/**
 * The webview's copy of the activity log: records from `activity/init` and
 * `activity/append`, folded into a scrubbable timeline.
 *
 * @module webview/activityMap/model
 */

import {
  createActivityTimeline,
  snapshotActivity,
  summarizeActivity,
} from 'sidekick-shared/activity';
import type {
  ActivityInsights,
  ActivityMarker,
  ActivityRecord,
  ActivitySnapshot,
  ActivityTimeline,
} from 'sidekick-shared/activity';
import type { ActivityMapHostMessage, ActivityMapSourceInfo } from '../../types/activityMap';

type InitMessage = Extract<ActivityMapHostMessage, { type: 'activity/init' }>;
type AppendMessage = Extract<ActivityMapHostMessage, { type: 'activity/append' }>;

/** `epoch`/`gap`: the webview fell out of step and must ask for a resync. */
export type AppendResult = 'ok' | 'epoch' | 'gap';

export interface ActivityRange {
  startAt: number;
  endAt: number;
}

export class ActivityTimelineModel {
  epoch = 0;
  nextSeq = 0;
  live = false;
  source: ActivityMapSourceInfo | undefined;
  /** Increases on every change, for memoizing derived views. */
  version = 0;
  private timeline: ActivityTimeline = createActivityTimeline();
  private insightsCache: {
    version: number;
    at: number | undefined;
    value: ActivityInsights;
  } | null = null;

  get hasSession(): boolean {
    return this.source !== undefined;
  }

  get length(): number {
    return this.timeline.length;
  }

  init(message: InitMessage): void {
    this.epoch = message.epoch;
    this.timeline = createActivityTimeline(message.records);
    this.nextSeq = message.nextSeq;
    this.live = message.live;
    this.source = message.source;
    this.version++;
  }

  clear(): void {
    this.epoch = 0;
    this.nextSeq = 0;
    this.live = false;
    this.source = undefined;
    this.timeline = createActivityTimeline();
    this.version++;
  }

  append(message: AppendMessage): AppendResult {
    if (message.epoch !== this.epoch) return 'epoch';
    if (message.fromSeq > this.nextSeq) return 'gap';
    // Overlap with what is held is harmless: skip the records already folded.
    const fresh = message.records.filter((record) => record.seq >= this.nextSeq);
    if (fresh.length === 0) return 'ok';
    for (let index = 0; index < fresh.length; index++) {
      if (fresh[index].seq !== this.nextSeq + index) return 'gap';
    }
    this.timeline.append(fresh);
    this.nextSeq = fresh[fresh.length - 1].seq + 1;
    this.version++;
    return 'ok';
  }

  setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    this.version++;
  }

  range(): ActivityRange | null {
    const startAt = this.timeline.startAt;
    const endAt = this.timeline.endAt;
    if (startAt === undefined || endAt === undefined) return null;
    return { startAt, endAt: Math.max(startAt, endAt) };
  }

  /** The view as of `at`; the newest when `at` is omitted or past the end. */
  snapshotAt(at?: number): ActivitySnapshot {
    const end = this.timeline.endAt;
    if (at === undefined || end === undefined || at >= end) {
      return snapshotActivity(this.timeline.head());
    }
    return this.timeline.snapshotAt(at);
  }

  insightsAt(at?: number): ActivityInsights {
    const end = this.timeline.endAt;
    const key = at === undefined || end === undefined || at >= end ? undefined : at;
    if (
      this.insightsCache &&
      this.insightsCache.version === this.version &&
      this.insightsCache.at === key
    ) {
      return this.insightsCache.value;
    }
    const value = summarizeActivity(
      key === undefined ? this.timeline.head() : this.timeline.stateAt(key),
    );
    this.insightsCache = { version: this.version, at: key, value };
    return value;
  }

  markers(): ActivityMarker[] {
    return this.timeline.markers();
  }

  records(): readonly ActivityRecord[] {
    return this.timeline.records();
  }

  /** Tool calls started per bucket across the session, for the scrubber's density strip. */
  density(buckets: number): number[] {
    const range = this.range();
    const counts = new Array<number>(buckets).fill(0);
    if (!range) return counts;
    const span = Math.max(1, range.endAt - range.startAt);
    for (const record of this.timeline.records()) {
      if (record.kind !== 'toolStart') continue;
      const index = Math.min(
        buckets - 1,
        Math.floor(((record.at - range.startAt) / span) * buckets),
      );
      counts[Math.max(0, index)]++;
    }
    return counts;
  }

  /** The first record later than `at` (for skipping idle stretches during playback). */
  nextRecordAfter(at: number): number | undefined {
    const records = this.timeline.records();
    let low = 0;
    let high = records.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (records[mid].at <= at) low = mid + 1;
      else high = mid;
    }
    return records[low]?.at;
  }
}
