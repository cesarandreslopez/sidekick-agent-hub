import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadClaudeMaxCredentials, mockFetchQuota, mockLog, mockPollerStart, mockPollerStop } =
  vi.hoisted(() => ({
    mockReadClaudeMaxCredentials: vi.fn(),
    mockFetchQuota: vi.fn(),
    mockLog: vi.fn(),
    mockPollerStart: vi.fn(),
    mockPollerStop: vi.fn(),
  }));

vi.mock('vscode', () => ({
  default: {},
  EventEmitter: class<T> {
    private listeners = new Set<(value: T) => void>();

    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
      this.listeners.clear();
    }
  },
}));

vi.mock('sidekick-shared', () => ({
  readClaudeMaxCredentials: (...args: unknown[]) => mockReadClaudeMaxCredentials(...args),
  fetchQuota: (...args: unknown[]) => mockFetchQuota(...args),
  quotaHistoryWindow: (window: { utilization: number; resetsAt: string; absent?: boolean }) => ({
    utilization: window.utilization,
    resetsAt: window.resetsAt,
    ...(window.absent ? { absent: true } : {}),
  }),
  QuotaPoller: class {
    start = mockPollerStart;
    stop = mockPollerStop;
    onUpdate() {
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock('./Logger', () => ({
  log: (...args: unknown[]) => mockLog(...args),
}));

import { QuotaService } from './QuotaService';

describe('QuotaService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits an auth failure when credentials are missing', async () => {
    mockReadClaudeMaxCredentials.mockResolvedValue(null);

    const service = new QuotaService();
    const updates: unknown[] = [];
    service.onQuotaUpdate((quota) => updates.push(quota));

    const result = await service.fetchQuota();

    expect(result).toMatchObject({
      available: false,
      error: 'No OAuth token available',
      failureKind: 'auth',
    });
    expect(updates).toHaveLength(1);
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
        error: 'API error: 503',
        failureKind: 'server',
        httpStatus: 503,
      });

    const service = new QuotaService();
    const updates: unknown[] = [];
    service.onQuotaUpdate((quota) => updates.push(quota));

    await service.fetchQuota();
    const result = await service.fetchQuota();

    expect(result).toMatchObject({
      available: true,
      fiveHour: { utilization: 10, resetsAt: '2026-03-12T14:00:00Z' },
      source: 'cache',
      stale: true,
      error: 'API error: 503',
    });
    expect(updates).toHaveLength(2);
  });

  it('replaces cached quota on auth failures and emits the error', async () => {
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
    const updates: unknown[] = [];
    const errors: string[] = [];
    service.onQuotaUpdate((quota) => updates.push(quota));
    service.onQuotaError((error) => errors.push(error));

    await service.fetchQuota();
    const result = await service.fetchQuota();

    expect(result).toMatchObject({
      available: false,
      failureKind: 'auth',
      httpStatus: 401,
    });
    expect(updates).toHaveLength(2);
    expect(errors).toEqual(['Sign in to Claude Code to view quota']);
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
    const result = await service.fetchQuota();

    expect(result).toMatchObject({
      available: false,
      failureKind: 'unknown',
      httpStatus: 403,
    });
  });

  it('passes the credential plan facts so the quota carries a plan label', async () => {
    const creds = {
      accessToken: 'token',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    };
    mockReadClaudeMaxCredentials.mockResolvedValue(creds);
    mockFetchQuota.mockResolvedValueOnce({
      fiveHour: { utilization: 0, resetsAt: '', absent: true },
      sevenDay: { utilization: 17, resetsAt: '2026-11-07T06:00:00Z' },
      available: true,
      planLabel: 'Ultra',
    });

    const service = new QuotaService();
    const result = await service.fetchQuota();

    expect(mockFetchQuota).toHaveBeenCalledWith('token', { plan: creds });
    expect(result).toMatchObject({ planLabel: 'Ultra', fiveHour: { absent: true } });
  });

  it('delegates refresh lifecycle to the shared poller', () => {
    const service = new QuotaService();

    service.startRefresh();
    service.startRefresh();
    service.stopRefresh();

    expect(mockPollerStart).toHaveBeenCalledTimes(1);
    expect(mockPollerStop).toHaveBeenCalledTimes(1);
  });
});
