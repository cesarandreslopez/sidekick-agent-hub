/**
 * @fileoverview Service for fetching Claude Max subscription quota information.
 *
 * Uses sidekick-shared for credential reading and quota fetching.
 * Wraps results in VS Code EventEmitter pattern for the dashboard.
 *
 * @module services/QuotaService
 */

import * as vscode from 'vscode';
import { readClaudeMaxCredentials, fetchQuota } from 'sidekick-shared';
import type { QuotaState, QuotaWindow } from 'sidekick-shared';
import { log } from './Logger';

export type { QuotaWindow, QuotaState };

const NO_CREDENTIALS_ERROR = 'No OAuth token available';

function shouldKeepCachedQuota(state: QuotaState): boolean {
  return !state.available && (state.failureKind === 'network' || state.failureKind === 'rate_limit' || state.failureKind === 'server');
}

/**
 * Service for fetching and managing Claude Max subscription quota.
 *
 * Reads OAuth credentials via sidekick-shared and fetches quota data
 * from the Anthropic API. Emits events when quota is updated.
 */
export class QuotaService implements vscode.Disposable {
  private readonly _onQuotaUpdate = new vscode.EventEmitter<QuotaState>();
  private readonly _onQuotaError = new vscode.EventEmitter<string>();
  private _cachedQuota: QuotaState | null = null;
  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly REFRESH_INTERVAL_MS = 30_000;

  readonly onQuotaUpdate = this._onQuotaUpdate.event;
  readonly onQuotaError = this._onQuotaError.event;

  constructor() {
    this._disposables.push(this._onQuotaUpdate, this._onQuotaError);
    log('QuotaService initialized');
  }

  private _unavailableState(error: string): QuotaState {
    return {
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error,
      failureKind: 'auth',
    };
  }

  async fetchQuota(): Promise<QuotaState> {
    const creds = await readClaudeMaxCredentials();
    if (!creds) {
      const state = this._unavailableState(NO_CREDENTIALS_ERROR);
      this._cachedQuota = state;
      this._onQuotaUpdate.fire(state);
      return state;
    }

    const state = await fetchQuota(creds.accessToken);

    // Keep stale quota only for retryable failures.
    if (shouldKeepCachedQuota(state) && this._cachedQuota?.available) {
      log('Fetch failed, using cached quota');
      return this._cachedQuota;
    }

    this._cachedQuota = state;
    this._onQuotaUpdate.fire(state);

    if (!state.available && state.error) {
      this._onQuotaError.fire(state.error);
    } else if (state.available) {
      log(`Quota fetched: 5h=${state.fiveHour.utilization.toFixed(1)}%${state.projectedFiveHour !== undefined ? ` (proj: ${state.projectedFiveHour.toFixed(0)}%)` : ''}, 7d=${state.sevenDay.utilization.toFixed(1)}%${state.projectedSevenDay !== undefined ? ` (proj: ${state.projectedSevenDay.toFixed(0)}%)` : ''}`);
    }

    return state;
  }

  getCachedQuota(): QuotaState | null {
    return this._cachedQuota;
  }

  startRefresh(): void {
    if (this._refreshInterval) return;
    this.fetchQuota();
    this._refreshInterval = setInterval(() => this.fetchQuota(), this.REFRESH_INTERVAL_MS);
    log('Quota refresh started');
  }

  stopRefresh(): void {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
      log('Quota refresh stopped');
    }
  }

  async isAvailable(): Promise<boolean> {
    const creds = await readClaudeMaxCredentials();
    return creds !== null;
  }

  dispose(): void {
    this.stopRefresh();
    this._disposables.forEach(d => d.dispose());
    log('QuotaService disposed');
  }
}
