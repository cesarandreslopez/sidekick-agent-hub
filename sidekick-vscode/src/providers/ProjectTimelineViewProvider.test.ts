import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadTimelineEntries: vi.fn(async (..._args: unknown[]): Promise<unknown[] | null> => []),
  getSessionDetail: vi.fn(),
  constructedWith: [] as unknown[],
  liveness: 'live' as 'live' | 'viewing' | 'none',
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
vi.mock('../utils/sessionLiveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sessionLiveness')>();
  return { ...actual, getSessionLiveness: () => mocks.liveness };
});
vi.mock('../services/ProjectTimelineDataService', () => ({
  ProjectTimelineDataService: class {
    loadTimelineEntries = mocks.loadTimelineEntries;
    getSessionDetail = mocks.getSessionDetail;
    constructor(provider: unknown) {
      mocks.constructedWith.push(provider);
    }
  },
}));

import { ProjectTimelineViewProvider } from './ProjectTimelineViewProvider';

const disposable = { dispose: vi.fn() };

function monitor() {
  const handlers: { tokenUsage?: () => void } = {};
  let provider: unknown = { name: 'claude' };
  return {
    handlers,
    setProvider: (next: unknown) => {
      provider = next;
    },
    onSessionStart: () => disposable,
    onSessionEnd: () => disposable,
    onTokenUsage: (handler: () => void) => {
      handlers.tokenUsage = handler;
      return disposable;
    },
    getProvider: () => provider,
    getSessionPath: () => null,
    isActive: () => true,
  };
}

function fakeView(visible: boolean) {
  const hooks: {
    visibility?: () => void;
    dispose?: () => void;
    message?: (msg: unknown) => void;
  } = {};
  const postMessage = vi.fn();
  const view = {
    visible,
    webview: {
      options: {},
      html: '',
      cspSource: 'test',
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (handler: (msg: unknown) => void) => {
        hooks.message = handler;
        return disposable;
      },
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

const posted = (postMessage: ReturnType<typeof vi.fn>, type: string) =>
  postMessage.mock.calls.filter(([m]) => (m as { type: string }).type === type);

describe('ProjectTimelineViewProvider lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.loadTimelineEntries.mockReset();
    mocks.loadTimelineEntries.mockImplementation(async () => []);
    mocks.constructedWith.length = 0;
    mocks.liveness = 'live';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not build the timeline for a hidden view, and refreshes when it shows', async () => {
    const sessionMonitor = monitor();
    const provider = new ProjectTimelineViewProvider({} as never, sessionMonitor as never);
    const { view, hooks, postMessage } = fakeView(false);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    sessionMonitor.handlers.tokenUsage!();
    vi.advanceTimersByTime(10_000);
    expect(mocks.loadTimelineEntries).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();

    view.visible = true;
    hooks.visibility!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.loadTimelineEntries).toHaveBeenCalledTimes(1);
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
    vi.advanceTimersByTime(60_000);
    expect(mocks.loadTimelineEntries).not.toHaveBeenCalled();

    sessionMonitor.handlers.tokenUsage!();
    vi.advanceTimersByTime(10_000);
    expect(mocks.loadTimelineEntries).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('drops a slower, superseded scan instead of posting it over the newer one', async () => {
    const sessionMonitor = monitor();
    const provider = new ProjectTimelineViewProvider({} as never, sessionMonitor as never);
    const { view, hooks, postMessage } = fakeView(true);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    let releaseFirst!: (v: unknown[]) => void;
    mocks.loadTimelineEntries
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
      .mockImplementationOnce(async () => [{ sessionId: 'b' }]);

    hooks.message!({ type: 'setRange', range: 'all' });
    hooks.message!({ type: 'setRange', range: '24h' });
    await vi.advanceTimersByTimeAsync(0);
    releaseFirst([{ sessionId: 'a' }]);
    await vi.advanceTimersByTimeAsync(0);

    const updates = posted(postMessage, 'updateTimeline');
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toMatchObject({ state: { range: '24h' } });
    provider.dispose();
  });

  it('shows the loading state while sessions are being read', async () => {
    const sessionMonitor = monitor();
    const provider = new ProjectTimelineViewProvider({} as never, sessionMonitor as never);
    const { view, hooks, postMessage } = fakeView(true);
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    mocks.loadTimelineEntries.mockImplementationOnce(async (...args: unknown[]) => {
      (args[3] as { onParseStart: () => void }).onParseStart();
      return [];
    });

    hooks.message!({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(posted(postMessage, 'loading')[0][0]).toEqual({ type: 'loading', loading: true });
    provider.dispose();
  });

  it('refresh re-reads only changed sessions (no cache wipe)', async () => {
    const sessionMonitor = monitor();
    const provider = new ProjectTimelineViewProvider({} as never, sessionMonitor as never);
    const { view, hooks } = fakeView(true);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    hooks.message!({ type: 'refresh' });
    await vi.advanceTimersByTimeAsync(0);
    // One data service, so its mtime cache survives the click.
    expect(mocks.constructedWith).toHaveLength(1);
    expect(mocks.loadTimelineEntries).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('reads the new provider after a live provider switch', async () => {
    const sessionMonitor = monitor();
    const provider = new ProjectTimelineViewProvider({} as never, sessionMonitor as never);
    const { view, hooks } = fakeView(true);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    const codex = { name: 'codex' };
    sessionMonitor.setProvider(codex);
    hooks.message!({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.constructedWith).toHaveLength(2);
    expect(mocks.constructedWith[1]).toBe(codex);
    provider.dispose();
  });

  it('re-sends the timeline when the attached session decays from Live to Viewing', async () => {
    const sessionMonitor = monitor();
    const provider = new ProjectTimelineViewProvider({} as never, sessionMonitor as never);
    const { view, hooks, postMessage } = fakeView(true);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    hooks.message!({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(posted(postMessage, 'updateTimeline')).toHaveLength(1);

    // Still live: the tick posts nothing.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posted(postMessage, 'updateTimeline')).toHaveLength(1);

    // The session went quiet; no monitor event fires for that.
    mocks.liveness = 'viewing';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posted(postMessage, 'updateTimeline')).toHaveLength(2);
    provider.dispose();
  });
});
