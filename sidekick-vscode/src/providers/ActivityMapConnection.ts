/**
 * Keeps one Activity Map webview in step with an activity source: a full
 * `activity/init` when the webview starts or falls out of step, then
 * `activity/append` runs of new records, never while the view is hidden.
 *
 * Free of any `vscode` import (the webview and the source are interfaces),
 * so the protocol unit-tests with plain fakes.
 *
 * @module providers/ActivityMapConnection
 */

import type {
  ActivityInsights,
  ActivityRecord,
  ActivitySnapshot,
  ActivityState,
  ActivityStationId,
} from 'sidekick-shared';
import { ACTIVITY_MAP_PROTOCOL } from '../types/activityMap';
import type {
  ActivityMapFocus,
  ActivityMapHostMessage,
  ActivityMapSourceInfo,
  ActivityMapViewOptions,
  ActivityMapWebviewMessage,
} from '../types/activityMap';

export interface Disposable {
  dispose(): void;
}

/** Where the records come from: the monitored session, or a replayed past one. */
export interface ActivitySource {
  readonly kind: 'live' | 'archive';
  /** Null while there is no session to show. */
  info(): ActivityMapSourceInfo | null;
  epoch(): number;
  nextSeq(): number;
  baseSeq(): number;
  /** The state before the first record held (dropped records leave their effect here). */
  base(): ActivityState;
  records(): readonly ActivityRecord[];
  /** Null when `seq` is no longer (or not yet) held. */
  recordsFrom(seq: number): ActivityRecord[] | null;
  /** Whether new records may still arrive. */
  isLive(): boolean;
  snapshot(at?: number): ActivitySnapshot;
  insights(at?: number): ActivityInsights;
  /** Fires when records were added, the log was reset, or liveness changed. */
  onDidChange(listener: () => void): Disposable;
  dispose?(): void;
}

export interface WebviewLike {
  postMessage(message: ActivityMapHostMessage): Thenable<boolean> | Promise<boolean> | boolean;
  onDidReceiveMessage(listener: (message: ActivityMapWebviewMessage) => void): Disposable;
}

export interface ActivityMapConnectionHooks {
  isVisible(): boolean;
  /** Visibility changes; the connection catches up when the view shows again. */
  onDidChangeVisibility?(listener: () => void): Disposable;
  /** Host clock (epoch ms). */
  now?(): number;
  focus?: ActivityMapFocus;
  onPopOut?(request: { at?: number; station?: ActivityStationId }): void;
  onExport?(request: { format?: 'svg' | 'json'; at?: number }): void;
  onOpenSettings?(): void;
}

export class ActivityMapConnection implements Disposable {
  private readonly disposables: Disposable[] = [];
  /** What the webview holds; undefined until it has had an init. */
  private sent: { epoch: number; nextSeq: number } | undefined;
  private lastLive: boolean | undefined;
  private ready = false;
  private dirty = false;
  private disposed = false;
  private focus: ActivityMapFocus | undefined;

  constructor(
    private readonly webview: WebviewLike,
    private readonly source: ActivitySource,
    private readonly hooks: ActivityMapConnectionHooks,
  ) {
    this.focus = hooks.focus;
    this.disposables.push(
      webview.onDidReceiveMessage((message) => this.receive(message)),
      source.onDidChange(() => this.changed()),
    );
    if (hooks.onDidChangeVisibility) {
      this.disposables.push(
        hooks.onDidChangeVisibility(() => {
          if (hooks.isVisible() && this.dirty) this.flush();
        }),
      );
    }
  }

  /** Sends changed drawing options (motion, layout, core name). */
  updateOptions(options: ActivityMapViewOptions): void {
    if (!this.ready || this.disposed) return;
    this.post({ type: 'activity/options', options });
  }

  /** Moves a panel to a cursor or station (a second pop-out request). */
  refocus(focus: ActivityMapFocus | undefined): void {
    this.focus = focus;
    if (this.ready) this.sendInit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private receive(message: ActivityMapWebviewMessage): void {
    if (this.disposed || !message || typeof message !== 'object') return;
    switch (message.type) {
      // A (re)started webview, or one out of step: always a full init.
      case 'activity/ready':
      case 'activity/resync':
        this.ready = true;
        this.sendInit();
        return;
      case 'activity/popOut':
        this.hooks.onPopOut?.({ at: message.at, station: message.station });
        return;
      case 'activity/export': {
        const format =
          message.format === 'svg' || message.format === 'json' ? message.format : undefined;
        const at =
          typeof message.at === 'number' && Number.isFinite(message.at) ? message.at : undefined;
        this.hooks.onExport?.({ format, at });
        return;
      }
      case 'activity/openSettings':
        this.hooks.onOpenSettings?.();
        return;
      default:
        return;
    }
  }

  private changed(): void {
    if (!this.ready || this.disposed) return;
    if (!this.hooks.isVisible()) {
      this.dirty = true;
      return;
    }
    this.flush();
  }

  private flush(): void {
    this.dirty = false;
    const info = this.source.info();
    if (!info) {
      if (this.sent || this.lastLive !== undefined) {
        this.sent = undefined;
        this.lastLive = undefined;
        this.post({ type: 'activity/empty', reason: 'noSession' });
      }
      return;
    }
    if (!this.sent || this.sent.epoch !== this.source.epoch()) {
      this.sendInit();
      return;
    }
    const records = this.source.recordsFrom(this.sent.nextSeq);
    if (records === null) {
      this.sendInit();
      return;
    }
    if (records.length > 0) this.sendAppend(records, this.sent.nextSeq);
    this.syncLive();
  }

  private sendInit(): void {
    const info = this.source.info();
    if (!info) {
      this.sent = undefined;
      this.post({ type: 'activity/empty', reason: 'noSession' });
      return;
    }
    const records = this.source.records().slice();
    const epoch = this.source.epoch();
    const nextSeq = this.source.nextSeq();
    const live = this.source.isLive();
    this.sent = { epoch, nextSeq };
    this.lastLive = live;
    this.dirty = false;
    this.post({
      type: 'activity/init',
      protocol: ACTIVITY_MAP_PROTOCOL,
      source: info,
      epoch,
      baseSeq: this.source.baseSeq(),
      nextSeq,
      base: this.source.base(),
      records,
      hostNow: this.now(),
      live,
      ...(this.focus ? { focus: this.focus } : {}),
    });
    // A focus applies to the init it rides on, not to later resyncs.
    this.focus = undefined;
  }

  private sendAppend(records: ActivityRecord[], fromSeq: number): void {
    if (!this.sent) return;
    if (records.length > 0) {
      this.post({
        type: 'activity/append',
        epoch: this.sent.epoch,
        fromSeq,
        records,
        hostNow: this.now(),
      });
    }
    this.sent = { epoch: this.sent.epoch, nextSeq: fromSeq + records.length };
  }

  private syncLive(): void {
    const live = this.source.isLive();
    if (live === this.lastLive) return;
    this.lastLive = live;
    this.post({ type: 'activity/state', live, hostNow: this.now() });
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  private post(message: ActivityMapHostMessage): void {
    if (this.disposed) return;
    try {
      const result = this.webview.postMessage(message);
      if (result && typeof (result as Promise<boolean>).then === 'function') {
        (result as Promise<boolean>).then(undefined, () => undefined);
      }
    } catch {
      // A disposed webview drops messages; the next ready resyncs.
    }
  }
}
