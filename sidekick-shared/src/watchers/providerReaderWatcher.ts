/**
 * Session watcher backed by a provider SessionReader.
 *
 * This keeps live/replay FollowEvent consumers on the same canonical parser
 * path used by provider-aware VS Code monitoring.
 */

import * as fs from 'fs';
import type { SessionProviderBase } from '../providers/types';
import { toFollowEvents } from './eventBridge';
import type { SessionWatcher, SessionWatcherCallbacks } from './types';

const DEBOUNCE_MS = 100;
const CATCHUP_INTERVAL_MS = 30_000;

export class ProviderReaderSessionWatcher implements SessionWatcher {
  private _isActive = false;
  private fsWatcher: fs.FSWatcher | null = null;
  private catchupTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reader;

  constructor(
    private readonly provider: SessionProviderBase,
    private readonly sessionPath: string,
    private readonly callbacks: SessionWatcherCallbacks,
  ) {
    this.reader = provider.createReader(sessionPath);
  }

  get isActive(): boolean { return this._isActive; }

  seekTo(position: number): void {
    this.reader.seekTo(position);
  }

  getPosition(): number {
    return this.reader.getPosition();
  }

  start(replay: boolean): void {
    if (this._isActive) return;
    this._isActive = true;

    if (!replay) {
      this.seekToEnd();
    } else {
      this.readNewEvents();
    }

    try {
      this.fsWatcher = fs.watch(this.sessionPath, { persistent: false }, () => {
        this.debouncedRead();
      });
      this.fsWatcher.on('error', () => {
        this.stop();
      });
    } catch {
      // fs.watch may be unavailable; polling still catches up.
    }

    this.catchupTimer = setInterval(() => {
      if (this._isActive) this.readNewEvents();
    }, CATCHUP_INTERVAL_MS);
  }

  stop(): void {
    if (!this._isActive) return;
    this._isActive = false;

    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.fsWatcher) { this.fsWatcher.close(); this.fsWatcher = null; }
    if (this.catchupTimer) { clearInterval(this.catchupTimer); this.catchupTimer = null; }
    this.reader.flush();
  }

  private seekToEnd(): void {
    try {
      const stat = fs.statSync(this.sessionPath);
      this.reader.seekTo(stat.size);
    } catch {
      this.reader.reset();
    }
  }

  private debouncedRead(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.readNewEvents();
    }, DEBOUNCE_MS);
  }

  private readNewEvents(): void {
    if (!this._isActive) return;
    try {
      if (this.reader.wasTruncated()) {
        this.reader.reset();
      }
      const events = this.reader.readNew();
      for (const event of events) {
        for (const followEvent of toFollowEvents(event, this.provider.id)) {
          this.callbacks.onEvent(followEvent);
        }
      }
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
