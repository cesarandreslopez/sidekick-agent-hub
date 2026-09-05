import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTimelineEntries: vi.fn(() => []),
  clearCache: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' }, name: 'workspace' }] },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));
vi.mock('../utils/nonce', () => ({ getNonce: () => 'nonce' }));
vi.mock('../utils/designTokens', () => ({
  getDesignTokenCSS: () => '',
  getSharedStyles: () => '',
}));
vi.mock('../services/ProjectTimelineDataService', () => ({
  ProjectTimelineDataService: class {
    getTimelineEntries = mocks.getTimelineEntries;
    clearCache = mocks.clearCache;
  },
}));

import { ProjectTimelineViewProvider } from './ProjectTimelineViewProvider';

const disposable = { dispose: vi.fn() };

function monitor() {
  const handlers: { tokenUsage?: () => void } = {};
  return {
    handlers,
    onSessionStart: () => disposable,
    onSessionEnd: () => disposable,
    onTokenUsage: (handler: () => void) => {
      handlers.tokenUsage = handler;
      return disposable;
    },
    getProvider: () => ({}),
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

describe('ProjectTimelineViewProvider lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getTimelineEntries.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not build the timeline for a hidden view, and refreshes when it shows', () => {
    const sessionMonitor = monitor();
    const provider = new ProjectTimelineViewProvider({} as never, sessionMonitor as never);
    const { view, hooks, postMessage } = fakeView(false);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    sessionMonitor.handlers.tokenUsage!();
    vi.advanceTimersByTime(10_000);
    expect(mocks.getTimelineEntries).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();

    view.visible = true;
    hooks.visibility!();
    expect(mocks.getTimelineEntries).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateTimeline' }));
    provider.dispose();
  });

  it('schedules nothing once the view has been disposed', () => {
    const sessionMonitor = monitor();
    const provider = new ProjectTimelineViewProvider({} as never, sessionMonitor as never);
    const { view, hooks, postMessage } = fakeView(true);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    sessionMonitor.handlers.tokenUsage!();
    hooks.dispose!();
    vi.advanceTimersByTime(10_000);
    expect(mocks.getTimelineEntries).not.toHaveBeenCalled();

    sessionMonitor.handlers.tokenUsage!();
    vi.advanceTimersByTime(10_000);
    expect(mocks.getTimelineEntries).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    provider.dispose();
  });
});
