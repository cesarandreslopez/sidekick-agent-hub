import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
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
    mockExecFileSync.mockReset();
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
      throw Object.assign(new Error('spawnSync timed out'), {
        code: 'ETIMEDOUT',
        signal: 'SIGKILL',
      });
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

  it('enumerates legacy session files across projects', () => {
    const sessionPath = path.join(
      process.env.XDG_DATA_HOME!,
      'opencode',
      'storage',
      'session',
      'project-one',
      'session-one.json',
    );
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ id: 'session-one', title: 'One' }));

    const files = new OpenCodeProvider().listAllSessionFiles();

    expect(files).toEqual([
      expect.objectContaining({ path: sessionPath, sessionId: 'session-one' }),
    ]);
  });

  it('finds a legacy session by id without reading every transcript', () => {
    const workspace = workspaceDir();
    mockExecSync.mockReturnValue('abcdef123\n');
    const sessionPath = path.join(
      process.env.XDG_DATA_HOME!,
      'opencode',
      'storage',
      'session',
      'abcdef123',
      'session-one.json',
    );
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, '{}');
    const provider = new OpenCodeProvider();

    expect(provider.findSessionById(workspace, 'session-one')).toBe(sessionPath);
    expect(provider.findSessionById(workspace, 'missing')).toBeNull();
    expect(provider.findSessionById(workspace, '../escape')).toBeNull();
  });

  it('keeps the legacy file-storage fallback after async listings when no database exists', async () => {
    const workspace = workspaceDir();
    mockExecSync.mockReturnValue('abcdef123\n');
    const sessionPath = path.join(
      process.env.XDG_DATA_HOME!,
      'opencode',
      'storage',
      'session',
      'abcdef123',
      'session-one.json',
    );
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ id: 'session-one', title: 'One' }));
    const provider = new OpenCodeProvider();

    // The async path must not cache an unopened database: sync callers treat
    // a cached instance as proof that open() succeeded.
    await expect(provider.listSessionFilesAsync()).resolves.toEqual([
      expect.objectContaining({ path: sessionPath, sessionId: 'session-one' }),
    ]);
    expect(provider.findAllSessions(workspace)).toEqual([sessionPath]);
  });

  it('distinguishes a missing sqlite binary from an empty workspace', () => {
    const workspace = workspaceDir();
    const dbPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'opencode.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'sqlite');
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn sqlite3 ENOENT'), { code: 'ENOENT' });
    });
    const diagnostic = vi.fn();
    const provider = new OpenCodeProvider({ onDiagnostic: diagnostic });

    expect(provider.findAllSessions(workspace)).toEqual([]);
    expect(provider.getLastOperationStatus()).toMatchObject({
      usable: false,
      degraded: true,
      runtimeStatus: { kind: 'sqlite_missing' },
      diagnostics: [expect.objectContaining({ kind: 'sqlite_missing', phase: 'query' })],
    });
    expect(diagnostic).toHaveBeenCalledOnce();
  });
});
