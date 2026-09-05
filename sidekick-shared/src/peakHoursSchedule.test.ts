import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPeakHoursCache,
  fetchPeakHoursStatus,
  getScheduledPeakHoursState,
  PEAK_HOURS_DESCRIPTION,
} from './peakHours';

describe('getScheduledPeakHoursState', () => {
  it('is peak on a weekday inside 13:00–19:00 UTC', () => {
    const state = getScheduledPeakHoursState(new Date('2026-07-20T15:30:00Z')); // Monday
    expect(state.isPeak).toBe(true);
    expect(state.status).toBe('peak');
    expect(state.sessionLimitSpeed).toBe('faster');
    expect(state.nextChange).toBe('2026-07-20T19:00:00.000Z');
    expect(state.minutesUntilChange).toBe(210);
    expect(state.source).toBe('schedule');
    expect(state.unavailable).toBe(false);
    expect(state.peakHoursDescription).toBe(PEAK_HOURS_DESCRIPTION);
  });

  it('is off-peak before the window and counts down to it', () => {
    const state = getScheduledPeakHoursState(new Date('2026-07-20T11:00:00Z'));
    expect(state.isPeak).toBe(false);
    expect(state.nextChange).toBe('2026-07-20T13:00:00.000Z');
    expect(state.minutesUntilChange).toBe(120);
  });

  it('is off-peak after the window and targets the next weekday', () => {
    const friday = getScheduledPeakHoursState(new Date('2026-07-24T20:00:00Z'));
    expect(friday.isPeak).toBe(false);
    expect(friday.nextChange).toBe('2026-07-27T13:00:00.000Z'); // Monday
  });

  it('is off-peak all weekend', () => {
    const state = getScheduledPeakHoursState(new Date('2026-07-19T15:00:00Z')); // Sunday
    expect(state.isPeak).toBe(false);
    expect(state.nextChange).toBe('2026-07-20T13:00:00.000Z');
  });
});

describe('fetchPeakHoursStatus fallback and cache', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetPeakHoursCache();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the schedule when the host is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    const state = await fetchPeakHoursStatus();
    expect(state.unavailable).toBe(false);
    expect(state.source).toBe('schedule');
    expect(state.note).toContain('promoclock.co unreachable');
    expect(typeof state.isPeak).toBe('boolean');
  });

  it('falls back to the schedule on a non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const state = await fetchPeakHoursStatus();
    expect(state.source).toBe('schedule');
  });

  it('reuses a successful answer instead of asking the host again', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'peak', isPeak: true, sessionLimitSpeed: 'faster' }),
    });
    const first = await fetchPeakHoursStatus();
    const second = await fetchPeakHoursStatus();
    expect(first.source).toBe('promoclock');
    expect(second).toBe(first);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await fetchPeakHoursStatus({ force: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
