/**
 * @fileoverview Service for fetching provider API status from status pages.
 *
 * Uses sidekick-shared for the stateless status fetchers.
 * Polls both status.claude.com and status.openai.com in parallel.
 * Wraps results in VS Code EventEmitter pattern for the dashboard.
 *
 * @module services/ProviderStatusService
 */

import * as vscode from 'vscode';
import { fetchProviderStatus, fetchOpenAIStatus } from 'sidekick-shared';
import type { ProviderStatusState } from 'sidekick-shared';
import { log } from './Logger';

export type { ProviderStatusState };

/**
 * Service for fetching and managing provider API status.
 *
 * Polls status.claude.com and status.openai.com (Atlassian Statuspage)
 * every 60s and emits events when the status changes.
 */
export class ProviderStatusService implements vscode.Disposable {
  private readonly _onStatusUpdate = new vscode.EventEmitter<ProviderStatusState>();
  private readonly _onOpenAIStatusUpdate = new vscode.EventEmitter<ProviderStatusState>();
  private _cachedStatus: ProviderStatusState | null = null;
  private _cachedOpenAIStatus: ProviderStatusState | null = null;
  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly REFRESH_INTERVAL_MS = 60_000;

  readonly onStatusUpdate = this._onStatusUpdate.event;
  readonly onOpenAIStatusUpdate = this._onOpenAIStatusUpdate.event;

  constructor() {
    this._disposables.push(this._onStatusUpdate, this._onOpenAIStatusUpdate);
    log('ProviderStatusService initialized');
  }

  async fetchStatus(): Promise<ProviderStatusState> {
    const state = await fetchProviderStatus();
    this._cachedStatus = state;
    this._onStatusUpdate.fire(state);
    log(`Claude status: ${state.indicator} — ${state.description}`);
    return state;
  }

  async fetchOpenAIStatus(): Promise<ProviderStatusState> {
    const state = await fetchOpenAIStatus();
    this._cachedOpenAIStatus = state;
    this._onOpenAIStatusUpdate.fire(state);
    log(`OpenAI status: ${state.indicator} — ${state.description}`);
    return state;
  }

  private fetchAll(): void {
    this.fetchStatus();
    this.fetchOpenAIStatus();
  }

  getCachedStatus(): ProviderStatusState | null {
    return this._cachedStatus;
  }

  getCachedOpenAIStatus(): ProviderStatusState | null {
    return this._cachedOpenAIStatus;
  }

  startRefresh(): void {
    if (this._refreshInterval) return;
    this.fetchAll();
    this._refreshInterval = setInterval(() => this.fetchAll(), this.REFRESH_INTERVAL_MS);
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
