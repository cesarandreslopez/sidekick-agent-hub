/**
 * Subscription quota polling for the TUI dashboard.
 *
 * For Claude Code / Claude Max: reads OAuth token from ~/.claude/.credentials.json
 * and polls the Anthropic usage API every 30s.
 *
 * For Codex: quota comes from rate_limits in FollowEvent (handled by DashboardState).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ──

export interface QuotaWindow {
  utilization: number;   // 0-100
  resetsAt: string;      // ISO timestamp
}

export interface QuotaState {
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  available: boolean;
  error?: string;
  projectedFiveHour?: number;
  projectedSevenDay?: number;
}

interface UsageApiResponse {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
}

// ── Service ──

const REFRESH_MS = 30_000;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const FIVE_HOUR_MS = 5 * 3_600_000;
const SEVEN_DAY_MS = 7 * 86_400_000;

export class QuotaService {
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _cached: QuotaState | null = null;
  private _callback: ((quota: QuotaState) => void) | null = null;

  /** Register a callback for quota updates. */
  onUpdate(cb: (quota: QuotaState) => void): void {
    this._callback = cb;
  }

  /** Start polling. Fetches immediately, then every 30s. */
  start(): void {
    if (this._interval) return;
    this.fetchQuota();
    this._interval = setInterval(() => this.fetchQuota(), REFRESH_MS);
  }

  /** Stop polling. */
  stop(): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /** Get the last fetched quota state. */
  getCached(): QuotaState | null {
    return this._cached;
  }

  /** Single fetch — no polling, includes elapsed-time projections. */
  async fetchOnce(): Promise<QuotaState> {
    const token = await this.readToken();
    if (!token) {
      return { fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' }, available: false, error: 'no-credentials' };
    }

    try {
      const res = await fetch(USAGE_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': BETA_HEADER,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const error = res.status === 401 ? 'auth-failed' : `API error: ${res.status}`;
        return { fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' }, available: false, error };
      }

      const data: UsageApiResponse = await res.json();
      const fiveUtil = data.five_hour?.utilization ?? 0;
      const sevenUtil = data.seven_day?.utilization ?? 0;
      const fiveResetsAt = data.five_hour?.resets_at ?? '';
      const sevenResetsAt = data.seven_day?.resets_at ?? '';
      return {
        fiveHour: { utilization: fiveUtil, resetsAt: fiveResetsAt },
        sevenDay: { utilization: sevenUtil, resetsAt: sevenResetsAt },
        available: true,
        projectedFiveHour: this.projectFromElapsed(fiveUtil, fiveResetsAt, FIVE_HOUR_MS),
        projectedSevenDay: this.projectFromElapsed(sevenUtil, sevenResetsAt, SEVEN_DAY_MS),
      };
    } catch {
      return { fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' }, available: false, error: 'network-error' };
    }
  }

  async fetchQuota(): Promise<void> {
    const token = await this.readToken();
    if (!token) {
      this.emit({ fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' }, available: false });
      return;
    }

    try {
      const res = await fetch(USAGE_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': BETA_HEADER,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        if (res.status === 429 && this._cached?.available) return; // rate limited, keep cache
        this.emit({
          fiveHour: { utilization: 0, resetsAt: '' },
          sevenDay: { utilization: 0, resetsAt: '' },
          available: false,
          error: res.status === 401 ? 'Sign in to Claude Code to view quota' : `API error: ${res.status}`,
        });
        return;
      }

      const data: UsageApiResponse = await res.json();
      const fiveUtil = data.five_hour?.utilization ?? 0;
      const sevenUtil = data.seven_day?.utilization ?? 0;
      const fiveResetsAt = data.five_hour?.resets_at ?? '';
      const sevenResetsAt = data.seven_day?.resets_at ?? '';

      this.emit({
        fiveHour: { utilization: fiveUtil, resetsAt: fiveResetsAt },
        sevenDay: { utilization: sevenUtil, resetsAt: sevenResetsAt },
        available: true,
        projectedFiveHour: this.projectFromElapsed(fiveUtil, fiveResetsAt, FIVE_HOUR_MS),
        projectedSevenDay: this.projectFromElapsed(sevenUtil, sevenResetsAt, SEVEN_DAY_MS),
      });
    } catch {
      if (this._cached?.available) return; // network error, keep cache
      this.emit({ fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' }, available: false, error: 'Network error' });
    }
  }

  private emit(state: QuotaState): void {
    this._cached = state;
    this._callback?.(state);
  }

  private async readToken(): Promise<string | null> {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    try {
      if (!fs.existsSync(credPath)) return null;
      const content = await fs.promises.readFile(credPath, 'utf8');
      const creds = JSON.parse(content);
      const oauth = creds?.claudeAiOauth;
      if (!oauth?.accessToken) return null;
      if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
      return oauth.accessToken;
    } catch {
      return null;
    }
  }

  private projectFromElapsed(utilization: number, resetsAt: string, windowMs: number): number | undefined {
    if (!resetsAt || utilization <= 0) return undefined;
    const resetTime = new Date(resetsAt).getTime();
    const now = Date.now();
    const elapsed = windowMs - (resetTime - now);
    if (elapsed <= 0) return undefined;
    return Math.min(Math.round(utilization * (windowMs / elapsed)), 200);
  }
}
