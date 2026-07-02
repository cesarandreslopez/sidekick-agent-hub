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
});
