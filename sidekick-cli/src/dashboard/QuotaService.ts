/**
 * Subscription quota polling for the TUI dashboard.
 *
 * For Claude Code / Claude Max: reads OAuth token from ~/.claude/.credentials.json
 * and polls the Anthropic usage API every 5 minutes.
 *
 * For Codex: quota comes from rate_limits in FollowEvent (handled by DashboardState).
 *
 * Delegates to the shared QuotaPoller for polling, caching, and backoff.
 */

import { readClaudeMaxCredentials, fetchQuota, QuotaPoller } from 'sidekick-shared';
import type { QuotaState, QuotaWindow } from 'sidekick-shared';

export type { QuotaWindow, QuotaState };

const POLL_INTERVAL_MS = 300_000;
const NO_CREDENTIALS_ERROR = 'No OAuth token available';

function unavailableAuthState(): QuotaState {
  return {
    fiveHour: { utilization: 0, resetsAt: '' },
    sevenDay: { utilization: 0, resetsAt: '' },
    available: false,
    error: NO_CREDENTIALS_ERROR,
    failureKind: 'auth',
  };
}

export class QuotaService {
  private _poller: QuotaPoller;
  private _callback: ((quota: QuotaState) => void) | null = null;

  constructor() {
    this._poller = new QuotaPoller({
      activeIntervalMs: POLL_INTERVAL_MS,
      idleIntervalMs: POLL_INTERVAL_MS,
      getAccessToken: async () => {
        const creds = await readClaudeMaxCredentials();
        if (!creds) throw new Error(NO_CREDENTIALS_ERROR);
        return creds.accessToken;
      },
    });

    this._poller.onUpdate((state) => {
      this._callback?.(state);
    });
  }

  /** Register a callback for quota updates. */
  onUpdate(cb: (quota: QuotaState) => void): void {
    this._callback = cb;
  }

  /** Start polling. Fetches immediately, then every 5 minutes. */
  start(): void {
    this._poller.start();
  }

  /** Stop polling. */
  stop(): void {
    this._poller.stop();
  }

  /** Get the last fetched quota state. */
  getCached(): QuotaState | null {
    return this._poller.getLatest();
  }

  /** Single fetch — no polling, includes elapsed-time projections. */
  async fetchOnce(): Promise<QuotaState> {
    const creds = await readClaudeMaxCredentials();
    if (!creds) {
      return unavailableAuthState();
    }
    return fetchQuota(creds.accessToken);
  }
}
