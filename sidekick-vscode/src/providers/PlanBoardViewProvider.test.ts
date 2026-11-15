import { describe, expect, it, vi } from 'vitest';
import type { PersistedPlan } from '../types/plan';

const mocks = vi.hoisted(() => ({
  readPlans: vi.fn(),
}));

vi.mock('sidekick-shared', () => ({ readClaudeCodePlanFiles: mocks.readPlans }));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));
vi.mock('../utils/nonce', () => ({ getNonce: () => 'nonce' }));
vi.mock('../utils/designTokens', () => ({
  getDesignTokenCSS: () => '',
  getSharedStyles: () => '',
}));
vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
  env: { clipboard: { writeText: vi.fn() } },
}));

import { PlanBoardViewProvider, mergePlanHistory } from './PlanBoardViewProvider';

const disposable = { dispose: vi.fn() };

function monitor() {
  return {
    onToolCall: () => disposable,
    onSessionStart: () => disposable,
    onSessionEnd: () => disposable,
    getStats: () => ({ planState: undefined }),
    getStatsView: () => ({ planState: undefined }),
    isActive: () => false,
    getSessionPath: () => null,
    getProvider: () => ({ getSessionId: () => 'session' }),
  };
}

describe('PlanBoardViewProvider', () => {
  it('re-reads Claude plan files when the webview requests refresh', async () => {
    const persisted = {
      id: 'plan-2',
      projectSlug: 'project',
      sessionId: 'session-2',
      title: 'New plan',
      source: 'claude-code',
      createdAt: '2026-07-21T00:00:00Z',
      status: 'completed',
      steps: [],
      completionRate: 1,
    } as PersistedPlan;
    mocks.readPlans.mockResolvedValueOnce([]).mockResolvedValueOnce([persisted]);
    const provider = new PlanBoardViewProvider({} as never, monitor() as never, undefined);
    await vi.waitFor(() => expect(mocks.readPlans).toHaveBeenCalledTimes(1));

    let receive: ((message: { type: string }) => void) | undefined;
    const postMessage = vi.fn();
    provider.resolveWebviewView(
      {
        visible: true,
        webview: {
          options: {},
          html: '',
          cspSource: 'test',
          asWebviewUri: (uri: unknown) => uri,
          onDidReceiveMessage: (handler: (message: { type: string }) => void) => {
            receive = handler;
            return disposable;
          },
          postMessage,
        },
        onDidChangeVisibility: () => disposable,
        onDidDispose: () => disposable,
      } as never,
      {} as never,
      {} as never,
    );

    receive!({ type: 'refresh' });
    await vi.waitFor(() => expect(mocks.readPlans).toHaveBeenCalledTimes(2));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'updatePlanBoard',
        state: expect.objectContaining({
          historicalPlans: [expect.objectContaining({ id: 'plan-2', title: 'New plan' })],
        }),
      }),
    );
    provider.dispose();
  });

  it('posts plan state only to a visible view and stops after dispose', async () => {
    mocks.readPlans.mockResolvedValue([]);
    let toolCall: (() => void) | undefined;
    const sessionMonitor = {
      ...monitor(),
      onToolCall: (handler: () => void) => {
        toolCall = handler;
        return disposable;
      },
    };
    const provider = new PlanBoardViewProvider({} as never, sessionMonitor as never, undefined);
    await vi.waitFor(() => expect(mocks.readPlans).toHaveBeenCalled());

    let onDispose: (() => void) | undefined;
    let onVisibility: (() => void) | undefined;
    const postMessage = vi.fn();
    const view = {
      visible: false,
      webview: {
        options: {},
        html: '',
        cspSource: 'test',
        asWebviewUri: (uri: unknown) => uri,
        onDidReceiveMessage: () => disposable,
        postMessage,
      },
      onDidChangeVisibility: (handler: () => void) => {
        onVisibility = handler;
        return disposable;
      },
      onDidDispose: (handler: () => void) => {
        onDispose = handler;
        return disposable;
      },
    };
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    toolCall!();
    expect(postMessage).not.toHaveBeenCalled();

    view.visible = true;
    onVisibility!();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updatePlanBoard' }));

    const posted = postMessage.mock.calls.length;
    onDispose!();
    toolCall!();
    expect(postMessage).toHaveBeenCalledTimes(posted);
    provider.dispose();
  });

  it('coalesces a burst of tool calls into one post and skips unchanged state', async () => {
    mocks.readPlans.mockResolvedValue([]);
    let toolCall: (() => void) | undefined;
    let planTitle = 'Plan A';
    const sessionMonitor = {
      ...monitor(),
      onToolCall: (handler: () => void) => {
        toolCall = handler;
        return disposable;
      },
      getStatsView: () => ({
        planState: {
          title: planTitle,
          steps: [{ id: 's', description: 'd', status: 'pending' }],
          active: true,
        },
      }),
    };
    const provider = new PlanBoardViewProvider({} as never, sessionMonitor as never, undefined);
    await vi.waitFor(() => expect(mocks.readPlans).toHaveBeenCalled());

    const postMessage = vi.fn();
    provider.resolveWebviewView(
      {
        visible: true,
        webview: {
          options: {},
          html: '',
          cspSource: 'test',
          asWebviewUri: (uri: unknown) => uri,
          onDidReceiveMessage: () => disposable,
          postMessage,
        },
        onDidChangeVisibility: () => disposable,
        onDidDispose: () => disposable,
      } as never,
      {} as never,
      {} as never,
    );

    vi.useFakeTimers();
    try {
      postMessage.mockClear();
      for (let i = 0; i < 10; i++) toolCall!();
      vi.advanceTimersByTime(300);
      expect(postMessage).toHaveBeenCalledTimes(1);

      // Nothing changed: no second post.
      for (let i = 0; i < 10; i++) toolCall!();
      vi.advanceTimersByTime(300);
      expect(postMessage).toHaveBeenCalledTimes(1);

      planTitle = 'Plan B';
      for (let i = 0; i < 10; i++) toolCall!();
      vi.advanceTimersByTime(300);
      expect(postMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      provider.dispose();
    }
  });
});

describe('mergePlanHistory', () => {
  const plan = (over: Partial<PersistedPlan>): PersistedPlan =>
    ({
      id: 'p',
      projectSlug: 'project',
      sessionId: 's',
      title: 'T',
      source: 'claude-code',
      createdAt: '2026-11-01T00:00:00Z',
      status: 'completed',
      steps: [],
      completionRate: 1,
      ...over,
    }) as PersistedPlan;

  it('drops a raw plan file whose session already has a persisted plan', () => {
    const persisted = [plan({ id: 'aaaa1111-1', sessionId: 'aaaa1111-full-uuid' })];
    const raw = [
      {
        ...plan({ id: 'claude-plan-otter', sessionId: 'otter' }),
        sessionIds: ['aaaa1111-full-uuid'],
      },
    ];
    const merged = mergePlanHistory(persisted, raw, null);
    expect(merged.map((m) => m.plan.id)).toEqual(['aaaa1111-1']);
  });

  it('hides the active session from history and marks raw-only plans', () => {
    const raw = [
      { ...plan({ id: 'claude-plan-a', sessionId: 'a' }), sessionIds: ['active-session'] },
      { ...plan({ id: 'claude-plan-b', sessionId: 'b' }), sessionIds: ['old-session'] },
    ];
    const merged = mergePlanHistory([], raw, 'active-session');
    expect(merged).toEqual([{ plan: raw[1], rawOnly: true }]);
  });

  it('falls back to matching markdown when session ids are unknown', () => {
    const persisted = [plan({ id: 'x', sessionId: 'x-session', rawMarkdown: '# Plan\n' })];
    const raw = [
      { ...plan({ id: 'claude-plan-y', sessionId: 'y', rawMarkdown: '# Plan' }), sessionIds: [] },
    ];
    expect(mergePlanHistory(persisted, raw, null).map((m) => m.plan.id)).toEqual(['x']);
  });
});
