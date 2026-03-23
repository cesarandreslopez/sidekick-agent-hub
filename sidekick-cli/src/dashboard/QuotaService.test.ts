import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadClaudeMaxCredentials, mockFetchQuota } = vi.hoisted(() => ({
  mockReadClaudeMaxCredentials: vi.fn(),
  mockFetchQuota: vi.fn(),
}));

vi.mock('sidekick-shared', async () => {
  const actual = await vi.importActual<typeof import('sidekick-shared')>('sidekick-shared');
  return {
    ...actual,
    readClaudeMaxCredentials: (...args: unknown[]) => mockReadClaudeMaxCredentials(...args),
    fetchQuota: (...args: unknown[]) => mockFetchQuota(...args),
  };
});

import { QuotaService } from './QuotaService';

describe('QuotaService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an auth failure when credentials are missing', async () => {
    mockReadClaudeMaxCredentials.mockResolvedValue(null);

    const service = new QuotaService();
    const result = await service.fetchOnce();

    expect(result).toMatchObject({
      available: false,
      error: 'No OAuth token available',
      failureKind: 'auth',
    });
  });

  it('fetchOnce returns quota from API', async () => {
    mockReadClaudeMaxCredentials.mockResolvedValue({ accessToken: 'token' });
    mockFetchQuota.mockResolvedValue({
      fiveHour: { utilization: 5, resetsAt: '2026-03-12T14:00:00Z' },
      sevenDay: { utilization: 8, resetsAt: '2026-03-13T12:00:00Z' },
      available: true,
    });

    const service = new QuotaService();
    const result = await service.fetchOnce();

    expect(result).toMatchObject({ available: true, fiveHour: { utilization: 5 } });
    expect(mockFetchQuota).toHaveBeenCalledWith('token');
  });

  it('start and stop do not throw', () => {
    const service = new QuotaService();
    service.start();
    service.stop();
    // Double-stop should not throw
    service.stop();
  });

  it('getCached returns null before any poll', () => {
    const service = new QuotaService();
    expect(service.getCached()).toBeNull();
  });
});
