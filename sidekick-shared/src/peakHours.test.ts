import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPeakHoursStatus } from './peakHours';

describe('fetchPeakHoursStatus', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes a peak response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'peak',
        isPeak: true,
        isOffPeak: false,
        isWeekend: false,
        sessionLimitSpeed: 'faster',
        emoji: '🟠',
        label: 'Peak Hours — Faster Drain',
        peakHours: 'Weekdays 1pm–7pm UTC / 6:00 AM–12:00 PM PDT',
        nextChange: '2026-04-20T19:00:00.000Z',
        minutesUntilChange: 134,
        timestamp: '2026-04-20T16:46:00.000Z',
        utcHour: 16,
        utcDay: 1,
        note: 'No known end date for peak hours adjustment. Weekly limits unchanged.',
      }),
    });

    const result = await fetchPeakHoursStatus();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://promoclock.co/api/status');
    expect(result).toEqual({
      status: 'peak',
      isPeak: true,
      sessionLimitSpeed: 'faster',
      label: 'Peak Hours — Faster Drain',
      peakHoursDescription: 'Weekdays 1pm–7pm UTC / 6:00 AM–12:00 PM PDT',
      nextChange: '2026-04-20T19:00:00.000Z',
      minutesUntilChange: 134,
      note: 'No known end date for peak hours adjustment. Weekly limits unchanged.',
      updatedAt: '2026-04-20T16:46:00.000Z',
      unavailable: false,
    });
  });

  it('normalizes an off_peak response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'off_peak',
        isPeak: false,
        isOffPeak: true,
        isWeekend: true,
        sessionLimitSpeed: 'normal',
        label: 'Off-Peak — Normal Speed',
        peakHours: 'Weekdays 1pm–7pm UTC / 6:00 AM–12:00 PM PDT',
        nextChange: '2026-04-20T13:00:00.000Z',
        minutesUntilChange: 2349,
        timestamp: '2026-04-18T21:50:42.449Z',
        note: 'No known end date for peak hours adjustment. Weekly limits unchanged.',
      }),
    });

    const result = await fetchPeakHoursStatus();

    expect(result.status).toBe('off_peak');
    expect(result.isPeak).toBe(false);
    expect(result.sessionLimitSpeed).toBe('normal');
    expect(result.minutesUntilChange).toBe(2349);
    expect(result.unavailable).toBe(false);
  });

  it('returns unavailable state on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await fetchPeakHoursStatus();

    expect(result.unavailable).toBe(true);
    expect(result.status).toBe('unknown');
    expect(result.sessionLimitSpeed).toBe('unknown');
    expect(result.isPeak).toBe(false);
    expect(result.updatedAt).toBeTruthy();
  });

  it('returns unavailable state on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await fetchPeakHoursStatus();

    expect(result.unavailable).toBe(true);
    expect(result.label).toBe('Peak-hours status unavailable');
  });

  it('tolerates unexpected status/speed values', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'something_new',
        sessionLimitSpeed: 'warp',
        isPeak: true,
        label: 'Mystery state',
        peakHours: 'UTC',
        timestamp: '2026-04-18T21:50:42.449Z',
      }),
    });

    const result = await fetchPeakHoursStatus();

    expect(result.status).toBe('unknown');
    expect(result.sessionLimitSpeed).toBe('unknown');
    expect(result.isPeak).toBe(true);
    expect(result.unavailable).toBe(false);
  });
});
