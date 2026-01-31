/**
 * @fileoverview Service for fetching Claude Max subscription quota information.
 *
 * This service reads the OAuth token from Claude Code CLI credentials and
 * fetches quota usage from the Anthropic API. It emits events for quota
 * updates that can be consumed by the dashboard.
 *
 * @module services/QuotaService
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log, logError } from './Logger';

/**
 * Quota data for a single time window (5-hour or 7-day).
 */
export interface QuotaWindow {
  /** Utilization percentage (0-100) */
  utilization: number;
  /** ISO timestamp when the quota resets */
  resetsAt: string;
}

/**
 * Complete quota state including both time windows.
 */
export interface QuotaState {
  /** 5-hour rolling quota */
  fiveHour: QuotaWindow;
  /** 7-day rolling quota */
  sevenDay: QuotaWindow;
  /** Whether quota data is available (false if no token or API key mode) */
  available: boolean;
  /** Error message if quota fetch failed */
  error?: string;
}

/**
 * Credentials file structure from Claude Code CLI.
 */
interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType?: string;
  };
}

/**
 * API response structure from Anthropic usage endpoint.
 */
interface UsageApiResponse {
  five_hour?: {
    utilization: number;
    resets_at: string;
  };
  seven_day?: {
    utilization: number;
    resets_at: string;
  };
}

/**
 * Service for fetching and managing Claude Max subscription quota.
 *
 * Reads OAuth credentials from Claude Code CLI and fetches quota data
 * from the Anthropic API. Emits events when quota is updated.
 *
 * @example
 * ```typescript
 * const quotaService = new QuotaService();
 * quotaService.onQuotaUpdate(quota => {
 *   console.log(`5-hour: ${quota.fiveHour.utilization}%`);
 * });
 * await quotaService.fetchQuota();
 * ```
 */
export class QuotaService implements vscode.Disposable {
  /** Event emitter for quota updates */
  private readonly _onQuotaUpdate = new vscode.EventEmitter<QuotaState>();

  /** Event emitter for quota errors */
  private readonly _onQuotaError = new vscode.EventEmitter<string>();

  /** Cached quota state */
  private _cachedQuota: QuotaState | null = null;

  /** Refresh interval handle */
  private _refreshInterval: ReturnType<typeof setInterval> | null = null;

  /** Disposables for cleanup */
  private readonly _disposables: vscode.Disposable[] = [];

  /** Refresh interval in milliseconds (30 seconds) */
  private readonly REFRESH_INTERVAL_MS = 30_000;

  /** API endpoint for usage data */
  private readonly USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';

  /** Beta header required for OAuth API */
  private readonly BETA_HEADER = 'oauth-2025-04-20';

  /**
   * Event fired when quota is updated.
   */
  readonly onQuotaUpdate = this._onQuotaUpdate.event;

  /**
   * Event fired when a quota fetch error occurs.
   */
  readonly onQuotaError = this._onQuotaError.event;

  constructor() {
    this._disposables.push(this._onQuotaUpdate);
    this._disposables.push(this._onQuotaError);
    log('QuotaService initialized');
  }

  /**
   * Gets the path to the Claude credentials file.
   * @returns Path to ~/.claude/.credentials.json
   */
  private _getCredentialsPath(): string {
    return path.join(os.homedir(), '.claude', '.credentials.json');
  }

  /**
   * Reads the OAuth access token from Claude Code CLI credentials.
   * @returns Access token or null if not available
   */
  private async _readAccessToken(): Promise<string | null> {
    const credentialsPath = this._getCredentialsPath();

    try {
      if (!fs.existsSync(credentialsPath)) {
        log('Credentials file not found');
        return null;
      }

      const content = await fs.promises.readFile(credentialsPath, 'utf8');
      const credentials: ClaudeCredentials = JSON.parse(content);

      if (!credentials.claudeAiOauth?.accessToken) {
        log('No OAuth token in credentials');
        return null;
      }

      // Check if token is expired
      const expiresAt = credentials.claudeAiOauth.expiresAt;
      if (expiresAt && Date.now() > expiresAt) {
        log('OAuth token expired');
        return null;
      }

      return credentials.claudeAiOauth.accessToken;
    } catch (error) {
      logError('Failed to read credentials', error);
      return null;
    }
  }

  /**
   * Fetches quota data from the Anthropic API.
   * @returns QuotaState with current usage or error state
   */
  async fetchQuota(): Promise<QuotaState> {
    const token = await this._readAccessToken();

    if (!token) {
      const state: QuotaState = {
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
        error: 'No OAuth token available'
      };
      this._cachedQuota = state;
      this._onQuotaUpdate.fire(state);
      return state;
    }

    try {
      const response = await fetch(this.USAGE_API_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': this.BETA_HEADER,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        let errorMessage: string;
        if (response.status === 401) {
          errorMessage = 'Sign in to Claude Code to view quota';
        } else if (response.status === 429) {
          // Rate limited - use cached data if available
          if (this._cachedQuota?.available) {
            log('Rate limited, using cached quota');
            return this._cachedQuota;
          }
          errorMessage = 'Rate limited';
        } else {
          errorMessage = `API error: ${response.status}`;
        }

        const state: QuotaState = {
          fiveHour: { utilization: 0, resetsAt: '' },
          sevenDay: { utilization: 0, resetsAt: '' },
          available: false,
          error: errorMessage
        };
        this._cachedQuota = state;
        this._onQuotaUpdate.fire(state);
        this._onQuotaError.fire(errorMessage);
        return state;
      }

      const data: UsageApiResponse = await response.json();

      const state: QuotaState = {
        fiveHour: {
          utilization: data.five_hour?.utilization ?? 0,
          resetsAt: data.five_hour?.resets_at ?? ''
        },
        sevenDay: {
          utilization: data.seven_day?.utilization ?? 0,
          resetsAt: data.seven_day?.resets_at ?? ''
        },
        available: true
      };

      this._cachedQuota = state;
      this._onQuotaUpdate.fire(state);
      log(`Quota fetched: 5h=${state.fiveHour.utilization.toFixed(1)}%, 7d=${state.sevenDay.utilization.toFixed(1)}%`);

      return state;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Network error';
      logError('Failed to fetch quota', error);

      // Use cached data if available on network error
      if (this._cachedQuota?.available) {
        log('Network error, using cached quota');
        return this._cachedQuota;
      }

      const state: QuotaState = {
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
        error: errorMessage
      };
      this._cachedQuota = state;
      this._onQuotaUpdate.fire(state);
      this._onQuotaError.fire(errorMessage);
      return state;
    }
  }

  /**
   * Gets the cached quota state.
   * @returns Cached quota or null if not available
   */
  getCachedQuota(): QuotaState | null {
    return this._cachedQuota;
  }

  /**
   * Starts periodic quota refresh.
   * Fetches immediately, then refreshes every 30 seconds.
   */
  startRefresh(): void {
    if (this._refreshInterval) {
      return; // Already refreshing
    }

    // Fetch immediately
    this.fetchQuota();

    // Set up periodic refresh
    this._refreshInterval = setInterval(() => {
      this.fetchQuota();
    }, this.REFRESH_INTERVAL_MS);

    log('Quota refresh started');
  }

  /**
   * Stops periodic quota refresh.
   */
  stopRefresh(): void {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
      log('Quota refresh stopped');
    }
  }

  /**
   * Checks if quota data is available (has valid OAuth token).
   * @returns True if quota can be fetched
   */
  async isAvailable(): Promise<boolean> {
    const token = await this._readAccessToken();
    return token !== null;
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    this.stopRefresh();
    this._disposables.forEach(d => d.dispose());
    log('QuotaService disposed');
  }
}
