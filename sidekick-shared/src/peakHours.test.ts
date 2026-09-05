import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _resetPeakHoursCache,
  createPeakHoursNotApplicableState,
  DEFAULT_PEAK_HOURS_TIMEOUT_MS,
  fetchPeakHoursStatus,
  isClaudeCodeSessionProvider,
  scopePeakHoursToSessionProvider,
} from './peakHours';

describe('fetchPeakHoursStatus', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetPeakHoursCache();
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
    expect(mockFetch).toHaveBeenCalledWith('https://promoclock.co/api/status', {
      signal: expect.any(AbortSignal),
    });
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
      source: 'promoclock',
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

  it('falls back to the published schedule on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await fetchPeakHoursStatus();

    expect(result.unavailable).toBe(false);
    expect(result.source).toBe('schedule');
    expect(['peak', 'off_peak']).toContain(result.status);
    expect(['faster', 'normal']).toContain(result.sessionLimitSpeed);
    expect(result.updatedAt).toBeTruthy();
  });

  it('falls back to the published schedule on a network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await fetchPeakHoursStatus();

    expect(result.unavailable).toBe(false);
    expect(result.source).toBe('schedule');
    expect(result.note).toContain('promoclock.co unreachable');
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

  it('aborts and falls back to the schedule when the host does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      // Resolve only when the caller's signal fires, so the abort is what ends
      // the request — a hung third-party host, reproduced.
      mockFetch.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );

      const pending = fetchPeakHoursStatus({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(51);
      const result = await pending;

      expect(result.unavailable).toBe(false);
      expect(result.source).toBe('schedule');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the abort timer once the request settles', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await fetchPeakHoursStatus();

      // A leaked timer would keep an unref'd handle alive per poll.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults to the documented timeout budget', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await fetchPeakHoursStatus();

    expect(DEFAULT_PEAK_HOURS_TIMEOUT_MS).toBe(4_000);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });
});

describe('peak-hours provider scoping', () => {
  it('identifies only Claude Code as peak-hours applicable', () => {
    expect(isClaudeCodeSessionProvider('claude-code')).toBe(true);
    expect(isClaudeCodeSessionProvider('codex')).toBe(false);
    expect(isClaudeCodeSessionProvider('opencode')).toBe(false);
  });

  it('scopes peak-hours state to Claude Code sessions', () => {
    const state = createPeakHoursNotApplicableState('codex');

    expect(scopePeakHoursToSessionProvider('claude-code', state)).toBe(state);
    expect(scopePeakHoursToSessionProvider('codex', state)).toBeNull();
    expect(scopePeakHoursToSessionProvider('opencode', state)).toBeNull();
  });

  it('creates a not-applicable state for non-Claude providers', () => {
    const state = createPeakHoursNotApplicableState('codex');

    expect(state.unavailable).toBe(true);
    expect(state.notApplicable).toBe(true);
    expect(state.isPeak).toBe(false);
    expect(state.note).toContain('Codex CLI');
  });
});
