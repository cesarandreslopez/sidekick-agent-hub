/**
 * @fileoverview Service for fetching Claude API status from status.claude.com.
 *
 * Uses sidekick-shared for the stateless status fetcher.
 * Wraps results in VS Code EventEmitter pattern for the dashboard.
 *
 * @module services/ProviderStatusService
 */

import * as vscode from 'vscode';
import { fetchProviderStatus } from 'sidekick-shared';
import type { ProviderStatusState } from 'sidekick-shared';
import { log } from './Logger';

export type { ProviderStatusState };

/**
 * Service for fetching and managing Claude API provider status.
 *
 * Polls status.claude.com (Atlassian Statuspage) every 60s and emits
 * events when the status changes.
 */
export class ProviderStatusService implements vscode.Disposable {
  private readonly _onStatusUpdate = new vscode.EventEmitter<ProviderStatusState>();
  private _cachedStatus: ProviderStatusState | null = null;
  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly REFRESH_INTERVAL_MS = 60_000;

  readonly onStatusUpdate = this._onStatusUpdate.event;

  constructor() {
    this._disposables.push(this._onStatusUpdate);
    log('ProviderStatusService initialized');
  }

  async fetchStatus(): Promise<ProviderStatusState> {
    const state = await fetchProviderStatus();
    this._cachedStatus = state;
    this._onStatusUpdate.fire(state);
    log(`Provider status: ${state.indicator} — ${state.description}`);
    return state;
  }

  getCachedStatus(): ProviderStatusState | null {
    return this._cachedStatus;
  }

  startRefresh(): void {
    if (this._refreshInterval) return;
    this.fetchStatus();
    this._refreshInterval = setInterval(() => this.fetchStatus(), this.REFRESH_INTERVAL_MS);
    log('Provider status refresh started');
  }

  stopRefresh(): void {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
      log('Provider status refresh stopped');
    }
  }

  dispose(): void {
    this.stopRefresh();
    this._disposables.forEach(d => d.dispose());
    log('ProviderStatusService disposed');
  }
}
