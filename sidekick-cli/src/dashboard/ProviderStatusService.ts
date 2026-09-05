/**
 * Provider status polling for the TUI dashboard.
 *
 * Polls the status page that matters for the active session provider every
 * 60s to detect API degradation or outages: status.claude.com for Claude
 * Code, status.openai.com for Codex, nothing for OpenCode.
 */

import { fetchProviderStatus, fetchOpenAIStatus } from 'sidekick-shared';
import type { ProviderStatusState } from 'sidekick-shared';
import type { DashboardProviderId } from './providerStatusScope';

export type { ProviderStatusState };

const REFRESH_MS = 60_000;

export class ProviderStatusService {
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _cached: ProviderStatusState | null = null;
  private _cachedOpenAI: ProviderStatusState | null = null;
  private _callback: ((status: ProviderStatusState) => void) | null = null;
  private _openAICallback: ((status: ProviderStatusState) => void) | null = null;

  constructor(private readonly providerId: DashboardProviderId = 'claude-code') {}

  /** Register a callback for Claude status updates. */
  onUpdate(cb: (status: ProviderStatusState) => void): void {
    this._callback = cb;
  }

  /** Register a callback for OpenAI status updates. */
  onOpenAIUpdate(cb: (status: ProviderStatusState) => void): void {
    this._openAICallback = cb;
  }

  /** Whether the active provider has a status page worth polling. */
  get pollsAnything(): boolean {
    return this.providerId === 'claude-code' || this.providerId === 'codex';
  }

  /** Start polling. Fetches immediately, then every 60s. No-op for providers without a status page. */
  start(): void {
    if (this._interval || !this.pollsAnything) return;
    void this._fetchAll();
    this._interval = setInterval(() => void this._fetchAll(), REFRESH_MS);
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
    if (this.providerId === 'claude-code') {
      const claude = await fetchProviderStatus();
      this._cached = claude;
      this._callback?.(claude);
    } else if (this.providerId === 'codex') {
      const openai = await fetchOpenAIStatus();
      this._cachedOpenAI = openai;
      this._openAICallback?.(openai);
    }
  }
}
