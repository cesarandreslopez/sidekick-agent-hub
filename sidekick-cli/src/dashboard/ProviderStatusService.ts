/**
 * Provider status polling for the TUI dashboard.
 *
 * Polls status.claude.com and status.openai.com every 60s to detect
 * API degradation or outages.
 */

import { fetchProviderStatus, fetchOpenAIStatus } from 'sidekick-shared';
import type { ProviderStatusState } from 'sidekick-shared';

export type { ProviderStatusState };

const REFRESH_MS = 60_000;

export class ProviderStatusService {
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _cached: ProviderStatusState | null = null;
  private _cachedOpenAI: ProviderStatusState | null = null;
  private _callback: ((status: ProviderStatusState) => void) | null = null;
  private _openAICallback: ((status: ProviderStatusState) => void) | null = null;

  /** Register a callback for Claude status updates. */
  onUpdate(cb: (status: ProviderStatusState) => void): void {
    this._callback = cb;
  }

  /** Register a callback for OpenAI status updates. */
  onOpenAIUpdate(cb: (status: ProviderStatusState) => void): void {
    this._openAICallback = cb;
  }

  /** Start polling. Fetches immediately, then every 60s. */
  start(): void {
    if (this._interval) return;
    this._fetchAll();
    this._interval = setInterval(() => this._fetchAll(), REFRESH_MS);
  }

  /** Stop polling. */
  stop(): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /** Get the last fetched Claude status state. */
  getCached(): ProviderStatusState | null {
    return this._cached;
  }

  /** Get the last fetched OpenAI status state. */
  getCachedOpenAI(): ProviderStatusState | null {
    return this._cachedOpenAI;
  }

  /** Single fetch — no polling. */
  async fetchOnce(): Promise<ProviderStatusState> {
    return fetchProviderStatus();
  }

  private async _fetchAll(): Promise<void> {
    const [claude, openai] = await Promise.all([
      fetchProviderStatus(),
      fetchOpenAIStatus(),
    ]);
    this._cached = claude;
    this._callback?.(claude);
    this._cachedOpenAI = openai;
    this._openAICallback?.(openai);
  }
}
