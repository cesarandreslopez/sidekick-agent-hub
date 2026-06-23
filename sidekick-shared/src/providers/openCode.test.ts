import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockExecSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
  };
});

import { OpenCodeProvider } from './openCode';

let tmpDir: string;

function workspaceDir(): string {
  const dir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('OpenCodeProvider', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-opencode-provider-test-'));
    vi.stubEnv('XDG_DATA_HOME', path.join(tmpDir, 'data'));
    mockExecSync.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bounds git project-id fallback probes', () => {
    const workspace = workspaceDir();
    mockExecSync.mockReturnValue('abcdef123456\n');

    expect(new OpenCodeProvider().encodeWorkspacePath(workspace)).toBe('abcdef123456');
    expect(mockExecSync).toHaveBeenCalledWith(
      'git rev-list --max-parents=0 HEAD',
      expect.objectContaining({
        cwd: workspace,
        encoding: 'utf-8',
        timeout: 4000,
        killSignal: 'SIGKILL',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('falls back to the workspace path when the git probe is killed', () => {
    const workspace = workspaceDir();
    mockExecSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT', signal: 'SIGKILL' });
    });

    expect(new OpenCodeProvider().encodeWorkspacePath(workspace)).toBe(workspace);
    expect(mockExecSync).toHaveBeenCalledWith(
      'git rev-list --max-parents=0 HEAD',
      expect.objectContaining({
        cwd: workspace,
        timeout: 4000,
        killSignal: 'SIGKILL',
      }),
    );
  });
});
