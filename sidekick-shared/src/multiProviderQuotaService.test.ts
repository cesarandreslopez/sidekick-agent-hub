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
  return new Promise(resolve => setImmediate(resolve));
}

describe('MultiProviderQuotaService', () => {
  it('emits Claude quota with peak-hours and account details', async () => {
    const updates: ProviderQuotaMap[] = [];
    const service = new MultiProviderQuotaService({
      readClaudeCredentials: async () => ({ accessToken: 'token' }),
      readClaudeAccount: () => ({ email: 'claude@example.com', uuid: 'claude-account' }),
      fetchPeakHours: async () => peakHours(),
      fetchClaudeQuota: async () => ({
        fiveHour: { utilization: 12, resetsAt: '2026-05-08T12:00:00Z' },
        sevenDay: { utilization: 34, resetsAt: '2026-05-09T12:00:00Z' },
        available: true,
      }),
    });
    service.onUpdate(update => updates.push(update));

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

  it('merges externally pushed Codex quota into the provider map', () => {
    const updates: ProviderQuotaMap[] = [];
    const service = new MultiProviderQuotaService({ includePeakHours: false });
    service.onUpdate(update => updates.push(update));

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
});
