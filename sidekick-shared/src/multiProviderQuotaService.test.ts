import { describe, expect, it, vi } from 'vitest';
import { MultiProviderQuotaService } from './multiProviderQuotaService';
import type { PeakHoursState } from './peakHours';
import type { ProviderQuotaMap, ProviderQuotaState } from './providerQuota';

function peakHours(): PeakHoursState {
  return {
    status: 'off_peak',
    isPeak: false,
    sessionLimitSpeed: 'normal',
    label: 'Off-Peak',
    peakHoursDescription: '',
    nextChange: null,
    minutesUntilChange: null,
    note: '',
    updatedAt: '2026-05-08T10:00:00Z',
    unavailable: false,
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MultiProviderQuotaService', () => {
  it('emits Claude quota with peak-hours and account details', async () => {
    const updates: ProviderQuotaMap[] = [];
    const service = new MultiProviderQuotaService({
      readClaudeCredentials: async () => ({ accessToken: 'token' }),
      readClaudeAccount: () => ({ email: 'claude@example.com', source: 'live' as const }),
      fetchPeakHours: async () => peakHours(),
      fetchClaudeQuota: async () => ({
        fiveHour: { utilization: 12, resetsAt: '2026-05-08T12:00:00Z' },
        sevenDay: { utilization: 34, resetsAt: '2026-05-09T12:00:00Z' },
        available: true,
      }),
    });
    service.onUpdate((update) => updates.push(update));

    service.startPolling();
    await flushPromises();
    service.dispose();

    expect(updates[0].claude).toMatchObject({
      runtimeProvider: 'claude',
      providerId: 'claude-code',
      available: true,
      accountLabel: 'claude@example.com',
      accountDetail: 'claude@example.com',
      peakHours: { label: 'Off-Peak' },
    });
  });

  it('surfaces the saved profile label, keeping the email as the detail', async () => {
    const updates: ProviderQuotaMap[] = [];
    const service = new MultiProviderQuotaService({
      readClaudeCredentials: async () => ({ accessToken: 'token' }),
      readClaudeAccount: () => ({
        email: 'work@example.com',
        label: 'Work',
        source: 'live' as const,
      }),
      fetchPeakHours: async () => peakHours(),
      fetchClaudeQuota: async () => ({
        fiveHour: { utilization: 12, resetsAt: '2026-05-08T12:00:00Z' },
        sevenDay: { utilization: 34, resetsAt: '2026-05-09T12:00:00Z' },
        available: true,
      }),
    });
    service.onUpdate((update) => updates.push(update));

    service.startPolling();
    await flushPromises();
    service.dispose();

    expect(updates[0].claude).toMatchObject({
      accountLabel: 'Work',
      accountDetail: 'work@example.com',
    });
  });

  it('merges externally pushed Codex quota into the provider map', () => {
    const updates: ProviderQuotaMap[] = [];
    const service = new MultiProviderQuotaService({ includePeakHours: false });
    service.onUpdate((update) => updates.push(update));

    const codex: ProviderQuotaState<'codex'> = {
      runtimeProvider: 'codex',
      providerId: 'codex',
      fiveHour: { utilization: 55, resetsAt: '2026-05-08T12:00:00Z' },
      sevenDay: { utilization: 66, resetsAt: '2026-05-09T12:00:00Z' },
      available: true,
    };
    service.updateProviderQuota('codex', codex);
    service.dispose();

    expect(updates[0]).toEqual({
      codex,
    });
  });

  it('emits cached Claude quota with stale and error metadata after a transient failure', async () => {
    vi.useFakeTimers();
    try {
      const updates: ProviderQuotaMap[] = [];
      const fetchClaudeQuota = vi
        .fn()
        .mockResolvedValueOnce({
          fiveHour: { utilization: 12, resetsAt: '2026-05-08T12:00:00Z' },
          sevenDay: { utilization: 34, resetsAt: '2026-05-09T12:00:00Z' },
          available: true,
        })
        .mockResolvedValueOnce({
          fiveHour: { utilization: 0, resetsAt: '' },
          sevenDay: { utilization: 0, resetsAt: '' },
          available: false,
          error: 'API error: 503',
          failureKind: 'server' as const,
          httpStatus: 503,
        });
      const service = new MultiProviderQuotaService({
        includePeakHours: false,
        activeIntervalMs: 1,
        idleIntervalMs: 1,
        transientFailureBackoffMs: [1],
        readClaudeCredentials: async () => ({ accessToken: 'token' }),
        readClaudeAccount: () => ({ source: 'none' as const }),
        fetchClaudeQuota,
      });
      service.onUpdate((update) => updates.push(update));

      service.startPolling();
      await vi.advanceTimersByTimeAsync(0);
      service.setPollingMode('active');
      await vi.advanceTimersByTimeAsync(1);

      expect(updates).toHaveLength(2);
      expect(updates[1].claude).toMatchObject({
        available: true,
        source: 'cache',
        stale: true,
        error: 'API error: 503',
        failureKind: 'server',
        httpStatus: 503,
        fiveHour: { utilization: 12 },
      });
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
