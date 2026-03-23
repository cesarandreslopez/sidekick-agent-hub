/**
 * Quota poller with exponential backoff and cached fallback.
 *
 * Wraps fetchQuota() with automatic polling, retry logic,
 * and cached state for transient failures.
 *
 * @module quotaPoller
 */

import { fetchQuota } from './quota';
import type { QuotaState } from './quota';

/** Disposable subscription handle. */
export interface Disposable {
  dispose(): void;
}

/** Options for QuotaPoller construction. */
export interface QuotaPollerOptions {
  /** Polling interval when actively monitored (ms). Default: 60_000 (1 minute). */
  activeIntervalMs?: number;
  /** Polling interval when idle (ms). Default: 300_000 (5 minutes). */
  idleIntervalMs?: number;
  /** Maximum backoff delay for retries (ms). Default: 120_000 (2 minutes). */
  maxBackoffMs?: number;
  /** Returns the current access token. Called before each fetch. */
  getAccessToken: () => Promise<string>;
}

/**
 * Polls Claude Max quota usage with exponential backoff on transient errors,
 * cached fallback, and configurable active/idle intervals.
 *
 * @example
 * ```typescript
 * const poller = new QuotaPoller({
 *   getAccessToken: async () => readClaudeMaxAccessTokenSync()!,
 *   activeIntervalMs: 30_000,
 * });
 *
 * poller.onUpdate(state => {
 *   console.log(`5h: ${state.fiveHour.utilization}%`);
 * });
 *
 * poller.start();
 * // later...
 * poller.stop();
 * ```
 */
export class QuotaPoller {
  private readonly activeIntervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly getAccessToken: () => Promise<string>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Array<(state: QuotaState) => void> = [];
  private latest: QuotaState | null = null;
  private isActive = false;
  private consecutiveFailures = 0;
  private stopped = false;

  constructor(options: QuotaPollerOptions) {
    this.activeIntervalMs = options.activeIntervalMs ?? 60_000;
    this.idleIntervalMs = options.idleIntervalMs ?? 300_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 120_000;
    this.getAccessToken = options.getAccessToken;
  }

  /**
   * Starts polling. First poll is immediate.
   */
  start(): void {
    this.stopped = false;
    this.isActive = true;
    void this.poll();
  }

  /**
   * Stops polling and clears timers.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Switches to active polling interval.
   */
  setActive(): void {
    this.isActive = true;
  }

  /**
   * Switches to idle polling interval.
   */
  setIdle(): void {
    this.isActive = false;
  }

  /**
   * Registers a callback for quota state updates.
   *
   * @param cb - Called with the latest QuotaState after each successful or cached poll
   * @returns Disposable to unsubscribe
   */
  onUpdate(cb: (state: QuotaState) => void): Disposable {
    this.listeners.push(cb);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(cb);
        if (idx >= 0) this.listeners.splice(idx, 1);
      },
    };
  }

  /**
   * Returns the most recent quota state, or null if never fetched.
   */
  getLatest(): QuotaState | null {
    return this.latest;
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    try {
      const token = await this.getAccessToken();
      const state = await fetchQuota(token);

      if (state.available) {
        this.latest = state;
        this.consecutiveFailures = 0;
        this.notify(state);
      } else if (state.failureKind === 'auth') {
        // Auth errors: stop polling, notify with error state
        this.latest = state;
        this.notify(state);
        this.stop();
        return;
      } else {
        // Transient error: increment backoff, use cached state
        this.consecutiveFailures++;
        if (this.latest) {
          // Serve cached value with the error info attached
          const cached: QuotaState = {
            ...this.latest,
            error: state.error,
            failureKind: state.failureKind,
          };
          this.notify(cached);
        } else {
          this.notify(state);
        }
      }
    } catch {
      this.consecutiveFailures++;
    }

    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    const baseInterval = this.isActive ? this.activeIntervalMs : this.idleIntervalMs;
    const backoff = Math.min(
      baseInterval * Math.pow(2, this.consecutiveFailures),
      this.maxBackoffMs,
    );
    const delay = this.consecutiveFailures > 0 ? backoff : baseInterval;

    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private notify(state: QuotaState): void {
    for (const cb of this.listeners) {
      try {
        cb(state);
      } catch {
        // Listener errors should not break the poller
      }
    }
  }
}
