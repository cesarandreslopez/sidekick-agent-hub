import type { QuotaProviderId } from './providerIds';

export { QUOTA_PROVIDER_IDS } from './providerIds';
export type { QuotaProviderId } from './providerIds';

/**
 * Stateless quota fetcher for Claude Max subscription usage.
 *
 * Calls the Anthropic OAuth usage endpoint and returns utilization data.
 * Polling / eventing is the caller's responsibility.
 */

export interface QuotaWindow {
  /** Utilization percentage (0–100) */
  utilization: number;
  /** ISO timestamp when the window resets */
  resetsAt: string;
}

export interface CodexResetCredit {
  title?: string;
  status: string;
  resetType?: string;
  expiresAt: string;
  grantedAt?: string;
}

export interface CodexResetCreditsSnapshot {
  availableCount: number;
  totalEarnedCount?: number;
  credits: CodexResetCredit[];
  source?: 'api' | 'cache';
  capturedAt?: string;
}

export interface QuotaState {
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  /** Whether quota data was successfully retrieved */
  available: boolean;
  /** Human-readable error if not available */
  error?: string;
  /** Machine-readable failure classification for unavailable states */
  failureKind?: 'auth' | 'network' | 'rate_limit' | 'server' | 'unknown';
  /** HTTP status code for unavailable API responses */
  httpStatus?: number;
  /** Retry delay in milliseconds when rate-limited */
  retryAfterMs?: number;
  /** Projected 5-hour utilization at reset (percentage, capped at 200) */
  projectedFiveHour?: number;
  /** Projected 7-day utilization at reset (percentage, capped at 200) */
  projectedSevenDay?: number;
  /** Provider that produced this quota sample */
  providerId?: QuotaProviderId;
  /**
   * Source of the sample. `statusline` is the official rate-limit block Claude
   * Code hands to its status-line command; `session` is inferred from session
   * logs; `api` is a live usage-endpoint fetch; `cache` is a persisted snapshot.
   */
  source?: 'api' | 'session' | 'cache' | 'statusline';
  /** ISO timestamp when the sample was captured */
  capturedAt?: string;
  /** Whether the sample is stale cached data */
  stale?: boolean;
  /** Milliseconds between `capturedAt` and the read, when read from a snapshot. */
  ageMs?: number;
  /** Freshness tier derived from `ageMs`; see `classifyQuotaFreshness`. */
  freshness?: QuotaFreshness;
  /** Provider-specific display label for the first window */
  fiveHourLabel?: string;
  /** Provider-specific display label for the second window */
  sevenDayLabel?: string;
  /** Provider-specific rate-limit identifier */
  limitId?: string;
  /** Provider-specific rate-limit display name */
  limitName?: string;
  /** Provider-specific credits snapshot */
  credits?: unknown;
  /** Codex reset credits snapshot from the ChatGPT reset-credit endpoint */
  resetCredits?: CodexResetCreditsSnapshot;
  /** Provider-specific plan type */
  planType?: string;
  /** Provider-specific rate-limit reached reason */
  rateLimitReachedType?: string;
}

interface UsageApiResponse {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const FETCH_TIMEOUT_MS = 10_000;
export const FIVE_HOUR_WINDOW_MS = 5 * 3_600_000;
export const SEVEN_DAY_WINDOW_MS = 7 * 86_400_000;

/** How much to trust a cached quota sample, by age. */
export type QuotaFreshness = 'fresh' | 'aging' | 'stale';

/** A snapshot younger than this is as good as live. */
export const QUOTA_FRESH_MAX_AGE_MS = 5 * 60_000;
/** A snapshot older than this should be labelled as stale wherever it is shown. */
export const QUOTA_AGING_MAX_AGE_MS = 60 * 60_000;

/** Classify a cached sample's age. Non-finite or negative ages count as stale. */
export function classifyQuotaFreshness(ageMs: number | undefined): QuotaFreshness {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return 'stale';
  if (ageMs < QUOTA_FRESH_MAX_AGE_MS) return 'fresh';
  if (ageMs < QUOTA_AGING_MAX_AGE_MS) return 'aging';
  return 'stale';
}

/** Compact age label for status lines and table footers: `just now`, `3m ago`, `2h ago`, `3d ago`. */
export function formatQuotaAge(ageMs: number | undefined): string {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return 'age unknown';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface QuotaProjectionInput {
  utilization: number;
  resetsAt: string;
  windowMs: number;
  capturedAt?: string;
}

/**
 * Projects utilization at end of window based on elapsed time.
 *
 * Formula: `current * (windowDuration / elapsed)`, capped at 200%.
 */
export function projectQuotaWindow(input: QuotaProjectionInput): number | undefined {
  const { utilization, resetsAt, windowMs, capturedAt } = input;
  if (!resetsAt || utilization <= 0 || !Number.isFinite(utilization) || windowMs <= 0)
    return undefined;
  const resetTime = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetTime)) return undefined;

  const capturedTime = capturedAt ? Date.parse(capturedAt) : NaN;
  const now = Number.isFinite(capturedTime) ? capturedTime : Date.now();
  const elapsed = windowMs - (resetTime - now);
  if (elapsed <= 0) return undefined;
  return Math.min(Math.round(utilization * (windowMs / elapsed)), 200);
}

export function withQuotaProjections<T extends QuotaState>(
  state: T,
  options: {
    fiveHourWindowMs?: number;
    sevenDayWindowMs?: number;
    capturedAt?: string;
  } = {},
): T {
  if (!state.available) return state;

  const next = { ...state };
  const capturedAt = options.capturedAt ?? state.capturedAt;

  if (next.projectedFiveHour == null) {
    const projected = projectQuotaWindow({
      utilization: next.fiveHour.utilization,
      resetsAt: next.fiveHour.resetsAt,
      windowMs: options.fiveHourWindowMs ?? FIVE_HOUR_WINDOW_MS,
      capturedAt,
    });
    if (projected !== undefined) next.projectedFiveHour = projected;
  }

  if (next.projectedSevenDay == null) {
    const projected = projectQuotaWindow({
      utilization: next.sevenDay.utilization,
      resetsAt: next.sevenDay.resetsAt,
      windowMs: options.sevenDayWindowMs ?? SEVEN_DAY_WINDOW_MS,
      capturedAt,
    });
    if (projected !== undefined) next.projectedSevenDay = projected;
  }

  return next;
}

type QuotaFailureMeta = Pick<QuotaState, 'failureKind' | 'httpStatus' | 'retryAfterMs'>;

/**
 * Helper to build an unavailable QuotaState.
 */
function unavailableState(error: string, meta: QuotaFailureMeta = {}): QuotaState {
  return {
    fiveHour: { utilization: 0, resetsAt: '' },
    sevenDay: { utilization: 0, resetsAt: '' },
    available: false,
    error,
    ...meta,
  };
}

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isNaN(retryAt)) return undefined;

  return Math.max(retryAt - Date.now(), 0);
}

/**
 * Fetch current quota utilization from the Anthropic OAuth usage API.
 *
 * This is a **single-shot** function — it does not poll. The caller wraps
 * it in a polling loop, VS Code EventEmitter, or CLI interval as needed.
 *
 * @param accessToken - OAuth access token from `readClaudeMaxCredentials()`
 * @returns QuotaState with utilization data and elapsed-time projections
 */
export async function fetchQuota(accessToken: string): Promise<QuotaState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timeout.unref();
  try {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': BETA_HEADER,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status === 401) {
        return unavailableState('Sign in to Claude Code to view quota', {
          failureKind: 'auth',
          httpStatus: res.status,
        });
      }

      if (res.status === 429) {
        return unavailableState(`API error: ${res.status}`, {
          failureKind: 'rate_limit',
          httpStatus: res.status,
          retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
        });
      }

      if (res.status >= 500 && res.status <= 599) {
        return unavailableState(`API error: ${res.status}`, {
          failureKind: 'server',
          httpStatus: res.status,
        });
      }

      return unavailableState(`API error: ${res.status}`, {
        failureKind: 'unknown',
        httpStatus: res.status,
      });
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
      projectedFiveHour: projectQuotaWindow({
        utilization: fiveUtil,
        resetsAt: fiveResetsAt,
        windowMs: FIVE_HOUR_WINDOW_MS,
      }),
      projectedSevenDay: projectQuotaWindow({
        utilization: sevenUtil,
        resetsAt: sevenResetsAt,
        windowMs: SEVEN_DAY_WINDOW_MS,
      }),
    };
  } catch {
    return unavailableState('Network error', { failureKind: 'network' });
  } finally {
    clearTimeout(timeout);
  }
}
