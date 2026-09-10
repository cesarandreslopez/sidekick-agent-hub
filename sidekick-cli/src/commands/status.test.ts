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

vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  fetchProviderServiceStatus: (provider: string) =>
    provider === 'codex' ? mockFetchOpenAIStatus() : mockFetchProviderStatus(),
  fetchPeakHoursStatus: (...args: unknown[]) => mockFetchPeakHoursStatus(...args),
}));

vi.mock('../cli', () => ({
  resolveProviderId: (...args: unknown[]) => mockResolveProviderId(...args),
}));

import { statusAction } from './status';

function okStatus() {
  return {
    availability: 'observed',
    provider: 'claude-code',
    sourceUrl: 'https://status.claude.com/api/v2/summary.json',
    providerUpdatedAt: '2026-05-26T00:00:00.000Z',
    severity: 'none',
    description: 'All systems operational',
    components: [],
    incidents: [],
    checkedAt: '2026-05-27T00:00:00.000Z',
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
    mockFetchOpenAIStatus.mockResolvedValue({ ...okStatus(), provider: 'codex' });
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
  it('keeps legacy JSON fields and adds explicit unavailable evidence', async () => {
    mockFetchOpenAIStatus.mockResolvedValue({
      availability: 'unavailable',
      provider: 'codex',
      checkedAt: '2026-09-09T00:00:00Z',
      sourceUrl: 'https://status.openai.com/api/v2/summary.json',
      reason: 'network_error',
    });
    await statusAction({}, makeCmd(true));
    const result = JSON.parse(stdoutData);
    expect(result.claude.indicator).toBe('none');
    expect(result.openai.description).toBe('Status unavailable');
    expect(result.serviceStatus.openai.availability).toBe('unavailable');
    expect(result.serviceStatus.openai).not.toHaveProperty('severity');
  });

  it('renders missing incident evidence explicitly', async () => {
    mockFetchProviderStatus.mockResolvedValue({ ...okStatus(), incidents: null });
    await statusAction({}, makeCmd());
    expect(stdoutData).toContain('Incident information unavailable');
    expect(stdoutData).toContain('Checked:');
    expect(stdoutData).toContain('Provider updated:');
  });
});
