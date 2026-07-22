import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  statusBarItem: {
    text: '',
    tooltip: '' as string | undefined,
    backgroundColor: undefined as unknown,
    command: '',
    show: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock('vscode', () => ({
  window: { createStatusBarItem: () => mocks.statusBarItem },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class ThemeColor {
    constructor(public readonly id: string) {}
  },
}));
vi.mock('sidekick-shared', () => ({
  formatTokenCount: (value: number) => String(value),
}));
vi.mock('sidekick-shared/phrases', () => ({ getRandomPhrase: () => 'phrase' }));
vi.mock('./SessionMonitor', () => ({ SessionMonitor: class SessionMonitor {} }));

import { MonitorStatusBar } from './MonitorStatusBar';

afterEach(() => vi.useRealTimers());

describe('MonitorStatusBar', () => {
  it('renders the latest totals at the trailing edge of a token burst', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let onTokenUsage: (() => void) | undefined;
    const stats = {
      totalInputTokens: 100,
      totalOutputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      currentContextSize: 100,
      lastModelId: 'model',
    };
    const disposable = { dispose: vi.fn() };
    const monitor = {
      isReplaying: false,
      isActive: () => false,
      onSessionStart: () => disposable,
      onSessionEnd: () => disposable,
      onReplayStateChange: () => disposable,
      onTokenUsage: (handler: () => void) => {
        onTokenUsage = handler;
        return disposable;
      },
      getStats: () => stats,
      getProvider: () => ({
        id: 'claude-code',
        displayName: 'Claude Code',
        getContextWindowLimit: () => 1_000,
      }),
      getAggregatedMetrics: () => ({ permissionMode: null }),
    };
    const statusBar = new MonitorStatusBar(monitor as never);

    onTokenUsage!();
    expect(mocks.statusBarItem.text).toContain('100');
    stats.totalInputTokens = 250;
    onTokenUsage!();
    expect(mocks.statusBarItem.text).toContain('100');

    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.statusBarItem.text).toContain('250');
    statusBar.dispose();
  });
});
