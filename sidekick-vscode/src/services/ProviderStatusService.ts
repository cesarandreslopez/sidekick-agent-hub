/** Consumer-owned public status polling, coalescing and cancellation. */
import * as vscode from 'vscode';
import { fetchProviderServiceStatus } from 'sidekick-shared';
import type { AccountProviderId, ProviderServiceStatus } from 'sidekick-shared';
import { log } from './Logger';

export type { ProviderServiceStatus as ProviderStatusState };

export class ProviderStatusService implements vscode.Disposable {
  private readonly _onStatusUpdate = new vscode.EventEmitter<ProviderServiceStatus>();
  private readonly _onOpenAIStatusUpdate = new vscode.EventEmitter<ProviderServiceStatus>();
  private _cachedStatus: ProviderServiceStatus | null = null;
  private _cachedOpenAIStatus: ProviderServiceStatus | null = null;
  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<
    AccountProviderId,
    { controller: AbortController; promise: Promise<ProviderServiceStatus> }
  >();
  readonly onStatusUpdate = this._onStatusUpdate.event;
  readonly onOpenAIStatusUpdate = this._onOpenAIStatusUpdate.event;

  fetchStatus(): Promise<ProviderServiceStatus> {
    return this.fetchOne('claude-code');
  }
  fetchOpenAIStatus(): Promise<ProviderServiceStatus> {
    return this.fetchOne('codex');
  }
  private fetchOne(provider: AccountProviderId): Promise<ProviderServiceStatus> {
    const pending = this.pending.get(provider);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const promise = fetchProviderServiceStatus(provider, { signal: controller.signal })
      .then((state) => {
        if (!controller.signal.aborted) {
          if (provider === 'claude-code') {
            this._cachedStatus = state;
            this._onStatusUpdate.fire(state);
          } else {
            this._cachedOpenAIStatus = state;
            this._onOpenAIStatusUpdate.fire(state);
          }
          log(`${provider} public status: ${state.availability}`);
        }
        return state;
      })
      .finally(() => {
        if (this.pending.get(provider)?.controller === controller) this.pending.delete(provider);
      });
    this.pending.set(provider, { controller, promise });
    return promise;
  }
  private async fetchAll(): Promise<void> {
    await Promise.all([this.fetchStatus(), this.fetchOpenAIStatus()]);
  }
  getCachedStatus(): ProviderServiceStatus | null {
    return this._cachedStatus;
  }
  getCachedOpenAIStatus(): ProviderServiceStatus | null {
    return this._cachedOpenAIStatus;
  }
  startRefresh(): void {
    if (this._refreshInterval) return;
    void this.fetchAll();
    this._refreshInterval = setInterval(() => void this.fetchAll(), 60_000);
  }
  stopRefresh(): void {
    if (this._refreshInterval) clearInterval(this._refreshInterval);
    this._refreshInterval = null;
    for (const { controller } of this.pending.values()) controller.abort();
    this.pending.clear();
  }
  dispose(): void {
    this.stopRefresh();
    this._onStatusUpdate.dispose();
    this._onOpenAIStatusUpdate.dispose();
  }
}
