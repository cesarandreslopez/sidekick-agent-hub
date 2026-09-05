/**
 * Stateless peak-hours fetcher for promoclock.co.
 *
 * PromoClock is a free, third-party tracker (maintained by @onursendere,
 * not affiliated with Anthropic) that reports whether Claude's session
 * limits are draining at normal or faster rate. Peak window is weekdays
 * 13:00–19:00 UTC; session limits drain faster during that window for
 * Free / Pro / Max / Team subscriptions.
 *
 * Polling / eventing is the caller's responsibility.
 */

import type { ProviderId } from './providers/types';

export interface PeakHoursState {
  status: 'peak' | 'off_peak' | 'unknown';
  isPeak: boolean;
  sessionLimitSpeed: 'normal' | 'faster' | 'unknown';
  label: string;
  peakHoursDescription: string;
  nextChange: string | null;
  minutesUntilChange: number | null;
  note: string;
  updatedAt: string;
  unavailable: boolean;
  notApplicable?: boolean;
  /**
   * `promoclock` when the state came from promoclock.co, `schedule` when it
   * was computed locally from the published weekday window. Absent on the
   * not-applicable and unavailable placeholder states.
   */
  source?: 'promoclock' | 'schedule';
}

interface PromoClockResponse {
  status?: string;
  isPeak?: boolean;
  sessionLimitSpeed?: string;
  label?: string;
  peakHours?: string;
  nextChange?: string | null;
  minutesUntilChange?: number | null;
  note?: string;
  timestamp?: string;
}

const PROMOCLOCK_ENDPOINT = 'https://promoclock.co/api/status';

/**
 * Default budget for the promoclock.co request, in milliseconds. The schedule
 * fallback answers the question anyway, so a slow third-party host should not
 * hold up a `sidekick status` or `sidekick quota` run for long.
 */
export const DEFAULT_PEAK_HOURS_TIMEOUT_MS = 4_000;
/** A promoclock.co answer is reused for this long before the host is asked again. */
export const PEAK_HOURS_CACHE_MS = 10 * 60_000;

/** Published peak window: weekdays 13:00–19:00 UTC. */
export const PEAK_WINDOW_START_UTC_HOUR = 13;
export const PEAK_WINDOW_END_UTC_HOUR = 19;
export const PEAK_HOURS_DESCRIPTION = 'Weekdays 13:00–19:00 UTC';

let cachedNetworkState: { state: PeakHoursState; fetchedAt: number } | null = null;

/** Forget the cached promoclock.co answer. Test-only. */
export function _resetPeakHoursCache(): void {
  cachedNetworkState = null;
}

function isWeekdayUtc(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

function utcDateAtHour(date: Date, hour: number, dayOffset = 0): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + dayOffset, hour),
  );
}

/**
 * Peak-hours state computed from the published schedule alone, with no
 * network access. Used directly by cache-only commands (`sidekick today`) and
 * as the fallback when promoclock.co cannot be reached, so every surface
 * agrees on whether it is currently peak.
 */
export function getScheduledPeakHoursState(now: Date = new Date()): PeakHoursState {
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const isPeak =
    isWeekdayUtc(now) && hour >= PEAK_WINDOW_START_UTC_HOUR && hour < PEAK_WINDOW_END_UTC_HOUR;

  let nextChange: Date;
  if (isPeak) {
    nextChange = utcDateAtHour(now, PEAK_WINDOW_END_UTC_HOUR);
  } else if (isWeekdayUtc(now) && hour < PEAK_WINDOW_START_UTC_HOUR) {
    nextChange = utcDateAtHour(now, PEAK_WINDOW_START_UTC_HOUR);
  } else {
    let offset = 1;
    while (!isWeekdayUtc(utcDateAtHour(now, 0, offset))) offset += 1;
    nextChange = utcDateAtHour(now, PEAK_WINDOW_START_UTC_HOUR, offset);
  }

  return {
    status: isPeak ? 'peak' : 'off_peak',
    isPeak,
    sessionLimitSpeed: isPeak ? 'faster' : 'normal',
    label: isPeak ? 'Peak Hours' : 'Off-Peak',
    peakHoursDescription: PEAK_HOURS_DESCRIPTION,
    nextChange: nextChange.toISOString(),
    minutesUntilChange: Math.max(0, Math.round((nextChange.getTime() - now.getTime()) / 60_000)),
    note: 'Computed from the published weekday schedule.',
    updatedAt: now.toISOString(),
    unavailable: false,
    source: 'schedule',
  };
}

/** Options for {@link fetchPeakHoursStatus}. */
export interface FetchPeakHoursOptions {
  /**
   * Abort the request after this many milliseconds.
   * Defaults to {@link DEFAULT_PEAK_HOURS_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /** Bypass the in-process cache and ask promoclock.co again. */
  force?: boolean;
}

function unavailableState(): PeakHoursState {
  return {
    status: 'unknown',
    isPeak: false,
    sessionLimitSpeed: 'unknown',
    label: 'Peak-hours status unavailable',
    peakHoursDescription: '',
    nextChange: null,
    minutesUntilChange: null,
    note: '',
    updatedAt: new Date().toISOString(),
    unavailable: true,
  };
}

const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex CLI',
};

export function isClaudeCodeSessionProvider(providerId: ProviderId): boolean {
  return providerId === 'claude-code';
}

export function createPeakHoursNotApplicableState(providerId: ProviderId): PeakHoursState {
  const providerName = PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;
  return {
    status: 'unknown',
    isPeak: false,
    sessionLimitSpeed: 'unknown',
    label: 'Claude peak hours not applicable',
    peakHoursDescription: '',
    nextChange: null,
    minutesUntilChange: null,
    note: `Claude peak hours apply only to Claude Code sessions, not ${providerName}.`,
    updatedAt: new Date().toISOString(),
    unavailable: true,
    notApplicable: true,
  };
}

export function scopePeakHoursToSessionProvider(
  providerId: ProviderId,
  status: PeakHoursState | null | undefined,
): PeakHoursState | null {
  if (!isClaudeCodeSessionProvider(providerId)) return null;
  return status ?? null;
}

function normalizeStatus(raw: string | undefined): PeakHoursState['status'] {
  if (raw === 'peak' || raw === 'off_peak') return raw;
  return 'unknown';
}

function normalizeSpeed(raw: string | undefined): PeakHoursState['sessionLimitSpeed'] {
  if (raw === 'normal' || raw === 'faster') return raw;
  return 'unknown';
}

/**
 * Fetch current Claude peak-hours state from promoclock.co.
 *
 * Single-shot — caller wraps in polling loop, EventEmitter, or interval.
 * A successful answer is cached in-process for {@link PEAK_HOURS_CACHE_MS}.
 * On any network, timeout, or parse error the state is computed from the
 * published schedule instead (`source: 'schedule'`), so callers always get a
 * usable answer and every surface agrees on it; {@link unavailableState} is
 * only returned when the schedule itself cannot be evaluated.
 *
 * promoclock.co is a third-party host, so the request is always bounded by
 * an abort timeout. Without one a hung host would stall the caller — and
 * this is polled, so the stall would repeat.
 */
export async function fetchPeakHoursStatus(
  options: FetchPeakHoursOptions = {},
): Promise<PeakHoursState> {
  const now = Date.now();
  if (
    !options.force &&
    cachedNetworkState &&
    now - cachedNetworkState.fetchedAt < PEAK_HOURS_CACHE_MS
  ) {
    return cachedNetworkState.state;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PEAK_HOURS_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    const res = await fetch(PROMOCLOCK_ENDPOINT, { signal: controller.signal });
    if (!res.ok) return scheduleFallback();

    const data: PromoClockResponse = await res.json();

    const status = normalizeStatus(data.status);
    const sessionLimitSpeed = normalizeSpeed(data.sessionLimitSpeed);
    const isPeak = typeof data.isPeak === 'boolean' ? data.isPeak : status === 'peak';

    const state: PeakHoursState = {
      status,
      isPeak,
      sessionLimitSpeed,
      label: data.label ?? (isPeak ? 'Peak Hours' : 'Off-Peak'),
      peakHoursDescription: data.peakHours ?? '',
      nextChange: data.nextChange ?? null,
      minutesUntilChange:
        typeof data.minutesUntilChange === 'number' ? data.minutesUntilChange : null,
      note: data.note ?? '',
      updatedAt: data.timestamp ?? new Date().toISOString(),
      unavailable: false,
      source: 'promoclock',
    };
    cachedNetworkState = { state, fetchedAt: now };
    return state;
  } catch {
    // Covers AbortError from the timeout above alongside network/parse failures.
    return scheduleFallback();
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleFallback(): PeakHoursState {
  try {
    const state = getScheduledPeakHoursState();
    return {
      ...state,
      note: 'promoclock.co unreachable; computed from the published weekday schedule.',
    };
  } catch {
    return unavailableState();
  }
}
