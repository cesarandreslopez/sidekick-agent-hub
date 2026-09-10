/** Consumer-owned polling for the active session provider's public status. */
import { fetchProviderServiceStatus } from 'sidekick-shared';
import type { ProviderServiceStatus } from 'sidekick-shared';
import type { DashboardProviderId } from './providerStatusScope';

export type { ProviderServiceStatus as ProviderStatusState };
const REFRESH_MS = 60_000;

export class ProviderStatusService {
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _controller: AbortController | null = null;
  private _cached: ProviderServiceStatus | null = null;
  private _cachedOpenAI: ProviderServiceStatus | null = null;
  private _callback: ((status: ProviderServiceStatus) => void) | null = null;
  private _openAICallback: ((status: ProviderServiceStatus) => void) | null = null;

  constructor(private readonly providerId: DashboardProviderId = 'claude-code') {}
  onUpdate(cb: (status: ProviderServiceStatus) => void): void {
    this._callback = cb;
  }
  onOpenAIUpdate(cb: (status: ProviderServiceStatus) => void): void {
    this._openAICallback = cb;
  }
  get pollsAnything(): boolean {
    return this.providerId !== 'opencode';
  }
  start(): void {
    if (this._interval || !this.pollsAnything) return;
    void this._fetchAll();
    this._interval = setInterval(() => void this._fetchAll(), REFRESH_MS);
  }
  stop(): void {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    this._controller?.abort();
    this._controller = null;
  }
  getCached(): ProviderServiceStatus | null {
    return this._cached;
  }
  getCachedOpenAI(): ProviderServiceStatus | null {
    return this._cachedOpenAI;
  }
  async fetchOnce(): Promise<ProviderServiceStatus | null> {
    return this.providerId === 'opencode' ? null : fetchProviderServiceStatus(this.providerId);
  }
  private async _fetchAll(): Promise<void> {
    if (this._controller || this.providerId === 'opencode') return;
    const controller = new AbortController();
    this._controller = controller;
    try {
      const result = await fetchProviderServiceStatus(this.providerId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || this._controller !== controller) return;
      if (this.providerId === 'claude-code') {
        this._cached = result;
        this._callback?.(result);
      } else {
        this._cachedOpenAI = result;
        this._openAICallback?.(result);
      }
    } finally {
      if (this._controller === controller) this._controller = null;
    }
  }
}
