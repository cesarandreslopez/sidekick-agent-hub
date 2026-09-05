import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
  Uri: {
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: path.join(base.fsPath, ...segments),
    }),
  },
  extensions: {
    getExtension: () => ({ packageJSON: { version: '0.0.0-test' } }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  window: {
    createWebviewPanel: vi.fn(),
    // Charts bake colors into the canvas, so the provider subscribes to theme
    // changes to re-resolve them.
    onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock('../services/Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

import { formatLocalDateKey } from 'sidekick-shared';
import { DashboardViewProvider } from './DashboardViewProvider';

// The behaviour lives in the bundled legacy module now; the document only
// loads it. Script assertions therefore read the module source.
const legacyScript = fs.readFileSync(
  path.join(__dirname, '..', 'webview', 'dashboard', 'legacy.ts'),
  'utf8',
);

function disposable() {
  return { dispose: vi.fn() };
}

function makeSessionMonitor() {
  const handlers: { tokenUsage?: (usage: unknown) => void; timeline?: (event: unknown) => void } =
    {};
  return {
    handlers,
    getStatsView: vi.fn(() => ({ sessionStartTime: null, planState: undefined })),
    getStats: vi.fn(() => ({ sessionStartTime: null, planState: undefined })),
    onTokenUsage: vi.fn((handler: (usage: unknown) => void) => {
      handlers.tokenUsage = handler;
      return disposable();
    }),
    onTimelineEvent: vi.fn((handler: (event: unknown) => void) => {
      handlers.timeline = handler;
      return disposable();
    }),
    onSessionStart: vi.fn(() => disposable()),
    onSessionEnd: vi.fn(() => disposable()),
    onToolAnalytics: vi.fn(() => disposable()),
    onDiscoveryModeChange: vi.fn(() => disposable()),
    onLatencyUpdate: vi.fn(() => disposable()),
    onCompaction: vi.fn(() => disposable()),
    onTruncation: vi.fn(() => disposable()),
    onQuotaUpdate: vi.fn(() => disposable()),
    isActive: vi.fn(() => false),
    getAllSessionsGrouped: vi.fn(() => []),
    isPinned: vi.fn(() => false),
    getCustomPath: vi.fn(() => null),
    isUsingCustomPath: vi.fn(() => false),
    getProvider: vi.fn(() => ({ id: 'codex', displayName: 'Codex CLI' })),
    getState: vi.fn(() => ({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      totalCost: 0,
      contextUsagePercent: 0,
      modelBreakdown: [],
      sessionActive: false,
      lastUpdated: '2026-07-02T12:00:00Z',
      toolAnalytics: [],
      timeline: [],
      errorDetails: [],
    })),
  };
}

describe('DashboardViewProvider quota UI', () => {
  it('handles quota history, context health, and truncations in the loaded inline script', () => {
    const provider = new DashboardViewProvider(
      { fsPath: '/tmp/sidekick-extension' } as never,
      makeSessionMonitor() as never,
    );
    const webview = {
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: { fsPath: string }) => `vscode-resource:${uri.fsPath}`,
    };
    const html = (
      provider as unknown as { _getHtmlForWebview(input: typeof webview): string }
    )._getHtmlForWebview(webview);
    const rendered = html + legacyScript;

    expect(rendered).toContain("case 'updateQuotaHistory'");
    expect(rendered).toContain("case 'updateContextHealth'");
    expect(rendered).toContain("case 'updateTruncations'");
    expect(rendered).toContain('function renderQuotaHistory');
    expect(rendered).toContain('function updateContextHealthDisplay');
    expect(rendered).toContain('function updateTruncationDisplay');
    expect(rendered).toContain('(t.totalCalls || 0)');
    provider.dispose();
  });

  it('sends only the stats payload from the token hot-path state sender', () => {
    const provider = new DashboardViewProvider(
      { fsPath: '/tmp/sidekick-extension' } as never,
      makeSessionMonitor() as never,
    );
    const postMessage = vi.fn();
    (
      provider as unknown as {
        _view: { webview: { postMessage: typeof postMessage } };
        _sendStateToWebview(): void;
      }
    )._view = { webview: { postMessage } };

    (
      provider as unknown as {
        _sendStateToWebview(): void;
      }
    )._sendStateToWebview();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateStats' }));
    expect(postMessage.mock.calls[0][0].state).not.toHaveProperty('timeline');
    provider.dispose();
  });

  it('coalesces a burst of token-usage and timeline events into one post per kind', () => {
    vi.useFakeTimers();
    try {
      const monitor = makeSessionMonitor();
      const provider = new DashboardViewProvider(
        { fsPath: '/tmp/sidekick-extension' } as never,
        monitor as never,
      );
      const postMessage = vi.fn();
      (provider as unknown as { _view: unknown })._view = {
        visible: true,
        webview: { postMessage },
      };

      const usage = {
        model: 'gpt-5.4',
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        timestamp: new Date('2026-09-04T12:00:00Z'),
      };
      for (let i = 0; i < 10; i += 1) monitor.handlers.tokenUsage!(usage);
      for (let i = 0; i < 3; i += 1) {
        monitor.handlers.timeline!({
          type: 'tool_call',
          timestamp: new Date('2026-09-04T12:00:00Z'),
          description: `call ${i}`,
        });
      }
      expect(postMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);
      const types = postMessage.mock.calls.map((call) => call[0].type);
      expect(types.filter((type) => type === 'updateStats')).toHaveLength(1);
      expect(types.filter((type) => type === 'updateTimeline')).toHaveLength(1);
      expect(types.filter((type) => type === 'updateBurnRate')).toHaveLength(1);
      const stats = postMessage.mock.calls.find((call) => call[0].type === 'updateStats')![0];
      expect(stats.state).not.toHaveProperty('timeline');
      expect(stats.state.totalInputTokens).toBe(100);

      // Nothing else is pending once the burst has flushed.
      vi.advanceTimersByTime(1_000);
      expect(postMessage.mock.calls.filter((call) => call[0].type === 'updateStats')).toHaveLength(
        1,
      );
      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the resolved view and its bindings when VS Code disposes it', () => {
    const provider = new DashboardViewProvider(
      { fsPath: '/tmp/sidekick-extension' } as never,
      makeSessionMonitor() as never,
    );
    let fireDispose: (() => void) | undefined;
    const view = {
      visible: true,
      webview: {
        cspSource: 'vscode-webview:',
        options: {},
        html: '',
        asWebviewUri: (uri: { fsPath: string }) => `vscode-resource:${uri.fsPath}`,
        postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn(() => disposable()),
      },
      onDidChangeVisibility: vi.fn(() => disposable()),
      onDidDispose: vi.fn((listener: () => void) => {
        fireDispose = listener;
        return disposable();
      }),
    };

    provider.resolveWebviewView(view as never, {} as never, {} as never);
    expect((provider as unknown as { _view?: unknown })._view).toBe(view);

    fireDispose?.();
    expect((provider as unknown as { _view?: unknown })._view).toBeUndefined();
    provider.dispose();
  });

  it('includes Codex reset-credit rendering in the quota panel', () => {
    const provider = new DashboardViewProvider(
      { fsPath: '/tmp/sidekick-extension' } as never,
      makeSessionMonitor() as never,
    );
    const webview = {
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: { fsPath: string }) => `vscode-resource:${uri.fsPath}`,
    };

    const html = (
      provider as unknown as {
        _getHtmlForWebview(webview: typeof webview): string;
      }
    )._getHtmlForWebview(webview);
    const rendered = html + legacyScript;

    expect(rendered).toContain('id="quota-reset-credits"');
    expect(rendered).toContain('function renderResetCredits');
    expect(rendered).toContain('quota.resetCredits');

    provider.dispose();
  });

  it('keeps session and remote strings out of executable HTML sinks', () => {
    const provider = new DashboardViewProvider(
      { fsPath: '/tmp/sidekick-extension' } as never,
      makeSessionMonitor() as never,
    );
    const webview = {
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: { fsPath: string }) => `vscode-resource:${uri.fsPath}`,
    };
    const html = (
      provider as unknown as {
        _getHtmlForWebview(webview: typeof webview): string;
      }
    )._getHtmlForWebview(webview);
    const rendered = html + legacyScript;

    expect(rendered).toContain('function setTimelineDescription');
    expect(rendered).toContain("descEl.textContent = text || ''");
    expect(rendered).not.toContain('descEl.innerHTML = truncated');
    expect(rendered).not.toContain('descEl.innerHTML = full');
    expect(rendered).toContain("escapeHtml(status.label || 'Peak Hours')");
    expect(rendered).toContain('escapeHtml(status.peakHoursDescription)');
    expect(rendered).toContain('escapeHtml(step.description)');
    expect(rendered).toContain('escapeHtml(step.errorMessage.substring(0, 100))');
    expect(rendered).toContain('escapeHtml(rp.title)');

    provider.dispose();
  });

  it('escapes script-closing sequences in embedded JSON', () => {
    const provider = new DashboardViewProvider(
      { fsPath: '/tmp/sidekick-extension' } as never,
      makeSessionMonitor() as never,
    );

    const encoded = (
      provider as unknown as { _safeJsonForScript(data: unknown): string }
    )._safeJsonForScript({ title: '</script><script>alert(1)</script>' });

    expect(encoded).not.toContain('</script>');
    expect(encoded).toContain('\\u003c/script\\u003e');
    provider.dispose();
  });

  it('resolves chart colors from the active theme rather than hardcoded greys', () => {
    const provider = new DashboardViewProvider(
      { fsPath: '/tmp/sidekick-extension' } as never,
      makeSessionMonitor() as never,
    );
    const webview = {
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: { fsPath: string }) => `vscode-resource:${uri.fsPath}`,
    };
    const html = (
      provider as unknown as { _getHtmlForWebview(input: typeof webview): string }
    )._getHtmlForWebview(webview);
    const rendered = html + legacyScript;

    // The dark-theme literals that made every chart low-contrast on a light
    // theme. This fails the moment someone pastes another hex into a config.
    expect(rendered).not.toContain("color: '#888'");
    expect(rendered).not.toContain("color: '#ccc'");
    expect(rendered).not.toContain('rgba(100,100,100,0.15)');

    // ...and the One Dark attribution palette, previously declared three times.
    expect(rendered).not.toContain("'System Prompt': '#e06c75'");
    expect(rendered).not.toContain("systemPrompt: '#e06c75'");

    expect(rendered).toContain('function chartTheme(');
    expect(rendered).toContain('function attrColor(');
    expect(rendered).toContain('function withAlpha(');
    expect(rendered).toContain('function applyChartTheme(');
    expect(rendered).toContain("case 'themeChanged'");
    expect(rendered).toContain('--sk-attr-system');
    expect(rendered).toContain('--sk-chart-grid');

    // withAlpha lives inside a template literal, so a single backslash would
    // collapse at emit time and turn the literal-paren match into a capture
    // group. Assert the escape survives into the generated document.
    expect(rendered).toContain(String.raw`/^rgba?\(([^)]+)\)$/i`);

    provider.dispose();
  });

  it('answers requestHistoricalData with the requested series and project', () => {
    const today = formatLocalDateKey(new Date());
    const days = [
      {
        date: today,
        tokens: { inputTokens: 10, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
        totalCost: 0.01,
        messageCount: 1,
        sessionCount: 1,
        modelUsage: [{ model: 'gpt-5.4', calls: 1, tokens: 11, cost: 0.01 }],
        toolUsage: [],
        updatedAt: '',
      },
    ];
    const historical = {
      getDailyData: (start: string, end: string) =>
        days.filter((d) => d.date >= start && d.date <= end),
      getHourlyData: () => [],
      getMonthlyData: () => [],
      getAllTimeStats: () => ({ firstDate: '2026-09-01', lastDate: '2026-09-04' }),
      getSessionRecords: () => [],
      getQualityTrend: () => ({ delta: null }),
      getLatestSessionRecord: () => null,
    };
    const provider = new DashboardViewProvider(
      { fsPath: '/tmp/sidekick-extension' } as never,
      makeSessionMonitor() as never,
      undefined,
      historical as never,
    );
    const postMessage = vi.fn();
    (provider as unknown as { _view: unknown })._view = { visible: true, webview: { postMessage } };

    (
      provider as unknown as { _handleDashboardWebviewMessage(message: unknown): void }
    )._handleDashboardWebviewMessage({
      type: 'requestHistoricalData',
      range: 'week',
      metric: 'tokens',
      series: 'model',
      project: null,
    });

    const update = postMessage.mock.calls.find((call) => call[0].type === 'updateHistoricalData');
    expect(update).toBeDefined();
    expect(update![0].data).toMatchObject({
      series: 'model',
      seriesKeys: ['gpt-5.4'],
      project: null,
    });
    expect(update![0].data.dataPoints[0].breakdown['gpt-5.4']).toMatchObject({ calls: 1 });
    expect(update![0].data.previousPeriod).toEqual([]);
    provider.dispose();
  });
});
