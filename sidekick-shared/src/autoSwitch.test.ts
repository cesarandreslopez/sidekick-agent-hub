import { describe, expect, it, vi } from 'vitest';
import {
  AutoSwitchController,
  DEFAULT_AUTO_SWITCH_CONFIG,
  decideAutoSwitch,
  type AutoSwitchCandidate,
} from './autoSwitch';
import type { ProviderQuotaMap } from './providerQuota';
import type { QuotaState } from './quota';

function quota(utilization: number): QuotaState {
  return {
    fiveHour: { utilization, resetsAt: '2026-01-01T05:00:00Z' },
    sevenDay: { utilization: 0, resetsAt: '2026-01-08T00:00:00Z' },
    available: true,
  };
}

function claudeQuota(utilization: number): ProviderQuotaMap {
  return {
    claude: {
      ...quota(utilization),
      runtimeProvider: 'claude',
      providerId: 'claude-code',
    },
  };
}

class FakeQuotaService {
  private listeners: Array<(state: ProviderQuotaMap) => void> = [];

  onUpdate(cb: (state: ProviderQuotaMap) => void): { dispose(): void } {
    this.listeners.push(cb);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(cb);
        if (index >= 0) this.listeners.splice(index, 1);
      },
    };
  }

  emit(state: ProviderQuotaMap): void {
    for (const listener of [...this.listeners]) listener(state);
  }
}

describe('decideAutoSwitch', () => {
  const candidates: AutoSwitchCandidate[] = [
    { accountId: 'active', quota: quota(95) },
    { accountId: 'better', quota: quota(25) },
    { accountId: 'worse', quota: quota(98) },
  ];

  it('defaults to disabled', () => {
    expect(DEFAULT_AUTO_SWITCH_CONFIG).toEqual({ enabled: false, thresholdPct: 90 });
    expect(
      decideAutoSwitch('claude-code', { accountId: 'active', quota: quota(95) }, candidates),
    ).toBeNull();
  });

  it('returns null when disabled, under threshold, or no candidate is materially better', () => {
    expect(
      decideAutoSwitch('claude-code', { accountId: 'active', quota: quota(95) }, candidates, {
        enabled: false,
        thresholdPct: 90,
      }),
    ).toBeNull();
    expect(
      decideAutoSwitch('claude-code', { accountId: 'active', quota: quota(50) }, candidates, {
        enabled: true,
        thresholdPct: 90,
      }),
    ).toBeNull();
    expect(
      decideAutoSwitch(
        'claude-code',
        { accountId: 'active', quota: quota(95) },
        [{ accountId: 'slightly-better', quota: quota(91) }],
        { enabled: true, thresholdPct: 90 },
      ),
    ).toBeNull();
  });

  it('returns the best candidate when active quota crosses threshold', () => {
    expect(
      decideAutoSwitch('claude-code', { accountId: 'active', quota: quota(95) }, candidates, {
        enabled: true,
        thresholdPct: 90,
      }),
    ).toEqual({ switchTo: 'better' });
  });
});

describe('AutoSwitchController', () => {
  it('switches once per threshold crossing and emits one transition', () => {
    const quotaService = new FakeQuotaService();
    const switchAccount = vi.fn(() => ({ success: true }));
    const onTransition = vi.fn();
    const controller = new AutoSwitchController({
      quotaService,
      config: { enabled: true, thresholdPct: 90 },
      getClaudeAccounts: () => [
        { uuid: 'active', email: 'active@example.com', addedAt: '2026-01-01T00:00:00Z' },
        { uuid: 'better', email: 'better@example.com', addedAt: '2026-01-01T00:00:00Z' },
      ],
      getActiveClaudeAccount: () => ({
        uuid: 'active',
        email: 'active@example.com',
        addedAt: '2026-01-01T00:00:00Z',
      }),
      readSnapshot: (_provider, accountId) => (accountId === 'better' ? quota(20) : quota(95)),
      switchAccount,
      onTransition,
    });

    controller.start();
    quotaService.emit(claudeQuota(95));
    quotaService.emit(claudeQuota(96));

    expect(switchAccount).toHaveBeenCalledTimes(1);
    expect(switchAccount).toHaveBeenCalledWith('claude-code', 'better');
    expect(onTransition).toHaveBeenCalledTimes(1);

    quotaService.emit(claudeQuota(20));
    quotaService.emit(claudeQuota(95));

    expect(switchAccount).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('does not switch when disabled or when only one saved account exists', () => {
    const quotaService = new FakeQuotaService();
    const switchAccount = vi.fn(() => ({ success: true }));
    const disabled = new AutoSwitchController({
      quotaService,
      config: { enabled: false, thresholdPct: 90 },
      getClaudeAccounts: () => [
        { uuid: 'active', email: 'active@example.com', addedAt: '2026-01-01T00:00:00Z' },
        { uuid: 'better', email: 'better@example.com', addedAt: '2026-01-01T00:00:00Z' },
      ],
      getActiveClaudeAccount: () => ({
        uuid: 'active',
        email: 'active@example.com',
        addedAt: '2026-01-01T00:00:00Z',
      }),
      readSnapshot: () => quota(20),
      switchAccount,
    });
    const singleAccount = new AutoSwitchController({
      quotaService,
      config: { enabled: true, thresholdPct: 90 },
      getClaudeAccounts: () => [
        { uuid: 'active', email: 'active@example.com', addedAt: '2026-01-01T00:00:00Z' },
      ],
      getActiveClaudeAccount: () => ({
        uuid: 'active',
        email: 'active@example.com',
        addedAt: '2026-01-01T00:00:00Z',
      }),
      readSnapshot: () => quota(20),
      switchAccount,
    });

    disabled.start();
    singleAccount.start();
    quotaService.emit(claudeQuota(95));

    expect(switchAccount).not.toHaveBeenCalled();
    disabled.dispose();
    singleAccount.dispose();
  });
});
