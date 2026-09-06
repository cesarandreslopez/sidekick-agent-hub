import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionProviderBase } from '../providers/types';

const state = vi.hoisted(() => ({ existingDatabase: '', openedDirectories: [] as string[] }));
vi.mock('fs', async () => ({
  ...(await vi.importActual<typeof import('fs')>('fs')),
  existsSync: (value: string) => value === state.existingDatabase,
}));
vi.mock('os', async () => ({
  ...(await vi.importActual<typeof import('os')>('os')),
  homedir: () => '/home/test',
}));
vi.mock('../providers/openCodeDatabase', () => ({
  OpenCodeDatabase: class {
    constructor(directory: string) {
      state.openedDirectories.push(directory);
    }
  },
}));
import { createWatcher } from './factory';
import { getOpenCodeDataDir } from '../providers/openCode';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  state.openedDirectories = [];
});

describe('OpenCode watcher database resolution', () => {
  it.each([
    {
      platform: 'darwin',
      directory: path.join('/home/test', 'Library', 'Application Support', 'opencode'),
    },
    { platform: 'darwin', directory: path.join('/home/test', '.local', 'share', 'opencode') },
    { platform: 'linux', directory: path.join('/home/test', '.local', 'share', 'opencode') },
    {
      platform: 'win32',
      directory: path.join('/local-app-data', 'opencode'),
      localAppData: '/local-app-data',
    },
    { platform: 'win32', directory: path.join('/app-data', 'opencode'), appData: '/app-data' },
    { platform: 'linux', directory: path.join('/xdg', 'opencode'), xdg: '/xdg' },
  ])('uses the discovered database on $platform at $directory', (testCase) => {
    Object.defineProperty(process, 'platform', { value: testCase.platform });
    vi.stubEnv('XDG_DATA_HOME', testCase.xdg ?? '');
    vi.stubEnv('LOCALAPPDATA', testCase.localAppData ?? '');
    vi.stubEnv('APPDATA', testCase.appData ?? '');
    state.existingDatabase = path.join(testCase.directory, 'opencode.db');
    const sessionPath = path.join(testCase.directory, 'db-sessions', 'project', 'session.json');
    const provider = {
      id: 'opencode',
      displayName: 'OpenCode',
      findAllSessions: () => [sessionPath],
      getSessionId: () => 'session',
    } as unknown as SessionProviderBase;
    createWatcher({ provider, workspacePath: '/workspace', callbacks: { onEvent: vi.fn() } });
    expect(getOpenCodeDataDir()).toBe(testCase.directory);
    expect(state.openedDirectories).toEqual([testCase.directory]);
  });
});
