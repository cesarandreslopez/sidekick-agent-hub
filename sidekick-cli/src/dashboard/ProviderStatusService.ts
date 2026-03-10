/**
 * Provider status polling for the TUI dashboard.
 *
 * Polls status.claude.com every 60s to detect API degradation or outages.
 */

import { fetchProviderStatus } from 'sidekick-shared';
import type { ProviderStatusState } from 'sidekick-shared';

export type { ProviderStatusState };

const REFRESH_MS = 60_000;

export class ProviderStatusService {
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _cached: ProviderStatusState | null = null;
  private _callback: ((status: ProviderStatusState) => void) | null = null;

  /** Register a callback for status updates. */
  onUpdate(cb: (status: ProviderStatusState) => void): void {
    this._callback = cb;
  }

  /** Start polling. Fetches immediately, then every 60s. */
  start(): void {
    if (this._interval) return;
    this._fetch();
    this._interval = setInterval(() => this._fetch(), REFRESH_MS);
  }

  /** Stop polling. */
  stop(): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /** Get the last fetched status state. */
  getCached(): ProviderStatusState | null {
    return this._cached;
  }

  /** Single fetch — no polling. */
  async fetchOnce(): Promise<ProviderStatusState> {
    return fetchProviderStatus();
  }

  private async _fetch(): Promise<void> {
    const state = await fetchProviderStatus();
    this._cached = state;
    this._callback?.(state);
  }
}
