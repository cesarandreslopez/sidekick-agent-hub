import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class<T> {
    event = (_listener: (value: T) => void) => ({ dispose: vi.fn() });
    dispose(): void {}
  },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
    }),
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ value }),
  },
  workspace: { openTextDocument: vi.fn() },
  window: { showTextDocument: vi.fn() },
  env: { openExternal: vi.fn() },
}));

const { buildGraph } = vi.hoisted(() => ({
  buildGraph: vi.fn(() => ({ nodes: [], links: [] })),
}));
vi.mock('../services/MindMapDataService', () => ({
  MindMapDataService: { buildGraph },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));

import { MindMapViewProvider } from './MindMapViewProvider';

function makeMonitor() {
  return {
    onTokenUsage: vi.fn(() => ({ dispose: vi.fn() })),
    onToolCall: vi.fn(() => ({ dispose: vi.fn() })),
    onSessionStart: vi.fn(() => ({ dispose: vi.fn() })),
    onSessionEnd: vi.fn(() => ({ dispose: vi.fn() })),
    isActive: vi.fn(() => false),
    getStats: vi.fn(() => ({})),
    getSubagentStats: vi.fn(() => []),
  };
}

describe('MindMapViewProvider graph scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
    buildGraph.mockClear();
  });

  it('skips hidden work and coalesces visible activity bursts', () => {
    vi.useFakeTimers();
    const monitor = makeMonitor();
    const provider = new MindMapViewProvider({ fsPath: '/extension' } as never, monitor as never);
    const target = provider as unknown as {
      _view?: { visible: boolean; webview: { postMessage: ReturnType<typeof vi.fn> } };
      _updateGraph(): void;
    };

    target._updateGraph();
    expect(monitor.getStats).not.toHaveBeenCalled();

    target._view = { visible: true, webview: { postMessage: vi.fn() } };
    target._updateGraph();
    target._updateGraph();
    vi.advanceTimersByTime(349);
    expect(monitor.getStats).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(monitor.getStats).toHaveBeenCalledTimes(1);
    expect(buildGraph).toHaveBeenCalledTimes(1);
    provider.dispose();
  });
});
