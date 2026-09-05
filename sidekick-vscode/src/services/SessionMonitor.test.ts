import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { SessionMonitor } from './SessionMonitor';

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
    const provider = createProvider({
      getQuotaFromSession: vi.fn().mockResolvedValue(quota),
    });
    const monitor = new SessionMonitor(
      provider as never,
      { get: vi.fn(() => null), update: vi.fn() } as never,
    );
    const updates: (typeof quota)[] = [];
    monitor.onQuotaUpdate((state) => updates.push(state as typeof quota));

    await (monitor as unknown as { emitQuotaFromSession(): Promise<void> }).emitQuotaFromSession();

    expect(provider.getQuotaFromSession).toHaveBeenCalledOnce();
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
