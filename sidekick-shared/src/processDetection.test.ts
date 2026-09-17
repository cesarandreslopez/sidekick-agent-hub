import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

import {
  ACCOUNT_CONSUMER_REACHABILITY,
  describeAccountConsumer,
  detectRunningAccountConsumers,
  detectRunningAccountConsumersSync,
  findRunningProcesses,
  findRunningProcessesSync,
} from './processDetection';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const PS_OUTPUT = [
  '  101 /bin/zsh -zsh',
  '  202 /Users/me/.local/share/claude/versions/2.1.273 claude',
  '  303 /Applications/Claude.app/Contents/MacOS/Claude /Applications/Claude.app/Contents/MacOS/Claude',
  '  404 /opt/homebrew/bin/codex codex exec',
  '  505 /Applications/Codex.app/Contents/MacOS/Codex Codex',
  '  606 node node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  `  ${process.pid} node vitest`,
  '',
].join('\n');

const TASKLIST_OUTPUT = [
  '"System Idle Process","0","Services","0","8 K"',
  '"claude.exe","1234","Console","1","12,345 K"',
  '"Claude.exe","2345","Console","1","99,000 K"',
  '"codex.exe","3456","Console","1","20,000 K"',
  '"node.exe","4567","Console","1","20,000 K"',
  '',
].join('\r\n');

describe('processDetection', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('parses ps output on unix, distinguishes CLI from app binaries, and recognises npm claude under node', () => {
    setPlatform('darwin');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: PS_OUTPUT, stderr: '' });

    const found = findRunningProcessesSync(['claude', 'Claude', 'codex', 'Codex']);

    expect(found).toEqual([
      { pid: 202, name: 'claude', command: '/Users/me/.local/share/claude/versions/2.1.273' },
      { pid: 303, name: 'Claude', command: '/Applications/Claude.app/Contents/MacOS/Claude' },
      { pid: 404, name: 'codex', command: '/opt/homebrew/bin/codex' },
      { pid: 505, name: 'Codex', command: '/Applications/Codex.app/Contents/MacOS/Codex' },
      { pid: 606, name: 'claude', command: 'node' },
    ]);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'ps',
      ['-axo', 'pid=,comm=,args='],
      expect.objectContaining({ timeout: 4000, killSignal: 'SIGKILL' }),
    );
  });

  it('parses tasklist CSV on windows', () => {
    setPlatform('win32');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: TASKLIST_OUTPUT, stderr: '' });

    expect(findRunningProcessesSync(['claude', 'Claude', 'codex'])).toEqual([
      { pid: 1234, name: 'claude', command: 'claude.exe' },
      { pid: 2345, name: 'Claude', command: 'Claude.exe' },
      { pid: 3456, name: 'codex', command: 'codex.exe' },
    ]);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'tasklist',
      ['/FO', 'CSV', '/NH'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('returns nothing on probe failure, timeout, or empty name list', () => {
    setPlatform('linux');
    mockSpawnSync.mockReturnValue({ status: null, stdout: '', stderr: '', error: new Error('x') });
    expect(findRunningProcessesSync(['claude'])).toEqual([]);
    expect(findRunningProcessesSync([])).toEqual([]);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('groups processes into consumers with reachability text (async)', async () => {
    setPlatform('darwin');
    mockExecFile.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: Function) =>
      cb(null, PS_OUTPUT, ''),
    );

    const consumers = await detectRunningAccountConsumers('claude-code');

    expect(consumers).toEqual([
      {
        kind: 'claude-cli',
        pids: [202, 606],
        switched: true,
        reachability: ACCOUNT_CONSUMER_REACHABILITY['claude-cli'].reachability,
      },
      {
        kind: 'claude-desktop',
        pids: [303],
        switched: false,
        reachability: ACCOUNT_CONSUMER_REACHABILITY['claude-desktop'].reachability,
      },
    ]);
    expect(await findRunningProcesses([])).toEqual([]);
  });

  it('scopes the sync consumer probe per provider and lets hosts describe their own kinds', () => {
    setPlatform('darwin');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: PS_OUTPUT, stderr: '' });

    expect(detectRunningAccountConsumersSync('codex').map((c) => c.kind)).toEqual([
      'codex-cli',
      'codex-app',
    ]);
    expect(detectRunningAccountConsumersSync().map((c) => c.kind)).toEqual([
      'claude-cli',
      'claude-desktop',
      'codex-cli',
      'codex-app',
    ]);
    expect(describeAccountConsumer('vscode-extension-host', [7])).toEqual({
      kind: 'vscode-extension-host',
      pids: [7],
      switched: true,
      reachability: ACCOUNT_CONSUMER_REACHABILITY['vscode-extension-host'].reachability,
    });
  });
});
