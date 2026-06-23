import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFetchPeakHoursStatus,
  mockShowInformationMessage,
  configState,
  configurationListeners,
} = vi.hoisted(() => ({
  mockFetchPeakHoursStatus: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  configState: {
    enabled: true,
    notifyOnTransition: false,
  },
  configurationListeners: [] as Array<
    (event: { affectsConfiguration: (section: string) => boolean }) => void
  >,
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
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, fallback: unknown) => {
        if (section === 'sidekick.peakHours' && key === 'enabled') return configState.enabled;
        if (section === 'sidekick.peakHours' && key === 'notifyOnTransition')
          return configState.notifyOnTransition;
        return fallback;
      },
    }),
    onDidChangeConfiguration: (
      listener: (event: { affectsConfiguration: (section: string) => boolean }) => void,
    ) => {
      configurationListeners.push(listener);
      return {
        dispose: () => {
          const index = configurationListeners.indexOf(listener);
          if (index >= 0) configurationListeners.splice(index, 1);
        },
      };
    },
  },
  window: {
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
  },
}));

vi.mock('sidekick-shared', () => ({
  fetchPeakHoursStatus: (...args: unknown[]) => mockFetchPeakHoursStatus(...args),
  isClaudeCodeSessionProvider: (providerId: string) => providerId === 'claude-code',
}));

vi.mock('./Logger', () => ({
  log: vi.fn(),
}));

import { PeakHoursService } from './PeakHoursService';
import type { PeakHoursState, ProviderId } from 'sidekick-shared';

function peakHoursState(): PeakHoursState {
  return {
    status: 'peak',
    isPeak: true,
    sessionLimitSpeed: 'faster',
    label: 'Peak Hours',
    peakHoursDescription: 'Weekdays 1pm-7pm UTC',
    nextChange: '2026-05-27T19:00:00.000Z',
    minutesUntilChange: 90,
    note: '',
    updatedAt: '2026-05-27T17:30:00.000Z',
    unavailable: false,
  };
}

describe('PeakHoursService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.enabled = true;
    configState.notifyOnTransition = false;
    configurationListeners.splice(0, configurationListeners.length);
    mockFetchPeakHoursStatus.mockResolvedValue(peakHoursState());
  });

  it('fetches when inference and session providers are both Claude Code applicable', async () => {
    const authService = { getProviderId: () => 'claude-max' };
    const service = new PeakHoursService(authService as never, () => 'claude-code');

    const result = await service.fetchStatus();

    expect(mockFetchPeakHoursStatus).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'peak', isPeak: true });
    expect(service.getCachedStatus()).toMatchObject({ status: 'peak' });

    service.dispose();
  });

  it('does not fetch and clears cached status for Codex sessions', async () => {
    let sessionProviderId: ProviderId = 'claude-code';
    const authService = { getProviderId: () => 'claude-max' };
    const service = new PeakHoursService(authService as never, () => sessionProviderId);
    const updates: Array<PeakHoursState | null> = [];
    service.onStatusUpdate((state) => updates.push(state));

    await service.fetchStatus();
    sessionProviderId = 'codex';
    const result = await service.fetchStatus();

    expect(result).toBeNull();
    expect(mockFetchPeakHoursStatus).toHaveBeenCalledOnce();
    expect(service.getCachedStatus()).toBeNull();
    expect(updates[updates.length - 1]).toBeNull();

    service.dispose();
  });

  it('reconciles provider switches by clearing stale peak-hours state', async () => {
    let sessionProviderId: ProviderId = 'claude-code';
    const authService = { getProviderId: () => 'claude-max' };
    const service = new PeakHoursService(authService as never, () => sessionProviderId);
    const updates: Array<PeakHoursState | null> = [];
    service.onStatusUpdate((state) => updates.push(state));

    await service.fetchStatus();
    sessionProviderId = 'codex';
    service.reconcile();

    expect(service.getCachedStatus()).toBeNull();
    expect(updates[updates.length - 1]).toBeNull();

    service.dispose();
  });
});
