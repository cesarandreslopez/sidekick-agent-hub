import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIVE_HOUR_WINDOW_MS,
  SEVEN_DAY_WINDOW_MS,
  claudePlanLabel,
  extraQuotaRows,
  fetchQuota,
  formatExtraUsage,
  projectQuotaWindow,
  quotaSampleExpired,
  quotaStateFromClaudeUsagePayload,
  quotaWindowHasData,
  quotaWindowLabel,
  quotaWindowShortLabel,
  withQuotaProjections,
} from './quota';

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

  it('aborts a hung usage request after ten seconds', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const pending = fetchQuota('token');
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({
      available: false,
      failureKind: 'network',
    });
  });
});

/**
 * Trimmed from a real 2026-11-01 usage-endpoint reply for an Ultra account
 * (formerly Max 20x), after the five-hour limit was removed.
 */
const ULTRA_USAGE_PAYLOAD = {
  five_hour: null,
  seven_day: {
    utilization: 17,
    resets_at: '2026-11-07T06:00:00.212680+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  cinder_cove: null,
  wattle_ember: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: 20000,
    used_credits: 0,
    utilization: 0,
    currency: 'USD',
    decimal_places: 2,
    disabled_reason: 'out_of_credits',
  },
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 17,
      severity: 'normal',
      resets_at: '2026-11-07T06:00:00.212680+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 0,
      severity: 'normal',
      resets_at: '2026-11-07T06:00:00.212816+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
  weekly_scoped_shares: [
    { limit_index: 1, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 },
  ],
};

describe('quotaStateFromClaudeUsagePayload', () => {
  const capturedAt = '2026-11-01T03:10:06.000Z';

  it('marks a null five_hour window absent instead of reporting 0% used', () => {
    const state = quotaStateFromClaudeUsagePayload(ULTRA_USAGE_PAYLOAD, { capturedAt });

    expect(state.fiveHour).toEqual({ utilization: 0, resetsAt: '', absent: true });
    expect(state.sevenDay).toEqual({
      utilization: 17,
      resetsAt: '2026-11-07T06:00:00.212680+00:00',
    });
    expect(state.projectedFiveHour).toBeUndefined();
    expect(state.projectedSevenDay).toBeGreaterThan(17);
    expect(quotaWindowHasData(state.fiveHour)).toBe(false);
  });

  it('keeps every server meter with derived labels, lengths, and weekly shares', () => {
    const state = quotaStateFromClaudeUsagePayload(ULTRA_USAGE_PAYLOAD, { capturedAt });

    expect(state.limits).toHaveLength(2);
    expect(state.limits?.[0]).toMatchObject({
      kind: 'weekly_all',
      label: '7-Day',
      utilization: 17,
      windowMs: SEVEN_DAY_WINDOW_MS,
      isActive: true,
    });
    expect(extraQuotaRows(state)).toEqual([
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        label: '7-Day (Fable)',
        utilization: 0,
        resetsAt: '2026-11-07T06:00:00.212816+00:00',
        windowMs: SEVEN_DAY_WINDOW_MS,
        scopeModel: 'Fable',
        severity: 'normal',
        isActive: false,
        allowancePercentOfWeekly: 50,
        usedPercentOfWeekly: 0,
      },
    ]);
  });

  it('parses extra usage in minor units', () => {
    const state = quotaStateFromClaudeUsagePayload(ULTRA_USAGE_PAYLOAD, { capturedAt });

    expect(state.extraUsage).toEqual({
      enabled: false,
      monthlyLimit: 20000,
      usedCredits: 0,
      utilization: 0,
      currency: 'USD',
      decimalPlaces: 2,
      disabledReason: 'out_of_credits',
    });
    expect(formatExtraUsage(state.extraUsage!)).toBe(
      '$0.00 of $200.00 used · off (out of credits)',
    );
  });

  it('fills a missing headline window from its limits[] meter', () => {
    const state = quotaStateFromClaudeUsagePayload(
      {
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 30,
            resets_at: '2026-11-01T05:00:00Z',
            severity: 'normal',
            is_active: true,
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 12,
            resets_at: '2026-11-07T06:00:00Z',
            severity: 'normal',
            is_active: false,
          },
        ],
      },
      { capturedAt },
    );

    expect(state.fiveHour).toEqual({ utilization: 30, resetsAt: '2026-11-01T05:00:00Z' });
    expect(state.sevenDay).toEqual({ utilization: 12, resetsAt: '2026-11-07T06:00:00Z' });
    expect(extraQuotaRows(state)).toEqual([]);
  });

  it('skips malformed meters and labels unknown kinds by group and scope', () => {
    const state = quotaStateFromClaudeUsagePayload(
      {
        five_hour: { utilization: 5, resets_at: '2026-11-01T05:00:00Z' },
        seven_day: { utilization: 9, resets_at: '2026-11-07T06:00:00Z' },
        limits: [
          null,
          'oops',
          { kind: 'weekly_scoped', percent: 'high' },
          { group: 'weekly', percent: 4 },
          {
            kind: 'monthly_surface',
            group: 'monthly',
            percent: 140,
            resets_at: null,
            scope: { surface: { display_name: 'Cowork' } },
          },
        ],
      },
      { capturedAt },
    );

    expect(state.limits).toEqual([
      {
        kind: 'monthly_surface',
        group: 'monthly',
        label: 'Monthly (Cowork)',
        utilization: 140,
        resetsAt: '',
        scopeSurface: 'Cowork',
      },
    ]);
  });

  it('reads legacy per-model weekly fields when the server sends no limits[]', () => {
    const state = quotaStateFromClaudeUsagePayload(
      {
        five_hour: { utilization: 5, resets_at: '2026-11-01T05:00:00Z' },
        seven_day: { utilization: 9, resets_at: '2026-11-07T06:00:00Z' },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 22, resets_at: '2026-11-07T06:00:00Z' },
      },
      { capturedAt },
    );

    expect(extraQuotaRows(state).map((row) => [row.label, row.utilization])).toEqual([
      ['7-Day (Sonnet)', 22],
    ]);
  });

  it('produces exactly the original state for the original two-window shape', () => {
    const state = quotaStateFromClaudeUsagePayload(
      {
        five_hour: { utilization: 40, resets_at: '2026-03-12T14:00:00Z' },
        seven_day: { utilization: 70, resets_at: '2026-03-13T12:00:00Z' },
      },
      { capturedAt: '2026-03-12T12:00:00Z' },
    );

    expect(state).toEqual({
      fiveHour: { utilization: 40, resetsAt: '2026-03-12T14:00:00Z' },
      sevenDay: { utilization: 70, resetsAt: '2026-03-13T12:00:00Z' },
      available: true,
      projectedFiveHour: 67,
      projectedSevenDay: 82,
    });
    expect('limits' in state).toBe(false);
    expect('extraUsage' in state).toBe(false);
  });
});

describe('fetchQuota plan facts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stamps the plan label from credential plan facts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ULTRA_USAGE_PAYLOAD }),
    );

    const state = await fetchQuota('token', {
      plan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
    });

    expect(state).toMatchObject({ available: true, planType: 'max', planLabel: 'Ultra' });
    expect(state.fiveHour.absent).toBe(true);
  });
});

describe('quota window helpers', () => {
  it('names Claude plans after the 2026-10-30 rename', () => {
    expect(
      claudePlanLabel({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }),
    ).toBe('Ultra');
    expect(
      claudePlanLabel({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }),
    ).toBe('Max');
    expect(claudePlanLabel({ subscriptionType: 'ultra' })).toBe('Ultra');
    expect(claudePlanLabel({ subscriptionType: 'pro' })).toBe('Pro');
    expect(claudePlanLabel({ subscriptionType: 'team', rateLimitTier: null })).toBe('Team');
    expect(claudePlanLabel(null)).toBeUndefined();
    expect(claudePlanLabel({})).toBeUndefined();
  });

  it('labels windows by length', () => {
    expect(quotaWindowLabel(FIVE_HOUR_WINDOW_MS, 'Primary')).toBe('5-Hour');
    expect(quotaWindowLabel(SEVEN_DAY_WINDOW_MS, 'Primary')).toBe('Weekly');
    expect(quotaWindowLabel(86_400_000, 'Primary')).toBe('Daily');
    expect(quotaWindowLabel(30 * 86_400_000, 'Primary')).toBe('30-Day');
    expect(quotaWindowLabel(undefined, 'Primary')).toBe('Primary');
    expect(quotaWindowLabel(90 * 60_000, 'Primary')).toBe('Primary');
    expect(quotaWindowShortLabel(FIVE_HOUR_WINDOW_MS, '?')).toBe('5h');
    expect(quotaWindowShortLabel(SEVEN_DAY_WINDOW_MS, '?')).toBe('7d');
    expect(quotaWindowShortLabel(undefined, '5h')).toBe('5h');
  });

  it('projects with a window length carried on the window itself', () => {
    const state = withQuotaProjections({
      available: true,
      capturedAt: '2026-11-01T00:00:00Z',
      fiveHour: {
        utilization: 10,
        resetsAt: '2026-11-07T00:00:00Z',
        windowMs: SEVEN_DAY_WINDOW_MS,
      },
      sevenDay: { utilization: 0, resetsAt: '', absent: true },
    });
    // One of seven days elapsed at 10% → 70% at reset (a 5-hour default would give nothing).
    expect(state.projectedFiveHour).toBe(70);
    expect(state.projectedSevenDay).toBeUndefined();
  });

  it('flags a sample whose every window has reset', () => {
    const sample = {
      available: true,
      fiveHour: { utilization: 1, resetsAt: '2026-08-03T05:06:24.689Z' },
      sevenDay: { utilization: 1, resetsAt: '2026-08-08T02:08:34.998Z' },
    };
    expect(quotaSampleExpired(sample, Date.parse('2026-11-01T00:00:00Z'))).toBe(true);
    expect(quotaSampleExpired(sample, Date.parse('2026-08-05T00:00:00Z'))).toBe(false);
    expect(
      quotaSampleExpired(
        { ...sample, sevenDay: { utilization: 0, resetsAt: '', absent: true } },
        Date.parse('2026-08-05T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      quotaSampleExpired(
        {
          available: true,
          fiveHour: { utilization: 0, resetsAt: '' },
          sevenDay: { utilization: 0, resetsAt: '' },
        },
        Date.now(),
      ),
    ).toBe(false);
  });
});
