import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockShowErrorMessage, mockExistsSync } = vi.hoisted(() => ({
  mockShowErrorMessage: vi.fn().mockResolvedValue(undefined),
  mockExistsSync: vi.fn<(path: unknown) => boolean>().mockReturnValue(false),
}));

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
  window: {
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (input: unknown) => mockExistsSync(input),
  };
});

vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  saveSnapshot: vi.fn(),
  loadSnapshot: vi.fn(() => null),
  deleteSnapshot: vi.fn(),
}));

import { SessionMonitor } from './SessionMonitor';
import { loadSnapshot, saveSnapshot } from 'sidekick-shared';

afterEach(() => vi.useRealTimers());

function createProvider(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    getSessionDirectory: vi.fn(() => '/tmp/db-sessions/proj_1'),
    discoverSessionDirectory: vi.fn(() => null),
    findActiveSession: vi.fn(() => null),
    findAllSessions: vi.fn(() => []),
    findSessionsInDirectory: vi.fn(() => []),
    getAllProjectFolders: vi.fn(() => []),
    isSessionFile: vi.fn(() => true),
    getSessionId: vi.fn(
      (sessionPath: string) =>
        sessionPath
          .split('/')
          .pop()
          ?.replace(/\.json$/, '') || 'session',
    ),
    encodeWorkspacePath: vi.fn((workspacePath: string) => workspacePath),
    extractSessionLabel: vi.fn(() => null),
    createReader: vi.fn(() => ({
      readNew: () => [],
      readAll: () => [],
      reset: () => {},
      exists: () => true,
      flush: () => {},
      getPosition: () => 0,
      seekTo: () => {},
      wasTruncated: () => false,
    })),
    scanSubagents: vi.fn(() => []),
    searchInSession: vi.fn(() => []),
    getProjectsBaseDir: vi.fn(() => '/tmp'),
    readSessionStats: vi.fn(),
    canMonitorDirectory: vi.fn(() => false),
    getRuntimeStatus: vi.fn(() => ({ available: true, kind: 'available' })),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe('SessionMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);
  });

  it('replays unchanged OpenCode history on reopen without timestamp snapshots', async () => {
    const seekTo = vi.fn();
    const readNew = vi.fn(() => [
      {
        type: 'assistant',
        timestamp: '2026-09-06T12:00:00Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    ]);
    const provider = createProvider({
      createReader: vi.fn(() => ({
        readNew,
        readAll: readNew,
        reset: vi.fn(),
        exists: () => true,
        flush: vi.fn(),
        getPosition: () => 100,
        seekTo,
        wasTruncated: () => false,
      })),
    });
    const monitor = new SessionMonitor(provider as never);
    const target = monitor as unknown as { attachToSession(path: string): Promise<void> };
    await target.attachToSession('/tmp/session.json');
    expect(monitor.getStats().totalInputTokens).toBe(100);
    monitor.stop();
    await target.attachToSession('/tmp/session.json');
    expect(monitor.getStats().totalInputTokens).toBe(100);
    expect(readNew).toHaveBeenCalledTimes(2);
    expect(seekTo).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it('deduplicates ID-less events by content instead of timestamp alone', () => {
    const monitor = new SessionMonitor(createProvider() as never);
    const hash = (
      monitor as unknown as { generateEventHash(event: unknown): string }
    ).generateEventHash.bind(monitor);

    const first = hash({
      type: 'user',
      timestamp: '2026-07-21T12:00:00.000Z',
      message: { role: 'user', content: 'first' },
    });
    const second = hash({
      type: 'user',
      timestamp: '2026-07-21T12:00:00.000Z',
      message: { role: 'user', content: 'second' },
    });

    expect(first).not.toBe(second);
    monitor.dispose();
  });

  it('retains a bounded tool-call window with bounded payload strings', () => {
    const monitor = new SessionMonitor(createProvider() as never);
    const target = monitor as unknown as {
      extractToolUsesFromContent(content: unknown, timestamp: string): void;
    };

    for (let index = 0; index < 501; index++) {
      target.extractToolUsesFromContent(
        [
          {
            type: 'tool_use',
            id: `tool-${index}`,
            name: 'Read',
            input: { file_path: `/tmp/${index}`, payload: 'x'.repeat(20_000) },
          },
        ],
        '2026-07-21T12:00:00.000Z',
      );
    }

    const calls = monitor.getStats().toolCalls;
    expect(calls).toHaveLength(500);
    expect(calls[0].toolUseId).toBe('tool-1');
    expect(String(calls.at(-1)?.input.payload).length).toBeLessThan(8_100);
    monitor.dispose();
  });

  it('does not auto-switch an inactive OpenCode session while pinned', () => {
    const provider = createProvider({ findActiveSession: vi.fn(() => '/tmp/new-session.json') });
    const monitor = new SessionMonitor(provider as never);
    const target = monitor as unknown as {
      sessionPath: string;
      workspacePath: string;
      _isPinned: boolean;
      _checkForNewerSession(): void;
    };
    target.sessionPath = '/tmp/current-session.json';
    target.workspacePath = '/workspace';
    target._isPinned = true;

    target._checkForNewerSession();

    expect(provider.findActiveSession).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it('accepts valid synthetic directories and enters discovery mode when empty', async () => {
    const provider = createProvider({
      canMonitorDirectory: vi.fn(() => true),
      findSessionsInDirectory: vi.fn(() => []),
    });
    const workspaceState = {
      get: vi.fn(() => null),
      update: vi.fn().mockResolvedValue(undefined),
    };

    const monitor = new SessionMonitor(provider as never, workspaceState as never);
    const discoveryStates: boolean[] = [];
    monitor.onDiscoveryModeChange((state) => discoveryStates.push(state));

    const active = await monitor.startWithCustomPath('/tmp/db-sessions/proj_1');

    expect(active).toBe(false);
    expect(provider.canMonitorDirectory).toHaveBeenCalledWith('/tmp/db-sessions/proj_1');
    expect(discoveryStates).toContain(true);

    monitor.dispose();
  });

  it('surfaces provider runtime errors instead of reporting a missing directory', async () => {
    const provider = createProvider({
      getRuntimeStatus: vi.fn(() => ({
        available: false,
        kind: 'sqlite_blocked',
        message: 'sqlite3 exists but could not be executed.',
      })),
      canMonitorDirectory: vi.fn(() => false),
      findSessionsInDirectory: vi.fn(() => []),
    });

    const monitor = new SessionMonitor(
      provider as never,
      { get: vi.fn(() => null), update: vi.fn() } as never,
    );

    const active = await monitor.startWithCustomPath('/tmp/db-sessions/proj_1');

    expect(active).toBe(false);
    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      'OpenCode session database is unavailable. sqlite3 exists but could not be executed. Recommendation: ensure `sqlite3` is executable in the same environment as VS Code, then reload the window.',
    );

    monitor.dispose();
  });

  it('emits quota updates from async session providers', async () => {
    const quota = {
      fiveHour: { utilization: 1, resetsAt: '2026-06-25T15:47:00Z' },
      sevenDay: { utilization: 20, resetsAt: '2026-06-29T15:47:00Z' },
      available: true,
      providerId: 'zai',
      source: 'api',
    };
    const getQuotaFromSession = vi.fn().mockResolvedValue(quota);
    const provider = createProvider({ getQuotaFromSession });
    const monitor = new SessionMonitor(
      provider as never,
      { get: vi.fn(() => null), update: vi.fn() } as never,
    );
    const updates: (typeof quota)[] = [];
    monitor.onQuotaUpdate((state) => updates.push(state as typeof quota));

    await (monitor as unknown as { emitQuotaFromSession(): Promise<void> }).emitQuotaFromSession();

    expect(getQuotaFromSession).toHaveBeenCalledOnce();
    expect(updates).toEqual([quota]);

    monitor.dispose();
  });

  it('getStatsView() shares the live collections while getStats() copies them', () => {
    const monitor = new SessionMonitor(createProvider() as never);
    const view = monitor.getStatsView();
    expect(monitor.getStatsView().toolCalls).toBe(view.toolCalls);
    expect(monitor.getStatsView().modelUsage).toBe(view.modelUsage);
    const snapshot = monitor.getStats();
    expect(snapshot.toolCalls).not.toBe(view.toolCalls);
    expect(snapshot.modelUsage).not.toBe(view.modelUsage);
    expect(snapshot.toolCalls).toEqual(view.toolCalls);
    monitor.dispose();
  });
});

it('preserves subscribers and provider through repeated stop/start cycles', async () => {
  vi.useFakeTimers();
  const pending: unknown[] = [];
  const provider = createProvider({
    findActiveSession: vi.fn(() => '/tmp/db-sessions/proj_1/session.json'),
    createReader: vi.fn(() => ({
      readNew: () => pending.splice(0),
      exists: () => true,
      wasTruncated: () => false,
      flush: vi.fn(),
      getPosition: () => 100,
    })),
  });
  const monitor = new SessionMonitor(provider as never);
  const started = vi.fn();
  const ended = vi.fn();
  const usage = vi.fn();
  monitor.onSessionStart(started);
  monitor.onSessionEnd(ended);
  monitor.onTokenUsage(usage);
  for (let i = 1; i <= 3; i++) {
    expect(await monitor.start('/workspace')).toBe(true);
    expect(started).toHaveBeenCalledTimes(i);
    pending.push({
      type: 'assistant',
      timestamp: '2026-09-06T12:00:00Z',
      message: {
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(usage).toHaveBeenCalledTimes(i);
    expect(monitor.getStats().totalInputTokens).toBe(10);
    monitor.stop();
    monitor.stop();
    expect(ended).toHaveBeenCalledTimes(i);
    expect(monitor.isStopped()).toBe(true);
    expect(monitor.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  }
  expect(monitor.getProvider()).toBe(provider);
  expect(provider.dispose).not.toHaveBeenCalled();
  monitor.dispose();
});

it('resumes the saved custom directory and retains discovery subscriptions', async () => {
  vi.useFakeTimers();
  const provider = createProvider({ canMonitorDirectory: () => true });
  const monitor = new SessionMonitor(
    provider as never,
    { get: () => null, update: vi.fn() } as never,
  );
  const discovery = vi.fn();
  monitor.onDiscoveryModeChange(discovery);
  await monitor.startWithCustomPath('/custom/sessions');
  monitor.stop();
  expect(monitor.getCustomPath()).toBe('/custom/sessions');
  await monitor.start('/workspace');
  expect(provider.findSessionsInDirectory).toHaveBeenLastCalledWith('/custom/sessions');
  expect(provider.findActiveSession).not.toHaveBeenCalled();
  expect(discovery.mock.calls.map(([value]) => value)).toEqual([true, false, true]);
  monitor.stop();
  expect(vi.getTimerCount()).toBe(0);
  monitor.dispose();
});

it('does not restart discovery when stopped during an asynchronous start', async () => {
  vi.useFakeTimers();
  const monitor = new SessionMonitor(createProvider() as never);
  const start = monitor.start('/workspace');
  monitor.stop();
  await expect(start).resolves.toBe(false);
  expect(monitor.isInDiscoveryMode()).toBe(false);
  expect(monitor.isStopped()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  monitor.dispose();
});
