import { describe, expect, it, vi } from 'vitest';
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

import { DashboardViewProvider } from './DashboardViewProvider';

function disposable() {
  return { dispose: vi.fn() };
}

function makeSessionMonitor() {
  return {
    onTokenUsage: vi.fn(() => disposable()),
    onSessionStart: vi.fn(() => disposable()),
    onSessionEnd: vi.fn(() => disposable()),
    onToolAnalytics: vi.fn(() => disposable()),
    onTimelineEvent: vi.fn(() => disposable()),
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

    expect(html).toContain("case 'updateQuotaHistory'");
    expect(html).toContain("case 'updateContextHealth'");
    expect(html).toContain("case 'updateTruncations'");
    expect(html).toContain('function renderQuotaHistory');
    expect(html).toContain('function updateContextHealthDisplay');
    expect(html).toContain('function updateTruncationDisplay');
    expect(html).toContain('(t.totalCalls || 0)');
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
    provider.dispose();
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

    expect(html).toContain('id="quota-reset-credits"');
    expect(html).toContain('function renderResetCredits');
    expect(html).toContain('quota.resetCredits');

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

    expect(html).toContain('function setTimelineDescription');
    expect(html).toContain("descEl.textContent = text || ''");
    expect(html).not.toContain('descEl.innerHTML = truncated');
    expect(html).not.toContain('descEl.innerHTML = full');
    expect(html).toContain("escapeHtml(status.label || 'Peak Hours')");
    expect(html).toContain('escapeHtml(status.peakHoursDescription)');
    expect(html).toContain('escapeHtml(step.description)');
    expect(html).toContain('escapeHtml(step.errorMessage.substring(0, 100))');
    expect(html).toContain('escapeHtml(rp.title)');

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

    // The dark-theme literals that made every chart low-contrast on a light
    // theme. This fails the moment someone pastes another hex into a config.
    expect(html).not.toContain("color: '#888'");
    expect(html).not.toContain("color: '#ccc'");
    expect(html).not.toContain('rgba(100,100,100,0.15)');

    // ...and the One Dark attribution palette, previously declared three times.
    expect(html).not.toContain("'System Prompt': '#e06c75'");
    expect(html).not.toContain("systemPrompt: '#e06c75'");

    expect(html).toContain('function chartTheme(');
    expect(html).toContain('function attrColor(');
    expect(html).toContain('function withAlpha(');
    expect(html).toContain('function applyChartTheme(');
    expect(html).toContain("case 'themeChanged'");
    expect(html).toContain('--sk-attr-system');
    expect(html).toContain('--sk-chart-grid');

    // withAlpha lives inside a template literal, so a single backslash would
    // collapse at emit time and turn the literal-paren match into a capture
    // group. Assert the escape survives into the generated document.
    expect(html).toContain(String.raw`/^rgba?\(([^)]+)\)$/i`);

    provider.dispose();
  });
});
