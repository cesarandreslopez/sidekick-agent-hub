/**
 * @fileoverview Service for fetching Claude peak-hours state from promoclock.co.
 *
 * Uses sidekick-shared for the stateless fetcher.
 * Polls every 15 minutes (peak transitions happen on UTC-hour boundaries).
 * Gated on the `claude-max` inference provider — no network requests when
 * the user is on Claude API, OpenCode, or Codex.
 *
 * @module services/PeakHoursService
 */

import * as vscode from 'vscode';
import { fetchPeakHoursStatus } from 'sidekick-shared';
import type { PeakHoursState } from 'sidekick-shared';
import type { AuthService } from './AuthService';
import { log } from './Logger';

export type { PeakHoursState };

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Service for fetching and managing Claude peak-hours state.
 *
 * Emits events when the state changes. Returns `null` via
 * `getCachedStatus()` when polling is disabled or gated off.
 */
export class PeakHoursService implements vscode.Disposable {
  private readonly _onStatusUpdate = new vscode.EventEmitter<PeakHoursState | null>();
  private _cachedStatus: PeakHoursState | null = null;
  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly _disposables: vscode.Disposable[] = [];

  readonly onStatusUpdate = this._onStatusUpdate.event;

  constructor(private readonly authService: AuthService) {
    this._disposables.push(this._onStatusUpdate);

    // React to provider changes so we stop polling when switching away from
    // claude-max, and clear any stale cached state from the UI.
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidekick.inferenceProvider')
          || e.affectsConfiguration('sidekick.peakHours.enabled')) {
          this.reconcile();
        }
      }),
    );

    log('PeakHoursService initialized');
  }

  /** Whether the user's current configuration makes peak-hours relevant. */
  private isApplicable(): boolean {
    if (!this.isEnabledInSettings()) return false;
    return this.authService.getProviderId() === 'claude-max';
  }

  private isEnabledInSettings(): boolean {
    return vscode.workspace
      .getConfiguration('sidekick.peakHours')
      .get<boolean>('enabled', true);
  }

  async fetchStatus(): Promise<PeakHoursState | null> {
    if (!this.isApplicable()) {
      if (this._cachedStatus !== null) {
        this._cachedStatus = null;
        this._onStatusUpdate.fire(null);
      }
      return null;
    }
    const previous = this._cachedStatus;
    const state = await fetchPeakHoursStatus();
    this._cachedStatus = state;
    this._onStatusUpdate.fire(state);
    log(`Peak hours: ${state.status} (${state.label})`);
    this.maybeNotifyTransition(previous, state);
    return state;
  }

  private maybeNotifyTransition(
    previous: PeakHoursState | null,
    current: PeakHoursState,
  ): void {
    if (current.unavailable) return;
    const notifyEnabled = vscode.workspace
      .getConfiguration('sidekick.peakHours')
      .get<boolean>('notifyOnTransition', false);
    if (!notifyEnabled) return;

    // Skip the first fetch after start/provider-switch — a transition requires
    // a prior known state. This avoids notifying on launch.
    if (!previous || previous.unavailable || previous.status === 'unknown') return;
    if (previous.isPeak === current.isPeak) return;

    if (current.isPeak) {
      vscode.window.showInformationMessage(
        `Claude peak hours started — session limits drain faster. ${current.peakHoursDescription}`,
      );
    } else {
      vscode.window.showInformationMessage(
        'Claude off-peak — session limits back to normal speed.',
      );
    }
  }

  getCachedStatus(): PeakHoursState | null {
    return this._cachedStatus;
  }

  startRefresh(): void {
    if (!this.isApplicable()) return;
    if (this._refreshInterval) return;
    this.fetchStatus();
    this._refreshInterval = setInterval(() => {
      this.fetchStatus();
    }, REFRESH_INTERVAL_MS);
    log('Peak hours refresh started');
  }

  stopRefresh(): void {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
      log('Peak hours refresh stopped');
    }
  }

  /**
   * Bring the service in line with the current provider + settings. Called
   * when either changes while the dashboard may already be visible.
   */
  private reconcile(): void {
    if (this.isApplicable()) {
      // Re-fetch immediately if the dashboard is already running us.
      if (this._refreshInterval) {
        this.fetchStatus();
      }
    } else {
      this.stopRefresh();
      if (this._cachedStatus !== null) {
        this._cachedStatus = null;
        this._onStatusUpdate.fire(null);
      }
    }
  }

  dispose(): void {
    this.stopRefresh();
    this._disposables.forEach((d) => d.dispose());
    log('PeakHoursService disposed');
  }
}
