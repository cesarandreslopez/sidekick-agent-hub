import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  posted: [] as Array<Record<string, unknown>>,
  receive: undefined as ((message: Record<string, unknown>) => Promise<void>) | undefined,
  dispose: undefined as (() => void) | undefined,
}));

vi.mock('vscode', () => ({
  ViewColumn: { Two: 2 },
  Uri: { joinPath: () => ({}) },
  window: {
    createWebviewPanel: () => ({
      title: '',
      reveal: vi.fn(),
      dispose: vi.fn(),
      onDidDispose: (handler: () => void) => {
        h.dispose = handler;
      },
      webview: {
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: () => 'uri',
        postMessage: (message: Record<string, unknown>) => {
          h.posted.push(message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (handler: typeof h.receive) => {
          h.receive = handler;
        },
      },
    }),
  },
}));

import { ExplainViewProvider, explainPanelTitle } from './ExplainViewProvider';

describe('ExplainViewProvider', () => {
  it('sends the complexity chosen in the command with the code', async () => {
    const provider = new ExplainViewProvider({} as never, {} as never);
    provider.showExplanation('const a = 1;', 'phd', {
      fileName: '/repo/src/a.ts',
      languageId: 'typescript',
    });
    await h.receive!({ type: 'webviewReady' });
    const load = h.posted.find((m) => m.type === 'loadCode');
    expect(load?.complexity).toBe('phd');
  });

  it('names the explained file in the panel title', () => {
    expect(explainPanelTitle({ fileName: '/repo/src/a.ts', languageId: 'ts' })).toBe(
      'Explain: a.ts',
    );
    expect(explainPanelTitle({ fileName: 'C:\\repo\\b.py', languageId: 'py' })).toBe(
      'Explain: b.py',
    );
    expect(explainPanelTitle(undefined)).toBe('Code Explanation');
  });

  function openPanel(service: Record<string, unknown>) {
    h.posted.length = 0;
    const provider = new ExplainViewProvider({} as never, service as never);
    provider.showExplanation('const a = 1;', 'senior', { fileName: '/a.ts', languageId: 'ts' });
    return provider;
  }

  const request = (requestId: string, complexity = 'senior') => ({
    type: 'requestExplanation',
    requestId,
    code: 'const a = 1;',
    complexity,
    fileContext: { fileName: '/a.ts', languageId: 'ts' },
  });

  it('aborts a superseded request, which then reports nothing', async () => {
    const signals: AbortSignal[] = [];
    const service = {
      explain: vi.fn(
        (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            const signal = args[5] as AbortSignal;
            signals.push(signal);
            signal.addEventListener('abort', () => {
              const err = new Error('Request was cancelled');
              err.name = 'AbortError';
              reject(err);
            });
            if (signals.length === 2) resolve('second');
          }),
      ),
    };
    openPanel(service);
    const first = h.receive!(request('r1', 'eli5'));
    const second = h.receive!(request('r2', 'phd'));
    await Promise.all([first, second]);

    expect(signals[0].aborted).toBe(true);
    expect(h.posted.filter((m) => m.requestId === 'r1')).toEqual([]);
    expect(h.posted).toContainEqual({
      type: 'explanationResult',
      requestId: 'r2',
      explanation: 'second',
    });
  });

  it('reports an AbortError-named rejection as cancelled, not failed', async () => {
    const service = {
      explain: vi.fn(async () => {
        const err = new Error('Request was cancelled');
        err.name = 'AbortError';
        throw err;
      }),
    };
    openPanel(service);
    await h.receive!(request('r1'));
    expect(h.posted).toContainEqual({ type: 'explanationCancelled', requestId: 'r1' });
    expect(h.posted.some((m) => m.type === 'explanationError')).toBe(false);
  });

  it('closing the panel aborts the request in flight', async () => {
    let signal: AbortSignal | undefined;
    const service = {
      explain: vi.fn((...args: unknown[]) => {
        signal = args[5] as AbortSignal;
        return new Promise(() => undefined);
      }),
    };
    openPanel(service);
    void h.receive!(request('r1'));
    h.dispose!();
    expect(signal?.aborted).toBe(true);
  });
});
