import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

import { CodexDatabase } from './codexDatabase';

let tmpDir: string;

function writeStateDatabase(): void {
  fs.writeFileSync(path.join(tmpDir, 'state.sqlite'), 'sqlite');
}

describe('CodexDatabase', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-db-test-'));
    mockExecFileSync.mockReset();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bounds sqlite version probes and treats killed probes as unavailable', () => {
    writeStateDatabase();
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync timed out'), {
        code: 'ETIMEDOUT',
        signal: 'SIGKILL',
      });
    });

    const db = new CodexDatabase(tmpDir);

    expect(db.open()).toBe(false);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'sqlite3',
      ['--version'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 4000,
        killSignal: 'SIGKILL',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('bounds sqlite query probes', () => {
    writeStateDatabase();
    mockExecFileSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return '3.51.0';
      return JSON.stringify([{ cwd: '/repo', count: 1, lastUpdated: 2 }]);
    });

    const db = new CodexDatabase(tmpDir);

    expect(db.open()).toBe(true);
    expect(db.getAllDistinctCwds()).toEqual([{ cwd: '/repo', count: 1, lastUpdated: 2 }]);
    const queryCall = mockExecFileSync.mock.calls.find((call) => {
      const args = call[1];
      return Array.isArray(args) && args[0] === '-json';
    });
    expect(queryCall?.[2]).toEqual(
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 4000,
        killSignal: 'SIGKILL',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
  });

  it('resolves many thread ids in one asynchronous sqlite subprocess', async () => {
    writeStateDatabase();
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback: Function) => {
        callback(
          null,
          JSON.stringify([
            { id: 'one', cwd: '/repo' },
            { id: 'two', cwd: '/repo' },
          ]),
        );
      },
    );
    const db = new CodexDatabase(tmpDir);

    await expect(db.getThreadsByIdsAsync(['one', 'two'])).resolves.toEqual([
      expect.objectContaining({ id: 'one' }),
      expect.objectContaining({ id: 'two' }),
    ]);
    expect(mockExecFile).toHaveBeenCalledOnce();
    expect(mockExecFile.mock.calls[0][1][3]).toContain("id IN ('one', 'two')");
  });
});
