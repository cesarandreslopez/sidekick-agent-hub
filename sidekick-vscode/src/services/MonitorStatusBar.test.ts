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
  // Mirror the real helper: every billed bucket, cache included.
  summarizeTokens: (t: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
  }) => ({
    total: t.inputTokens + t.outputTokens + (t.cacheWriteTokens ?? 0) + (t.cacheReadTokens ?? 0),
  }),
  formatTokenBreakdown: (summary: { total: number }) => `${summary.total} total incl. cache`,
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
      getStatsView: () => stats,
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

  it.each([
    ['auto', '$(sparkle)', 'Auto (classifier'],
    ['dontAsk', '$(circle-slash)', "Don't Ask"],
  ])('labels the %s permission mode', (permissionMode, icon, label) => {
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
      getStatsView: () => stats,
      getProvider: () => ({
        id: 'claude-code',
        displayName: 'Claude Code',
        getContextWindowLimit: () => 1_000,
      }),
      getAggregatedMetrics: () => ({ permissionMode }),
    };
    const statusBar = new MonitorStatusBar(monitor as never);
    onTokenUsage!();
    expect(mocks.statusBarItem.text).toContain(icon);
    expect(String(mocks.statusBarItem.tooltip)).toContain(label);
    statusBar.dispose();
  });

  it('turns Live into Viewing once a session has been quiet for the live window', () => {
    vi.useFakeTimers();
    const lastWrite = new Date(Date.now() - 60_000);
    const stats = {
      totalInputTokens: 10,
      totalOutputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      currentContextSize: 1,
      lastModelId: 'model',
    };
    const disposable = { dispose: vi.fn() };
    const monitor = {
      isReplaying: false,
      isActive: () => true,
      getSessionPath: () => '/sessions/now.jsonl',
      onSessionStart: () => disposable,
      onSessionEnd: () => disposable,
      onReplayStateChange: () => disposable,
      onTokenUsage: () => disposable,
      getStats: () => stats,
      getStatsView: () => stats,
      getProvider: () => ({
        id: 'claude-code',
        displayName: 'Claude Code',
        getContextWindowLimit: () => 1_000,
        // No further writes: the session simply goes quiet.
        getSessionMetadata: () => ({ mtime: lastWrite }),
      }),
      getAggregatedMetrics: () => ({ permissionMode: null }),
    };
    const statusBar = new MonitorStatusBar(monitor as never);
    expect(mocks.statusBarItem.text).toContain('$(pulse)');

    // No event fires; only the ticker can notice the 2-minute window pass.
    vi.advanceTimersByTime(90_000);
    expect(mocks.statusBarItem.text).toContain('$(eye)');
    statusBar.dispose();
  });

  it('keeps the screen-reader label in step with the session, and marks a past one as Viewing', () => {
    let onTokenUsage: (() => void) | undefined;
    let onSessionEnd: (() => void) | undefined;
    const stats = {
      totalInputTokens: 1200,
      totalOutputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      currentContextSize: 100,
      lastModelId: 'model',
    };
    const disposable = { dispose: vi.fn() };
    const monitor = {
      isReplaying: false,
      isActive: () => true,
      // A session last written a week ago: attached, but not live.
      getSessionPath: () => '/sessions/old.jsonl',
      onSessionStart: () => disposable,
      onSessionEnd: (handler: () => void) => {
        onSessionEnd = handler;
        return disposable;
      },
      onReplayStateChange: () => disposable,
      onTokenUsage: (handler: () => void) => {
        onTokenUsage = handler;
        return disposable;
      },
      getStats: () => stats,
      getStatsView: () => stats,
      getProvider: () => ({
        id: 'claude-code',
        displayName: 'Claude Code',
        getContextWindowLimit: () => 1_000,
        getSessionMetadata: () => ({ mtime: new Date(Date.now() - 7 * 24 * 3600_000) }),
      }),
      getAggregatedMetrics: () => ({ permissionMode: null }),
    };
    const item = mocks.statusBarItem as typeof mocks.statusBarItem & {
      accessibilityInformation?: { label: string };
    };
    const statusBar = new MonitorStatusBar(monitor as never);

    onTokenUsage!();
    expect(item.text).toContain('$(eye)');
    expect(item.accessibilityInformation?.label).toMatch(
      /^Sidekick session \(Viewing\): 1200 tokens/,
    );
    expect(String(item.tooltip)).toContain('Claude Code Session · Viewing');

    onSessionEnd!();
    expect(item.accessibilityInformation?.label).toBe('Sidekick session: no session');
    statusBar.dispose();
  });
});
