import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));
vi.mock('../utils/nonce', () => ({ getNonce: () => 'nonce' }));
vi.mock('../utils/designTokens', () => ({
  getDesignTokenCSS: () => '',
  getSharedStyles: () => '',
}));

import { TaskBoardViewProvider } from './TaskBoardViewProvider';

const disposable = { dispose: vi.fn() };

function monitor() {
  const handlers: { toolCall?: () => void } = {};
  return {
    handlers,
    onToolCall: (handler: () => void) => {
      handlers.toolCall = handler;
      return disposable;
    },
    onSessionStart: () => disposable,
    onSessionEnd: () => disposable,
    getStats: () => ({ taskState: undefined }),
    isActive: () => false,
    getSessionPath: () => null,
  };
}

function fakeView(visible: boolean) {
  const hooks: { visibility?: () => void; dispose?: () => void } = {};
  const postMessage = vi.fn();
  const view = {
    visible,
    webview: {
      options: {},
      html: '',
      cspSource: 'test',
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: () => disposable,
      postMessage,
    },
    onDidChangeVisibility: (handler: () => void) => {
      hooks.visibility = handler;
      return disposable;
    },
    onDidDispose: (handler: () => void) => {
      hooks.dispose = handler;
      return disposable;
    },
  };
  return { view, hooks, postMessage };
}

describe('TaskBoardViewProvider lifecycle', () => {
  it('posts board updates only to a visible view', () => {
    const sessionMonitor = monitor();
    const provider = new TaskBoardViewProvider({} as never, sessionMonitor as never, undefined);
    const { view, hooks, postMessage } = fakeView(false);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    sessionMonitor.handlers.toolCall!();
    expect(postMessage).not.toHaveBeenCalled();

    view.visible = true;
    hooks.visibility!();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateBoard' }));

    const posted = postMessage.mock.calls.length;
    hooks.dispose!();
    sessionMonitor.handlers.toolCall!();
    expect(postMessage).toHaveBeenCalledTimes(posted);
    provider.dispose();
  });
});
