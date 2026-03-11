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
    getSessionId: vi.fn((sessionPath: string) => sessionPath.split('/').pop()?.replace(/\.json$/, '') || 'session'),
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

    const monitor = new SessionMonitor(provider as never, { get: vi.fn(() => null), update: vi.fn() } as never);

    const active = await monitor.startWithCustomPath('/tmp/db-sessions/proj_1');

    expect(active).toBe(false);
    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      'OpenCode session database is unavailable. sqlite3 exists but could not be executed. Recommendation: ensure `sqlite3` is executable in the same environment as VS Code, then reload the window.'
    );

    monitor.dispose();
  });
});
