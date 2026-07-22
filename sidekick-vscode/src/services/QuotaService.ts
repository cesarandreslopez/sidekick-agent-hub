/**
 * @fileoverview Service for fetching Claude Max subscription quota information.
 *
 * Uses sidekick-shared for credential reading and quota fetching.
 * Wraps results in VS Code EventEmitter pattern for the dashboard.
 *
 * @module services/QuotaService
 */

import * as vscode from 'vscode';
import {
  readClaudeMaxCredentials,
  fetchQuota,
  appendQuotaHistorySample,
  getActiveSavedAccount,
  QuotaPoller,
} from 'sidekick-shared';
import type { QuotaState, QuotaWindow } from 'sidekick-shared';
import { log } from './Logger';
import { getWorkspaceId } from '../utils/workspaceId';

export type { QuotaWindow, QuotaState };

const NO_CREDENTIALS_ERROR = 'No OAuth token available';

function shouldKeepCachedQuota(state: QuotaState): boolean {
  return (
    !state.available &&
    (state.failureKind === 'network' ||
      state.failureKind === 'rate_limit' ||
      state.failureKind === 'server')
  );
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
  private readonly _poller: QuotaPoller;
  private _refreshing = false;
  private readonly _disposables: vscode.Disposable[] = [];

  readonly onQuotaUpdate = this._onQuotaUpdate.event;
  readonly onQuotaError = this._onQuotaError.event;

  constructor() {
    this._disposables.push(this._onQuotaUpdate, this._onQuotaError);
    this._poller = new QuotaPoller({
      activeIntervalMs: 300_000,
      idleIntervalMs: 300_000,
      getAccessToken: async () => {
        const creds = await readClaudeMaxCredentials();
        if (!creds) throw new Error(NO_CREDENTIALS_ERROR);
        return creds.accessToken;
      },
    });
    this._disposables.push(this._poller.onUpdate((state) => this._handleQuotaState(state)));
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
      this._handleQuotaState(state);
      return state;
    }

    const state = await fetchQuota(creds.accessToken);

    // Keep stale quota only for retryable failures.
    if (shouldKeepCachedQuota(state) && this._cachedQuota?.available) {
      log('Fetch failed, using cached quota');
      const cachedState: QuotaState = {
        ...this._cachedQuota,
        error: state.error,
        failureKind: state.failureKind,
        httpStatus: state.httpStatus,
        retryAfterMs: state.retryAfterMs,
        source: 'cache',
        stale: true,
      };
      this._handleQuotaState(cachedState);
      return cachedState;
    }

    this._handleQuotaState(state);

    return state;
  }

  private _handleQuotaState(state: QuotaState): void {
    const normalizedState: QuotaState =
      state.available && state.error
        ? { ...state, source: state.source ?? 'cache', stale: true }
        : state;
    this._cachedQuota = normalizedState;
    this._onQuotaUpdate.fire(normalizedState);
    this._recordHistorySample(normalizedState);

    if (normalizedState.error) {
      this._onQuotaError.fire(normalizedState.error);
    } else if (normalizedState.available) {
      log(
        `Quota fetched: 5h=${normalizedState.fiveHour.utilization.toFixed(1)}%${normalizedState.projectedFiveHour !== undefined ? ` (proj: ${normalizedState.projectedFiveHour.toFixed(0)}%)` : ''}, 7d=${normalizedState.sevenDay.utilization.toFixed(1)}%${normalizedState.projectedSevenDay !== undefined ? ` (proj: ${normalizedState.projectedSevenDay.toFixed(0)}%)` : ''}`,
      );
    }
  }

  getCachedQuota(): QuotaState | null {
    return this._cachedQuota;
  }

  startRefresh(): void {
    if (this._refreshing) return;
    this._refreshing = true;
    this._poller.start();
    log('Quota refresh started');
  }

  stopRefresh(): void {
    if (this._refreshing) {
      this._poller.stop();
      this._refreshing = false;
      log('Quota refresh stopped');
    }
  }

  private _recordHistorySample(state: QuotaState): void {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) return;
    const account = getActiveSavedAccount('claude-code');
    if (!account) return;
    void appendQuotaHistorySample({
      timestamp: state.capturedAt ?? new Date().toISOString(),
      runtimeProvider: 'claude',
      providerId: account.id,
      workspaceId,
      fiveHour: { utilization: state.fiveHour.utilization, resetsAt: state.fiveHour.resetsAt },
      sevenDay: { utilization: state.sevenDay.utilization, resetsAt: state.sevenDay.resetsAt },
      available: state.available,
      error: state.error,
      source: state.source,
      stale: state.stale,
    }).catch((err) =>
      log(`Quota history append failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  async isAvailable(): Promise<boolean> {
    const creds = await readClaudeMaxCredentials();
    return creds !== null;
  }

  dispose(): void {
    this.stopRefresh();
    this._poller.stop();
    this._disposables.forEach((d) => d.dispose());
    log('QuotaService disposed');
  }
}
