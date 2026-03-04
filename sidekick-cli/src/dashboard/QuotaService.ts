/**
 * Subscription quota polling for the TUI dashboard.
 *
 * For Claude Code / Claude Max: reads OAuth token from ~/.claude/.credentials.json
 * and polls the Anthropic usage API every 30s.
 *
 * For Codex: quota comes from rate_limits in FollowEvent (handled by DashboardState).
 */

import { readClaudeMaxCredentials, fetchQuota } from 'sidekick-shared';
import type { QuotaState, QuotaWindow } from 'sidekick-shared';

export type { QuotaWindow, QuotaState };

const REFRESH_MS = 30_000;

export class QuotaService {
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _cached: QuotaState | null = null;
  private _callback: ((quota: QuotaState) => void) | null = null;

  /** Register a callback for quota updates. */
  onUpdate(cb: (quota: QuotaState) => void): void {
    this._callback = cb;
  }

  /** Start polling. Fetches immediately, then every 30s. */
  start(): void {
    if (this._interval) return;
    this.fetchQuota();
    this._interval = setInterval(() => this.fetchQuota(), REFRESH_MS);
  }

  /** Stop polling. */
  stop(): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /** Get the last fetched quota state. */
  getCached(): QuotaState | null {
    return this._cached;
  }

  /** Single fetch — no polling, includes elapsed-time projections. */
  async fetchOnce(): Promise<QuotaState> {
    const creds = await readClaudeMaxCredentials();
    if (!creds) {
      return { fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' }, available: false, error: 'no-credentials' };
    }
    return fetchQuota(creds.accessToken);
  }

  async fetchQuota(): Promise<void> {
    const creds = await readClaudeMaxCredentials();
    if (!creds) {
      this.emit({ fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' }, available: false });
      return;
    }

    const state = await fetchQuota(creds.accessToken);

    // On rate limit / network error keep cached data
    if (!state.available && this._cached?.available) return;

    this.emit(state);
  }

  private emit(state: QuotaState): void {
    this._cached = state;
    this._callback?.(state);
  }
}
