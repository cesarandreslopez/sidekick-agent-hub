import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

const { mockFetchPeakHoursStatus, mockResolveProviderId } = vi.hoisted(() => ({
  mockFetchPeakHoursStatus: vi.fn(),
  mockResolveProviderId: vi.fn(),
}));

vi.mock('sidekick-shared', () => ({
  createPeakHoursNotApplicableState: (providerId: string) => ({
    status: 'unknown',
    isPeak: false,
    sessionLimitSpeed: 'unknown',
    label: 'Claude peak hours not applicable',
    peakHoursDescription: '',
    nextChange: null,
    minutesUntilChange: null,
    note: `Claude peak hours apply only to Claude Code sessions, not ${providerId}.`,
    updatedAt: '2026-05-27T00:00:00.000Z',
    unavailable: true,
    notApplicable: true,
  }),
  fetchPeakHoursStatus: (...args: unknown[]) => mockFetchPeakHoursStatus(...args),
  isClaudeCodeSessionProvider: (providerId: string) => providerId === 'claude-code',
}));

vi.mock('../cli', () => ({
  resolveProviderId: (...args: unknown[]) => mockResolveProviderId(...args),
}));

import { peakAction } from './peak';

function makeCmd(
  json = false,
  localOpts: Record<string, unknown> = {},
  globalOpts: Record<string, unknown> = {},
) {
  return {
    parent: { opts: () => ({ json, ...globalOpts }) },
    opts: () => localOpts,
  } as unknown as import('commander').Command;
}

describe('peakAction', () => {
  let stdoutData: string;

  beforeEach(() => {
    stdoutData = '';
    vi.clearAllMocks();
    chalk.level = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutData += String(chunk);
      return true;
    });
    mockResolveProviderId.mockReturnValue('claude-code');
    mockFetchPeakHoursStatus.mockResolvedValue({
      status: 'peak',
      isPeak: true,
      sessionLimitSpeed: 'faster',
      label: 'Peak Hours',
      peakHoursDescription: 'Weekdays 1pm-7pm UTC',
      nextChange: null,
      minutesUntilChange: null,
      note: '',
      updatedAt: '2026-05-27T00:00:00.000Z',
      unavailable: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and renders peak-hours status for Claude Code', async () => {
    await peakAction({}, makeCmd(false, { provider: 'claude-code' }));

    expect(mockResolveProviderId).toHaveBeenCalledWith({ provider: 'claude-code' });
    expect(mockFetchPeakHoursStatus).toHaveBeenCalledOnce();
    expect(stdoutData).toContain('Claude Peak Hours');
    expect(stdoutData).toContain('Peak Hours');
  });

  it('does not fetch peak-hours status for Codex', async () => {
    mockResolveProviderId.mockReturnValue('codex');

    await peakAction({}, makeCmd(false, { provider: 'codex' }));

    expect(mockFetchPeakHoursStatus).not.toHaveBeenCalled();
    expect(stdoutData).toContain('Claude peak hours apply only to Claude Code sessions');
    expect(stdoutData).toContain('codex');
  });

  it('returns a not-applicable JSON state for Codex', async () => {
    mockResolveProviderId.mockReturnValue('codex');

    await peakAction({}, makeCmd(true, { provider: 'codex' }));

    expect(mockFetchPeakHoursStatus).not.toHaveBeenCalled();
    const parsed = JSON.parse(stdoutData);
    expect(parsed.unavailable).toBe(true);
    expect(parsed.notApplicable).toBe(true);
  });
});
