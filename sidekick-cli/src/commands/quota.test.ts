import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getUtilizationColor, makeChalkBar, formatTimeUntil } from './quota';
import chalk from 'chalk';

// ── getUtilizationColor ──

describe('getUtilizationColor', () => {
  it('returns green below 60%', () => {
    expect(getUtilizationColor(0)).toBe(chalk.green);
    expect(getUtilizationColor(59)).toBe(chalk.green);
  });

  it('returns yellow between 60-79%', () => {
    expect(getUtilizationColor(60)).toBe(chalk.yellow);
    expect(getUtilizationColor(79)).toBe(chalk.yellow);
  });

  it('returns red at 80% and above', () => {
    expect(getUtilizationColor(80)).toBe(chalk.red);
    expect(getUtilizationColor(100)).toBe(chalk.red);
  });
});

// ── makeChalkBar ──

describe('makeChalkBar', () => {
  beforeEach(() => { chalk.level = 0; });

  it('produces correct bar length', () => {
    const bar = makeChalkBar(50, 20);
    const filled = (bar.match(/█/g) || []).length;
    const empty = (bar.match(/░/g) || []).length;
    expect(filled).toBe(10);
    expect(empty).toBe(10);
  });

  it('handles 0%', () => {
    const bar = makeChalkBar(0, 10);
    expect((bar.match(/█/g) || []).length).toBe(0);
    expect((bar.match(/░/g) || []).length).toBe(10);
  });

  it('handles 100%', () => {
    const bar = makeChalkBar(100, 10);
    expect((bar.match(/█/g) || []).length).toBe(10);
    expect((bar.match(/░/g) || []).length).toBe(0);
  });
});

// ── formatTimeUntil ──

describe('formatTimeUntil', () => {
  it('returns empty string for empty input', () => {
    expect(formatTimeUntil('')).toBe('');
  });

  it('returns "now" for past timestamps', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(formatTimeUntil(past)).toBe('now');
  });

  it('formats hours and minutes', () => {
    // Add 30s buffer to avoid floor rounding at the boundary
    const future = new Date(Date.now() + 2 * 60 * 60_000 + 15 * 60_000 + 30_000).toISOString();
    expect(formatTimeUntil(future)).toBe('in 2h 15m');
  });

  it('formats days and hours (no minutes)', () => {
    const future = new Date(Date.now() + 4 * 24 * 60 * 60_000 + 6 * 60 * 60_000 + 30_000).toISOString();
    expect(formatTimeUntil(future)).toBe('in 4d 6h');
  });

  it('formats minutes only', () => {
    const future = new Date(Date.now() + 45 * 60_000 + 30_000).toISOString();
    expect(formatTimeUntil(future)).toBe('in 45m');
  });
});

// ── quotaAction ──

const { mockFetchOnce, mockResolveCodexQuota, mockResolveProvider, mockFetchPeakHoursStatus } = vi.hoisted(() => ({
  mockFetchOnce: vi.fn(),
  mockResolveCodexQuota: vi.fn(),
  mockResolveProvider: vi.fn(),
  mockFetchPeakHoursStatus: vi.fn(),
}));

vi.mock('sidekick-shared', () => ({
  CodexProvider: class {
    id = 'codex';
    dispose = vi.fn();
  },
  getActiveAccount: () => null,
  getActiveCodexAccount: () => ({ id: 'codex-account', providerId: 'codex', addedAt: '2026-05-19T00:00:00Z', label: 'Work' }),
  resolveCodexQuota: mockResolveCodexQuota,
  fetchPeakHoursStatus: (...args: unknown[]) => mockFetchPeakHoursStatus(...args),
  createPeakHoursNotApplicableState: (providerId: string) => ({
    status: 'unknown',
    isPeak: false,
    sessionLimitSpeed: 'unknown',
    label: 'Claude peak hours not applicable',
    peakHoursDescription: '',
    nextChange: null,
    minutesUntilChange: null,
    note: `Claude peak hours apply only to Claude Code sessions, not ${providerId}.`,
    updatedAt: new Date().toISOString(),
    unavailable: true,
    notApplicable: true,
  }),
  isClaudeCodeSessionProvider: (providerId: string) => providerId === 'claude-code',
  describeQuotaFailure: (quota: {
    available?: boolean;
    error?: string;
    failureKind?: string;
    httpStatus?: number;
    retryAfterMs?: number;
  }) => {
    if (!quota || quota.available || !quota.failureKind) return null;

    switch (quota.failureKind) {
      case 'auth':
        if (quota.error === 'No OAuth token available') {
          return {
            severity: 'error',
            title: 'Sign in required',
            message: 'No Claude Code credentials are available in this environment.',
            detail: 'Run `claude` to sign in, then retry quota refresh.',
          };
        }
        return {
          severity: 'error',
          title: 'Claude Code sign-in expired',
          message: 'The current Claude Code OAuth session was rejected.',
          detail: 'Sign in again to refresh subscription quota.',
        };
      case 'rate_limit':
        return {
          severity: 'warning',
          title: 'Quota API rate limited',
          message: quota.retryAfterMs === 45_000 ? 'Retry in 45s.' : 'Retry shortly.',
          detail: quota.httpStatus != null ? `Anthropic returned HTTP ${quota.httpStatus}.` : undefined,
        };
      case 'network':
        return {
          severity: 'warning',
          title: 'Quota API unreachable',
          message: 'Could not reach Anthropic from the current environment.',
          detail: 'Check connectivity, proxy, or firewall settings, then retry.',
        };
      default:
        return null;
    }
  },
}));

vi.mock('../cli', () => ({
  resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
}));

vi.mock('../dashboard/QuotaService', () => ({
  QuotaService: vi.fn().mockImplementation(function () {
    return { fetchOnce: mockFetchOnce };
  }),
}));

describe('quotaAction', () => {
  let stdoutData: string;
  let stderrData: string;
  const originalExit = process.exit;

  const makeCmd = (json = false, localOpts: Record<string, unknown> = {}) => ({
    parent: { opts: () => ({ json }) },
    opts: () => localOpts,
  }) as unknown as import('commander').Command;

  beforeEach(() => {
    stdoutData = '';
    stderrData = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutData += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrData += String(chunk);
      return true;
    });
    process.exit = vi.fn() as never;
    mockFetchOnce.mockReset();
    mockResolveCodexQuota.mockReset();
    mockResolveProvider.mockReset();
    mockFetchPeakHoursStatus.mockReset();
    mockResolveProvider.mockReturnValue({ id: 'claude-code', dispose: () => {} });
    mockFetchPeakHoursStatus.mockResolvedValue({
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
    });
    chalk.level = 0;
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('prints formatted quota with projections on success', async () => {
    mockFetchOnce.mockResolvedValue({
      fiveHour: { utilization: 40, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
      sevenDay: { utilization: 72, resetsAt: new Date(Date.now() + 4 * 86400_000).toISOString() },
      available: true,
      projectedFiveHour: 100,
      projectedSevenDay: 85,
    });

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd());

    expect(stdoutData).toContain('Subscription Quota');
    expect(stdoutData).toContain('5-Hour');
    expect(stdoutData).toContain('7-Day');
    expect(stdoutData).toContain('40%');
    expect(stdoutData).toContain('72%');
    // Projections shown with arrow
    expect(stdoutData).toContain('100%');
    expect(stdoutData).toContain('85%');
  });

  it('outputs JSON when --json flag is set', async () => {
    const quota = {
      fiveHour: { utilization: 40, resetsAt: '2026-01-01T00:00:00Z' },
      sevenDay: { utilization: 72, resetsAt: '2026-01-05T00:00:00Z' },
      available: true,
    };
    mockFetchOnce.mockResolvedValue(quota);

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd(true));

    const parsed = JSON.parse(stdoutData);
    expect(parsed.available).toBe(true);
    expect(parsed.fiveHour.utilization).toBe(40);
  });

  it('prints error and exits for no credentials', async () => {
    mockFetchOnce.mockResolvedValue({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'No OAuth token available',
      failureKind: 'auth',
    });

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd());

    expect(stderrData).toContain('Sign in required');
    expect(stderrData).toContain('No Claude Code credentials are available');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('outputs JSON even on error when --json is set', async () => {
    const quota = {
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'No OAuth token available',
      failureKind: 'auth',
    };
    mockFetchOnce.mockResolvedValue(quota);

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd(true));

    const parsed = JSON.parse(stdoutData);
    expect(parsed.available).toBe(false);
    expect(parsed.error).toBe('No OAuth token available');
    expect(parsed.failureKind).toBe('auth');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('prints an auth failure message when the API rejects the token', async () => {
    mockFetchOnce.mockResolvedValue({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'Sign in to Claude Code to view quota',
      failureKind: 'auth',
      httpStatus: 401,
    });

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd());

    expect(stderrData).toContain('Claude Code sign-in expired');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('prints retry timing for rate-limited responses', async () => {
    mockFetchOnce.mockResolvedValue({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'API error: 429',
      failureKind: 'rate_limit',
      httpStatus: 429,
      retryAfterMs: 45_000,
    });

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd());

    expect(stderrData).toContain('Quota API rate limited');
    expect(stderrData).toContain('45s');
    expect(stderrData).toContain('Anthropic returned HTTP 429');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('falls back to legacy error matching when failure metadata is absent', async () => {
    mockFetchOnce.mockResolvedValue({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'network-error',
    });

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd());

    expect(stderrData).toContain('Could not reach the Anthropic API');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('uses local-only Codex quota resolution by default', async () => {
    const provider = { id: 'codex', dispose: vi.fn() };
    mockResolveProvider.mockReturnValue(provider);
    mockResolveCodexQuota.mockResolvedValue({
      runtimeProvider: 'codex',
      providerId: 'codex',
      fiveHour: { utilization: 6, resetsAt: '2026-05-19T15:00:00Z' },
      sevenDay: { utilization: 1, resetsAt: '2026-05-26T15:00:00Z' },
      available: true,
      source: 'session',
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
    });

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd());

    expect(mockResolveCodexQuota).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      source: 'local',
    }));
    expect(stdoutData).toContain('Rate Limits');
    expect(stdoutData).toContain('6%');
    expect(mockFetchPeakHoursStatus).not.toHaveBeenCalled();
    expect(provider.dispose).toHaveBeenCalledOnce();
  });

  it('uses explicit API Codex quota refresh with --refresh', async () => {
    const provider = { id: 'codex', dispose: vi.fn() };
    mockResolveProvider.mockReturnValue(provider);
    mockResolveCodexQuota.mockResolvedValue({
      runtimeProvider: 'codex',
      providerId: 'codex',
      fiveHour: { utilization: 21, resetsAt: '2026-05-19T15:00:00Z' },
      sevenDay: { utilization: 4, resetsAt: '2026-05-26T15:00:00Z' },
      available: true,
      source: 'api',
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
    });

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd(false, { refresh: true }));

    expect(mockResolveCodexQuota).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      source: 'api',
    }));
    expect(stdoutData).toContain('Rate Limits');
    expect(stdoutData).toContain('21%');
    expect(provider.dispose).toHaveBeenCalledOnce();
  });

  it('outputs combined Claude and Codex quota with --all --json', async () => {
    mockFetchOnce.mockResolvedValue({
      fiveHour: { utilization: 40, resetsAt: '2026-01-01T00:00:00Z' },
      sevenDay: { utilization: 72, resetsAt: '2026-01-05T00:00:00Z' },
      available: true,
    });
    mockResolveCodexQuota.mockResolvedValue({
      runtimeProvider: 'codex',
      providerId: 'codex',
      fiveHour: { utilization: 6, resetsAt: '2026-05-19T15:00:00Z' },
      sevenDay: { utilization: 1, resetsAt: '2026-05-26T15:00:00Z' },
      available: true,
      source: 'session',
    });

    const { quotaAction } = await import('./quota');
    await quotaAction({}, makeCmd(true, { all: true }));

    const parsed = JSON.parse(stdoutData);
    expect(parsed.claude.available).toBe(true);
    expect(parsed.claude.fiveHour.utilization).toBe(40);
    expect(parsed.codex.available).toBe(true);
    expect(parsed.codex.fiveHour.utilization).toBe(6);
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });
});
