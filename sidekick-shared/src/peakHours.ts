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
 * Returns `unavailable: true` on any network or parse error.
 */
export async function fetchPeakHoursStatus(): Promise<PeakHoursState> {
  try {
    const res = await fetch(PROMOCLOCK_ENDPOINT);
    if (!res.ok) return unavailableState();

    const data: PromoClockResponse = await res.json();

    const status = normalizeStatus(data.status);
    const sessionLimitSpeed = normalizeSpeed(data.sessionLimitSpeed);
    const isPeak = typeof data.isPeak === 'boolean' ? data.isPeak : status === 'peak';

    return {
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
    };
  } catch {
    return unavailableState();
  }
}
