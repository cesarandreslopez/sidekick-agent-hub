import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIVE_HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS, fetchQuota, projectQuotaWindow } from './quota';

describe('projectQuotaWindow', () => {
  it('projects utilization from captured time, reset time, and window duration', () => {
    expect(
      projectQuotaWindow({
        utilization: 40,
        resetsAt: '2026-03-12T14:00:00Z',
        windowMs: FIVE_HOUR_WINDOW_MS,
        capturedAt: '2026-03-12T12:00:00Z',
      }),
    ).toBe(67);

    expect(
      projectQuotaWindow({
        utilization: 70,
        resetsAt: '2026-03-13T12:00:00Z',
        windowMs: SEVEN_DAY_WINDOW_MS,
        capturedAt: '2026-03-12T12:00:00Z',
      }),
    ).toBe(82);
  });

  it('returns undefined when projection inputs are unusable', () => {
    expect(
      projectQuotaWindow({
        utilization: 0,
        resetsAt: '2026-03-12T14:00:00Z',
        windowMs: FIVE_HOUR_WINDOW_MS,
        capturedAt: '2026-03-12T12:00:00Z',
      }),
    ).toBeUndefined();
    expect(
      projectQuotaWindow({
        utilization: 10,
        resetsAt: '',
        windowMs: FIVE_HOUR_WINDOW_MS,
        capturedAt: '2026-03-12T12:00:00Z',
      }),
    ).toBeUndefined();
    expect(
      projectQuotaWindow({
        utilization: 10,
        resetsAt: '2026-03-12T14:00:00Z',
        windowMs: FIVE_HOUR_WINDOW_MS,
        capturedAt: '2026-03-12T08:00:00Z',
      }),
    ).toBeUndefined();
  });

  it('caps projections at 200 percent', () => {
    expect(
      projectQuotaWindow({
        utilization: 80,
        resetsAt: '2026-03-12T14:00:00Z',
        windowMs: FIVE_HOUR_WINDOW_MS,
        capturedAt: '2026-03-12T09:12:00Z',
      }),
    ).toBe(200);
  });
});

describe('fetchQuota', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:00:00Z'));
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns quota data with projections on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 40, resets_at: '2026-03-12T14:00:00Z' },
        seven_day: { utilization: 70, resets_at: '2026-03-13T12:00:00Z' },
      }),
    });

    const result = await fetchQuota('token');

    expect(result).toEqual({
      fiveHour: { utilization: 40, resetsAt: '2026-03-12T14:00:00Z' },
      sevenDay: { utilization: 70, resetsAt: '2026-03-13T12:00:00Z' },
      available: true,
      projectedFiveHour: 67,
      projectedSevenDay: 82,
    });
  });

  it('classifies 401 responses as auth failures', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
    });

    const result = await fetchQuota('token');

    expect(result).toMatchObject({
      available: false,
      error: 'Sign in to Claude Code to view quota',
      failureKind: 'auth',
      httpStatus: 401,
    });
    expect(result.retryAfterMs).toBeUndefined();
  });

  it('classifies 429 responses and parses numeric Retry-After headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '12' : null) },
    });

    const result = await fetchQuota('token');

    expect(result).toMatchObject({
      available: false,
      error: 'API error: 429',
      failureKind: 'rate_limit',
      httpStatus: 429,
      retryAfterMs: 12_000,
    });
  });

  it('classifies 429 responses and parses date-based Retry-After headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' ? 'Thu, 12 Mar 2026 12:00:45 GMT' : null,
      },
    });

    const result = await fetchQuota('token');

    expect(result.failureKind).toBe('rate_limit');
    expect(result.retryAfterMs).toBe(45_000);
  });

  it('classifies 5xx responses as server failures', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: { get: () => null },
    });

    const result = await fetchQuota('token');

    expect(result).toMatchObject({
      available: false,
      error: 'API error: 503',
      failureKind: 'server',
      httpStatus: 503,
    });
  });

  it('classifies other non-ok responses as unknown failures', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
    });

    const result = await fetchQuota('token');

    expect(result).toMatchObject({
      available: false,
      error: 'API error: 403',
      failureKind: 'unknown',
      httpStatus: 403,
    });
  });

  it('classifies thrown fetch failures as network failures', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));

    const result = await fetchQuota('token');

    expect(result).toMatchObject({
      available: false,
      error: 'Network error',
      failureKind: 'network',
    });
    expect(result.httpStatus).toBeUndefined();
  });
});
