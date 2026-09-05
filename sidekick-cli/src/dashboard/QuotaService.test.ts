import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveQuota } = vi.hoisted(() => ({
  mockResolveQuota: vi.fn(),
}));

vi.mock('sidekick-shared', async () => {
  const actual = await vi.importActual<typeof import('sidekick-shared')>('sidekick-shared');
  return {
    ...actual,
    resolveQuota: (...args: unknown[]) => mockResolveQuota(...args),
  };
});

import { QuotaService } from './QuotaService';

describe('QuotaService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchOnce surfaces the resolver auth failure when credentials are missing', async () => {
    mockResolveQuota.mockResolvedValue({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'No OAuth token available',
      failureKind: 'auth',
      resolution: 'unavailable',
    });

    const service = new QuotaService();
    const result = await service.fetchOnce();

    expect(result).toMatchObject({
      available: false,
      error: 'No OAuth token available',
      failureKind: 'auth',
    });
  });

  it('fetchOnce resolves Claude quota through the shared resolver', async () => {
    mockResolveQuota.mockResolvedValue({
      fiveHour: { utilization: 5, resetsAt: '2026-03-12T14:00:00Z' },
      sevenDay: { utilization: 8, resetsAt: '2026-03-13T12:00:00Z' },
      available: true,
      resolution: 'snapshot-fresh',
    });

    const service = new QuotaService();
    const result = await service.fetchOnce();

    expect(result).toMatchObject({ available: true, fiveHour: { utilization: 5 } });
    // Same call `sidekick quota` makes, so the dashboard's first paint agrees with it.
    expect(mockResolveQuota).toHaveBeenCalledWith({ providerId: 'claude-code' });
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
