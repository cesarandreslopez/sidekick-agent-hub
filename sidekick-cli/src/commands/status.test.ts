import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFetchProviderStatus,
  mockFetchOpenAIStatus,
  mockFetchPeakHoursStatus,
  mockResolveProviderId,
} = vi.hoisted(() => ({
  mockFetchProviderStatus: vi.fn(),
  mockFetchOpenAIStatus: vi.fn(),
  mockFetchPeakHoursStatus: vi.fn(),
  mockResolveProviderId: vi.fn(),
}));

vi.mock('sidekick-shared', () => ({
  fetchProviderStatus: (...args: unknown[]) => mockFetchProviderStatus(...args),
  fetchOpenAIStatus: (...args: unknown[]) => mockFetchOpenAIStatus(...args),
  fetchPeakHoursStatus: (...args: unknown[]) => mockFetchPeakHoursStatus(...args),
}));

vi.mock('../cli', () => ({
  resolveProviderId: (...args: unknown[]) => mockResolveProviderId(...args),
}));

import { statusAction } from './status';

function okStatus() {
  return {
    indicator: 'none',
    description: 'All systems operational',
    affectedComponents: [],
    activeIncident: null,
    updatedAt: '2026-05-27T00:00:00.000Z',
  };
}

function makeCmd(json = false) {
  return {
    parent: { opts: () => ({ json }) },
  } as unknown as import('commander').Command;
}

describe('statusAction', () => {
  let stdoutData: string;

  beforeEach(() => {
    stdoutData = '';
    vi.clearAllMocks();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutData += String(chunk);
      return true;
    });
    mockFetchProviderStatus.mockResolvedValue(okStatus());
    mockFetchOpenAIStatus.mockResolvedValue(okStatus());
    mockFetchPeakHoursStatus.mockResolvedValue({
      status: 'off_peak',
      isPeak: false,
      sessionLimitSpeed: 'normal',
      label: 'Off-Peak',
      peakHoursDescription: '',
      nextChange: null,
      minutesUntilChange: null,
      note: '',
      updatedAt: '2026-05-27T00:00:00.000Z',
      unavailable: false,
    });
    mockResolveProviderId.mockReturnValue('claude-code');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns peak null and skips peak fetch for Codex', async () => {
    mockResolveProviderId.mockReturnValue('codex');

    await statusAction({}, makeCmd(true));

    expect(mockFetchPeakHoursStatus).not.toHaveBeenCalled();
    const parsed = JSON.parse(stdoutData);
    expect(parsed.peak).toBeNull();
  });

  it('fetches peak-hours status for Claude Code', async () => {
    await statusAction({}, makeCmd(true));

    expect(mockFetchPeakHoursStatus).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stdoutData);
    expect(parsed.peak.label).toBe('Off-Peak');
  });
});
