/**
 * Activity sources for the Activity Map connection: the monitored session
 * (live, growing) and a replayed past session (archive, fixed).
 *
 * @module providers/activityMapSources
 */

import { snapshotActivity, summarizeActivity } from 'sidekick-shared';
import type {
  ActivityInsights,
  ActivityRecord,
  ActivitySnapshot,
  ActivityState,
  ActivityTimeline,
  ProviderId,
} from 'sidekick-shared';
import type { ActivityStore } from '../services/ActivityStore';
import type { ActivityMapSourceInfo } from '../types/activityMap';
import type { ActivitySource, Disposable } from './ActivityMapConnection';

type EventSubscribe<T> = (listener: (event: T) => unknown) => Disposable;

/** The part of the session monitor a live source reads. */
export interface LiveActivityMonitor {
  getActivityStore(): ActivityStore;
  isActive(): boolean;
  getSessionPath(): string | null;
  getProvider(): { id: ProviderId; displayName: string; getSessionId(sessionPath: string): string };
  onSessionStart: EventSubscribe<string>;
  onSessionEnd: EventSubscribe<void>;
  onSessionReset: EventSubscribe<unknown>;
}

export function activitySourceLabel(displayName: string, sessionId: string | undefined): string {
  return sessionId ? `${displayName} · ${sessionId.slice(0, 8)}` : displayName;
}

/** The session the monitor follows; records arrive as the agent works. */
export class LiveActivitySource implements ActivitySource {
  readonly kind = 'live' as const;

  constructor(private readonly monitor: LiveActivityMonitor) {}

  private get store(): ActivityStore {
    return this.monitor.getActivityStore();
  }

  info(): ActivityMapSourceInfo | null {
    const sessionPath = this.monitor.getSessionPath();
    if (!sessionPath) return null;
    const provider = this.monitor.getProvider();
    const sessionId = this.store.sessionId ?? provider.getSessionId(sessionPath);
    return {
      kind: 'live',
      providerId: provider.id,
      ...(sessionId ? { sessionId } : {}),
      label: activitySourceLabel(provider.displayName, sessionId),
    };
  }

  epoch(): number {
    return this.store.epoch;
  }

  nextSeq(): number {
    return this.store.nextSeq;
  }

  baseSeq(): number {
    return this.store.baseSeq;
  }

  base(): ActivityState {
    return this.store.base();
  }

  records(): readonly ActivityRecord[] {
    return this.store.records();
  }

  recordsFrom(seq: number): ActivityRecord[] | null {
    return this.store.recordsFrom(seq);
  }

  isLive(): boolean {
    return this.monitor.isActive();
  }

  snapshot(at?: number): ActivitySnapshot {
    return this.store.snapshot(at);
  }

  insights(at?: number): ActivityInsights {
    return this.store.insights(at);
  }

  onDidChange(listener: () => void): Disposable {
    const subscriptions = [
      this.store.onDidAppend(() => listener()),
      this.monitor.onSessionStart(() => listener()),
      this.monitor.onSessionEnd(() => listener()),
      this.monitor.onSessionReset(() => listener()),
    ];
    return { dispose: () => subscriptions.forEach((s) => s.dispose()) };
  }
}

/** A past session replayed once; nothing changes after that. */
export class ArchiveActivitySource implements ActivitySource {
  readonly kind = 'archive' as const;

  constructor(
    private readonly sourceInfo: ActivityMapSourceInfo,
    private readonly timeline: ActivityTimeline,
  ) {}

  info(): ActivityMapSourceInfo {
    return this.sourceInfo;
  }

  epoch(): number {
    return 1;
  }

  nextSeq(): number {
    const records = this.timeline.records();
    return records.length > 0 ? records[records.length - 1].seq + 1 : 0;
  }

  baseSeq(): number {
    return this.timeline.records()[0]?.seq ?? 0;
  }

  base(): ActivityState {
    return this.timeline.base();
  }

  records(): readonly ActivityRecord[] {
    return this.timeline.records();
  }

  recordsFrom(seq: number): ActivityRecord[] | null {
    const records = this.timeline.records();
    const base = this.baseSeq();
    if (seq < base || seq > this.nextSeq()) return null;
    return records.slice(seq - base);
  }

  isLive(): boolean {
    return false;
  }

  snapshot(at?: number): ActivitySnapshot {
    return at === undefined ? snapshotActivity(this.timeline.head()) : this.timeline.snapshotAt(at);
  }

  insights(at?: number): ActivityInsights {
    return summarizeActivity(at === undefined ? this.timeline.head() : this.timeline.stateAt(at));
  }

  onDidChange(): Disposable {
    return { dispose: () => undefined };
  }
}
