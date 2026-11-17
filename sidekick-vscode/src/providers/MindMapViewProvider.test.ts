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
  workspace: {
    openTextDocument: vi.fn(() => Promise.resolve({})),
    workspaceFolders: [{ uri: { fsPath: '/repo' } }],
  },
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

import { MindMapViewProvider, resolveNodeFilePath } from './MindMapViewProvider';

function makeMonitor() {
  return {
    onTokenUsage: vi.fn(() => ({ dispose: vi.fn() })),
    onToolCall: vi.fn(() => ({ dispose: vi.fn() })),
    onSessionStart: vi.fn(() => ({ dispose: vi.fn() })),
    onSessionEnd: vi.fn(() => ({ dispose: vi.fn() })),
    isActive: vi.fn(() => false),
    getSessionPath: vi.fn((): string | null => null),
    getProvider: vi.fn(() => ({})),
    getStatsView: vi.fn(() => ({})),
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
    expect(monitor.getStatsView).not.toHaveBeenCalled();

    target._view = { visible: true, webview: { postMessage: vi.fn() } };
    target._updateGraph();
    target._updateGraph();
    vi.advanceTimersByTime(349);
    expect(monitor.getStatsView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(monitor.getStatsView).toHaveBeenCalledTimes(1);
    expect(buildGraph).toHaveBeenCalledTimes(1);
    // The header phrase rotates on its own timer, not on every graph update.
    const types = target._view.webview.postMessage.mock.calls.map(
      ([m]) => (m as { type: string }).type,
    );
    expect(types).not.toContain('updatePhrase');
    provider.dispose();
  });
});

describe('MindMapViewProvider liveness', () => {
  afterEach(() => vi.useRealTimers());

  it('re-posts Viewing once the session goes quiet, and stops ticking when disposed', () => {
    vi.useFakeTimers();
    let mtime = Date.now();
    const monitor = {
      ...makeMonitor(),
      isActive: vi.fn(() => true),
      getSessionPath: vi.fn((): string | null => '/sessions/a.jsonl'),
      getProvider: vi.fn(() => ({ getSessionMetadata: () => ({ mtime: new Date(mtime) }) })),
    };
    const provider = new MindMapViewProvider({ fsPath: '/extension' } as never, monitor as never);
    const hooks: { dispose?: () => void } = {};
    const postMessage = vi.fn();
    const view = {
      visible: true,
      webview: {
        options: {},
        html: '',
        cspSource: 'test',
        asWebviewUri: (uri: unknown) => uri,
        onDidReceiveMessage: () => ({ dispose: vi.fn() }),
        postMessage,
      },
      onDidChangeVisibility: () => ({ dispose: vi.fn() }),
      onDidDispose: (handler: () => void) => {
        hooks.dispose = handler;
        return { dispose: vi.fn() };
      },
    };
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    const graphPosts = () =>
      postMessage.mock.calls
        .map(([m]) => m as { type: string; state?: { sessionStatus?: string } })
        .filter((m) => m.type === 'updateGraph');

    // Still live: the map already shows Live, so the tick posts nothing.
    vi.advanceTimersByTime(60_000);
    expect(graphPosts()).toHaveLength(0);

    mtime = Date.now() - 3 * 60_000;
    vi.advanceTimersByTime(30_000);
    expect(graphPosts().pop()?.state?.sessionStatus).toBe('Viewing');

    hooks.dispose!();
    const after = postMessage.mock.calls.length;
    mtime = Date.now();
    vi.advanceTimersByTime(120_000);
    expect(postMessage).toHaveBeenCalledTimes(after);
    provider.dispose();
  });
});

describe('MindMapViewProvider plan-step labels', () => {
  it('formats plan-step tokens and duration with the shared formatters', () => {
    buildGraph.mockReturnValueOnce({
      nodes: [
        {
          id: 'step',
          label: 's',
          type: 'plan-step',
          planStepTokens: 1_500_000,
          planStepDurationMs: 125_000,
        },
      ],
      links: [],
    } as never);
    const monitor = { ...makeMonitor(), isActive: vi.fn(() => true) };
    const provider = new MindMapViewProvider({ fsPath: '/extension' } as never, monitor as never);
    const state = (
      provider as unknown as { _state: { graph: { nodes: Array<Record<string, unknown>> } } }
    )._state;
    expect(state.graph.nodes[0].planStepTokensLabel).toBe('1.5M');
    expect(state.graph.nodes[0].planStepDurationLabel).toBe('2m 5s');
    provider.dispose();
  });
});

describe('resolveNodeFilePath', () => {
  it('keeps absolute paths and resolves relative ones against the workspace', () => {
    expect(resolveNodeFilePath('/repo/src/a.ts', '/repo')).toBe('/repo/src/a.ts');
    expect(resolveNodeFilePath('src/a.ts', '/repo')).toBe('/repo/src/a.ts');
    expect(resolveNodeFilePath('src/a.ts')).toBe('src/a.ts');
  });
});

describe('MindMapViewProvider node clicks', () => {
  it('opens files for subagent nodes, whose ids carry a prefix', async () => {
    const vscodeMock = await import('vscode');
    const provider = new MindMapViewProvider({ fsPath: '/ext' } as never, makeMonitor() as never);
    const internals = provider as unknown as {
      _state: { graph: { nodes: Array<Record<string, unknown>>; links: unknown[] } };
      _handleNodeClick(nodeId: string): void;
    };
    internals._state.graph = {
      nodes: [
        { id: 'subagent-a1-file-src/a.ts', type: 'file', label: 'a.ts', fullPath: 'src/a.ts' },
      ],
      links: [],
    };
    internals._handleNodeClick('subagent-a1-file-src/a.ts');
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      fsPath: '/repo/src/a.ts',
    });
    provider.dispose();
  });
});
