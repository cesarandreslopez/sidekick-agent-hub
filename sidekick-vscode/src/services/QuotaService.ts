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
  /** Projected 5-hour utilization at reset time (percentage) */
  projectedFiveHour?: number;
  /** Projected 7-day utilization at reset time (percentage) */
  projectedSevenDay?: number;
}

/**
 * A single utilization reading with timestamp.
 */
interface UtilizationReading {
  /** Utilization percentage (0-100) */
  utilization: number;
  /** Unix timestamp in milliseconds */
  timestamp: number;
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

  /** History of 5-hour utilization readings for rate calculation */
  private _fiveHourHistory: UtilizationReading[] = [];

  /** History of 7-day utilization readings for rate calculation */
  private _sevenDayHistory: UtilizationReading[] = [];

  /** Maximum history entries to keep (10 readings = ~5 minutes at 30s intervals) */
  private readonly MAX_HISTORY_SIZE = 10;

  /**
   * Event fired when quota is updated.
   */
  readonly onQuotaUpdate = this._onQuotaUpdate.event;

  /**
   * Event fired when a quota fetch error occurs.
   */
  readonly onQuotaError = this._onQuotaError.event;

  constructor() {
    this._disposables.push(this._onQuotaUpdate, this._onQuotaError);
    log('QuotaService initialized');
  }

  /**
   * Creates an unavailable QuotaState with an error message.
   */
  private _unavailableState(error: string): QuotaState {
    return {
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error,
    };
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
      const state = this._unavailableState('No OAuth token available');
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

        const state = this._unavailableState(errorMessage);
        this._cachedQuota = state;
        this._onQuotaUpdate.fire(state);
        this._onQuotaError.fire(errorMessage);
        return state;
      }

      const data: UsageApiResponse = await response.json();

      // Extract current utilization values
      const fiveHourUtil = data.five_hour?.utilization ?? 0;
      const sevenDayUtil = data.seven_day?.utilization ?? 0;

      // Track history and calculate projections
      this._addToHistory(this._fiveHourHistory, fiveHourUtil);
      this._addToHistory(this._sevenDayHistory, sevenDayUtil);

      const fiveHourResetsAt = data.five_hour?.resets_at ?? '';
      const sevenDayResetsAt = data.seven_day?.resets_at ?? '';

      const projectedFiveHour = this._calculateProjection(
        fiveHourUtil, fiveHourResetsAt, this._calculateRate(this._fiveHourHistory)
      );
      const projectedSevenDay = this._calculateProjection(
        sevenDayUtil, sevenDayResetsAt, this._calculateRate(this._sevenDayHistory)
      );

      const state: QuotaState = {
        fiveHour: { utilization: fiveHourUtil, resetsAt: fiveHourResetsAt },
        sevenDay: { utilization: sevenDayUtil, resetsAt: sevenDayResetsAt },
        available: true,
        projectedFiveHour,
        projectedSevenDay
      };

      this._cachedQuota = state;
      this._onQuotaUpdate.fire(state);
      log(`Quota fetched: 5h=${state.fiveHour.utilization.toFixed(1)}%${projectedFiveHour !== undefined ? ` (proj: ${projectedFiveHour.toFixed(0)}%)` : ''}, 7d=${state.sevenDay.utilization.toFixed(1)}%${projectedSevenDay !== undefined ? ` (proj: ${projectedSevenDay.toFixed(0)}%)` : ''}`);

      return state;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Network error';
      logError('Failed to fetch quota', error);

      // Use cached data if available on network error
      if (this._cachedQuota?.available) {
        log('Network error, using cached quota');
        return this._cachedQuota;
      }

      const state = this._unavailableState(errorMessage);
      this._cachedQuota = state;
      this._onQuotaUpdate.fire(state);
      this._onQuotaError.fire(errorMessage);
      return state;
    }
  }

  /**
   * Adds a utilization reading to history and maintains max size.
   * @param history - The history array to update
   * @param utilization - Current utilization percentage
   */
  private _addToHistory(history: UtilizationReading[], utilization: number): void {
    history.push({
      utilization,
      timestamp: Date.now()
    });

    // Keep only the most recent readings
    while (history.length > this.MAX_HISTORY_SIZE) {
      history.shift();
    }
  }

  /**
   * Calculates utilization rate from history (% per minute).
   * @param history - The history array to analyze
   * @returns Rate in % per minute, or null if insufficient data
   */
  private _calculateRate(history: UtilizationReading[]): number | null {
    if (history.length < 2) {
      return null;
    }

    const oldest = history[0];
    const newest = history[history.length - 1];

    const timeDiffMs = newest.timestamp - oldest.timestamp;
    if (timeDiffMs < 30_000) {
      // Need at least 30 seconds of data for meaningful rate
      return null;
    }

    const utilizationDiff = newest.utilization - oldest.utilization;
    if (utilizationDiff <= 0) {
      // Rate is zero or negative (quota reset happened)
      return 0;
    }

    // Convert to % per minute
    const timeDiffMinutes = timeDiffMs / 60_000;
    return utilizationDiff / timeDiffMinutes;
  }

  /**
   * Calculates projected utilization at reset time.
   * @param currentUtilization - Current utilization percentage
   * @param resetsAt - ISO timestamp of reset time
   * @param rate - Utilization rate in % per minute
   * @returns Projected utilization at reset, or undefined if cannot project
   */
  private _calculateProjection(
    currentUtilization: number,
    resetsAt: string,
    rate: number | null
  ): number | undefined {
    if (rate === null || rate <= 0 || !resetsAt) {
      return undefined;
    }

    const resetTime = new Date(resetsAt).getTime();
    const now = Date.now();
    const timeToResetMs = resetTime - now;

    if (timeToResetMs <= 0) {
      return undefined;
    }

    const timeToResetMinutes = timeToResetMs / 60_000;
    const projected = currentUtilization + (rate * timeToResetMinutes);

    return Math.min(projected, 200); // Cap at 200% to avoid absurd numbers
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
