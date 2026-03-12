import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadClaudeMaxCredentials, mockFetchQuota } = vi.hoisted(() => ({
  mockReadClaudeMaxCredentials: vi.fn(),
  mockFetchQuota: vi.fn(),
}));

vi.mock('sidekick-shared', () => ({
  readClaudeMaxCredentials: (...args: unknown[]) => mockReadClaudeMaxCredentials(...args),
  fetchQuota: (...args: unknown[]) => mockFetchQuota(...args),
}));

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

  it('keeps cached quota on retryable failures', async () => {
    mockReadClaudeMaxCredentials.mockResolvedValue({ accessToken: 'token' });
    mockFetchQuota
      .mockResolvedValueOnce({
        fiveHour: { utilization: 10, resetsAt: '2026-03-12T14:00:00Z' },
        sevenDay: { utilization: 20, resetsAt: '2026-03-13T12:00:00Z' },
        available: true,
      })
      .mockResolvedValueOnce({
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
        error: 'Network error',
        failureKind: 'network',
      });

    const service = new QuotaService();
    const updates: unknown[] = [];
    service.onUpdate((quota) => updates.push(quota));

    await service.fetchQuota();
    await service.fetchQuota();

    expect(updates).toHaveLength(1);
    expect(service.getCached()).toMatchObject({
      available: true,
      fiveHour: { utilization: 10, resetsAt: '2026-03-12T14:00:00Z' },
    });
  });

  it('replaces cached quota on auth failures', async () => {
    mockReadClaudeMaxCredentials.mockResolvedValue({ accessToken: 'token' });
    mockFetchQuota
      .mockResolvedValueOnce({
        fiveHour: { utilization: 10, resetsAt: '2026-03-12T14:00:00Z' },
        sevenDay: { utilization: 20, resetsAt: '2026-03-13T12:00:00Z' },
        available: true,
      })
      .mockResolvedValueOnce({
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
        error: 'Sign in to Claude Code to view quota',
        failureKind: 'auth',
        httpStatus: 401,
      });

    const service = new QuotaService();

    await service.fetchQuota();
    await service.fetchQuota();

    expect(service.getCached()).toMatchObject({
      available: false,
      failureKind: 'auth',
      httpStatus: 401,
    });
  });

  it('replaces cached quota on unknown failures', async () => {
    mockReadClaudeMaxCredentials.mockResolvedValue({ accessToken: 'token' });
    mockFetchQuota
      .mockResolvedValueOnce({
        fiveHour: { utilization: 10, resetsAt: '2026-03-12T14:00:00Z' },
        sevenDay: { utilization: 20, resetsAt: '2026-03-13T12:00:00Z' },
        available: true,
      })
      .mockResolvedValueOnce({
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
        error: 'API error: 403',
        failureKind: 'unknown',
        httpStatus: 403,
      });

    const service = new QuotaService();

    await service.fetchQuota();
    await service.fetchQuota();

    expect(service.getCached()).toMatchObject({
      available: false,
      failureKind: 'unknown',
      httpStatus: 403,
    });
  });
});
