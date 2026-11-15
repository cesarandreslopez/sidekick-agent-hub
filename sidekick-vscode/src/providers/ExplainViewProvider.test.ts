import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  posted: [] as Array<Record<string, unknown>>,
  receive: undefined as ((message: Record<string, unknown>) => Promise<void>) | undefined,
}));

vi.mock('vscode', () => ({
  ViewColumn: { Two: 2 },
  Uri: { joinPath: () => ({}) },
  window: {
    createWebviewPanel: () => ({
      title: '',
      reveal: vi.fn(),
      dispose: vi.fn(),
      onDidDispose: vi.fn(),
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
});
