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
import { onAccountsChanged, type AccountsChangedEvent } from './accountChanges';

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
  getAccessToken: () => Promise<string | null | undefined>;
  /** Optional cheap account-presence check performed before credential access. */
  hasAccount?: () => boolean | Promise<boolean>;
  /** Override the process-wide login/logout signal (primarily for embedded hosts/tests). */
  subscribeAccountsChanged?: (listener: (event: AccountsChangedEvent) => void) => Disposable;
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
  private readonly getAccessToken: () => Promise<string | null | undefined>;
  private readonly hasAccount?: () => boolean | Promise<boolean>;
  private readonly subscribeAccountsChanged: NonNullable<
    QuotaPollerOptions['subscribeAccountsChanged']
  >;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Array<(state: QuotaState) => void> = [];
  private latest: QuotaState | null = null;
  private isActive = false;
  private consecutiveFailures = 0;
  private stopped = false;
  private polling = false;
  private pendingWake = false;
  private dormant = false;
  private accountSubscription: Disposable | null = null;

  constructor(options: QuotaPollerOptions) {
    this.activeIntervalMs = options.activeIntervalMs ?? 60_000;
    this.idleIntervalMs = options.idleIntervalMs ?? 300_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 120_000;
    this.getAccessToken = options.getAccessToken;
    this.hasAccount = options.hasAccount;
    this.subscribeAccountsChanged = options.subscribeAccountsChanged ?? onAccountsChanged;
  }

  /**
   * Starts polling. First poll is immediate.
   */
  start(): void {
    this.stopped = false;
    this.isActive = true;
    this.accountSubscription ??= this.subscribeAccountsChanged(() => this.wake());
    this.wake();
  }

  /**
   * Stops polling and clears timers.
   */
  stop(): void {
    this.stopped = true;
    this.dormant = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.accountSubscription?.dispose();
    this.accountSubscription = null;
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
    if (this.polling) {
      this.pendingWake = true;
      return;
    }
    this.polling = true;
    this.pendingWake = false;
    this.dormant = false;
    let nextDelayOverride: number | undefined;

    try {
      if (this.hasAccount && !(await this.hasAccount())) {
        this.dormant = true;
        return;
      }
      const token = await this.getAccessToken();
      if (!token) {
        this.dormant = true;
        return;
      }
      const state = await fetchQuota(token);

      if (state.available) {
        this.latest = state;
        this.consecutiveFailures = 0;
        this.notify(state);
      } else if (state.failureKind === 'auth') {
        // Keep polling at the idle cadence so signing in again recovers
        // without an extension/CLI restart.
        this.latest = state;
        this.notify(state);
        this.consecutiveFailures = 0;
        nextDelayOverride = this.idleIntervalMs;
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
    } catch (error) {
      this.consecutiveFailures++;
      const state: QuotaState = {
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
        error: error instanceof Error ? error.message : String(error),
        failureKind: 'auth',
      };
      this.latest = state;
      this.notify(state);
    } finally {
      this.polling = false;
      if (this.pendingWake) {
        this.pendingWake = false;
        void this.poll();
      } else if (!this.dormant) {
        this.scheduleNext(nextDelayOverride);
      }
    }
  }

  private wake(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.polling) {
      this.pendingWake = true;
      return;
    }
    void this.poll();
  }

  private scheduleNext(overrideMs?: number): void {
    if (this.stopped) return;

    const baseInterval = this.isActive ? this.activeIntervalMs : this.idleIntervalMs;
    const backoff = Math.min(
      baseInterval * Math.pow(2, this.consecutiveFailures),
      Math.max(this.maxBackoffMs, baseInterval),
    );
    const delay = overrideMs ?? (this.consecutiveFailures > 0 ? backoff : baseInterval);

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
