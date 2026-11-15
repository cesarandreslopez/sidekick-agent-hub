import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function monitor(
  taskState?: { tasks: Map<string, unknown>; activeTaskId: string | null },
  displayStates = new Map<string, { state: string }>(),
) {
  const handlers: { toolCall?: () => void; subagents?: () => void } = {};
  return {
    handlers,
    onToolCall: (handler: () => void) => {
      handlers.toolCall = handler;
      return disposable;
    },
    onSubagentsChanged: (handler: () => void) => {
      handlers.subagents = handler;
      return disposable;
    },
    onSessionStart: () => disposable,
    onSessionEnd: () => disposable,
    getStats: () => ({ taskState }),
    getStatsView: () => ({ taskState }),
    getSubagentDisplayStates: () => displayStates,
    isActive: () => taskState !== undefined,
    getSessionPath: (): string | null => null,
    getProvider: () => ({
      getSessionId: (p: string) => p.replace(/^.*\//, '').replace('.jsonl', ''),
    }),
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
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts board updates only to a visible view, one per burst of tool calls', () => {
    const sessionMonitor = monitor();
    const provider = new TaskBoardViewProvider({} as never, sessionMonitor as never, undefined);
    const { view, hooks, postMessage } = fakeView(false);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    sessionMonitor.handlers.toolCall!();
    vi.advanceTimersByTime(250);
    expect(postMessage).not.toHaveBeenCalled();

    view.visible = true;
    hooks.visibility!();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateBoard' }));

    // Ten tool calls inside the throttle window post one board update.
    const posted = postMessage.mock.calls.length;
    for (let i = 0; i < 10; i += 1) sessionMonitor.handlers.toolCall!();
    vi.advanceTimersByTime(250);
    expect(postMessage).toHaveBeenCalledTimes(posted + 1);

    hooks.dispose!();
    sessionMonitor.handlers.toolCall!();
    vi.advanceTimersByTime(250);
    expect(postMessage).toHaveBeenCalledTimes(posted + 1);
    provider.dispose();
  });

  it('labels agent cards that stopped in all but name, and refreshes on subagent changes', () => {
    const now = new Date('2026-10-12T20:00:00.000Z');
    const agentTask = (toolUseId: string, status: string) => ({
      taskId: `agent-${toolUseId}`,
      subject: `Agent ${toolUseId}`,
      status,
      createdAt: now,
      updatedAt: now,
      activeForm: 'Running general-purpose agent',
      blockedBy: [],
      blocks: [],
      associatedToolCalls: [],
      isSubagent: true,
      subagentType: 'general-purpose',
      toolUseId,
    });
    const tasks = new Map<string, unknown>([
      ['agent-t1', agentTask('t1', 'in_progress')],
      ['agent-t2', agentTask('t2', 'completed')],
      ['agent-t3', agentTask('t3', 'in_progress')],
    ]);
    const states = new Map([
      ['t1', { state: 'finished-unreported' }],
      ['t2', { state: 'stopped' }],
      ['t3', { state: 'running' }],
    ]);
    const sessionMonitor = monitor({ tasks, activeTaskId: null }, states);
    const provider = new TaskBoardViewProvider({} as never, sessionMonitor as never, undefined);
    const cards = () =>
      (
        provider as unknown as {
          _state: { columns: Array<{ tasks: Array<{ taskId: string; agentState?: string }> }> };
        }
      )._state.columns.flatMap((column) => column.tasks);
    const byId = (id: string) => cards().find((card) => card.taskId === id);
    expect(byId('agent-t1')?.agentState).toBe('finished (no report)');
    expect(byId('agent-t2')?.agentState).toBe('stopped');
    expect(byId('agent-t3')?.agentState).toBeUndefined();

    states.set('t3', { state: 'ended' });
    sessionMonitor.handlers.subagents!();
    vi.advanceTimersByTime(250);
    expect(byId('agent-t3')?.agentState).toBe('ended');
    provider.dispose();
  });

  it('keeps carried-over tasks whose ids repeat in the new session, and shows failed agents', () => {
    const now = new Date('2026-11-15T10:00:00.000Z');
    const task = (taskId: string, status: string, extra: Record<string, unknown> = {}) => ({
      taskId,
      subject: `Task ${taskId}`,
      status,
      createdAt: now,
      updatedAt: now,
      blockedBy: [],
      blocks: [],
      associatedToolCalls: [],
      ...extra,
    });
    const tasks = new Map<string, unknown>([
      ['1', task('1', 'pending')],
      ['2', task('2', 'deleted')],
      ['agent-x', task('agent-x', 'deleted', { isSubagent: true, toolUseId: 'x' })],
    ]);
    const sessionMonitor = monitor({ tasks, activeTaskId: null });
    sessionMonitor.getSessionPath = () => '/sessions/current.jsonl';
    const provider = new TaskBoardViewProvider({} as never, sessionMonitor as never, undefined);
    const internals = provider as unknown as {
      _persistedTasks: unknown[];
      _syncFromSessionMonitor(): void;
      _state: {
        totalTasks: number;
        columns: Array<{ status: string; tasks: Array<{ taskId: string; agentState?: string }> }>;
      };
    };
    const persisted = (taskId: string, sessionOrigin: string) => ({
      taskId,
      subject: `Old ${taskId}`,
      status: 'pending',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      toolCallCount: 0,
      blockedBy: [],
      blocks: [],
      sessionOrigin,
      carriedOver: true,
      sessionAge: 1,
    });
    internals._persistedTasks = [
      persisted('1', 'previous-session'),
      // This session's own saved copy: the live map wins.
      persisted('1', 'current'),
    ];
    internals._syncFromSessionMonitor();

    const cards = internals._state.columns.flatMap((column) => column.tasks);
    expect(cards.map((card) => card.taskId).sort()).toEqual(['1', 'agent-x', 'previous:1']);
    const completed = internals._state.columns.find((column) => column.status === 'completed');
    expect(completed?.tasks.find((card) => card.taskId === 'agent-x')?.agentState).toBe('failed');
    // The summary counts what is shown (the deleted todo is not).
    expect(internals._state.totalTasks).toBe(3);
    provider.dispose();
  });
});
