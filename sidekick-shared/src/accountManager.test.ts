import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockSpawnSync = vi.hoisted(() => vi.fn());
let tmpDir: string;
const originalPlatform = process.platform;

vi.mock('./paths', () => ({
  getConfigDir: () => path.join(tmpDir, '.config', 'sidekick'),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  };
});

import { getActiveAccount } from './accounts';
import {
  beginAccountLogin,
  finalizeAccountLogin,
  getAccountLoginStatus,
  listAllAccounts,
  spawnAccountLogin,
  switchAccount,
} from './accountManager';
import { getClaudeProfileHome } from './claudeProfiles';
import { getCodexProfileHome } from './codexProfiles';
import { readSavedAccountRegistry } from './accountRegistry';

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function ensureLiveClaudeDir(): void {
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
}

function writeClaudeLoginFiles(home: string, email = 'work@example.com', uuid = 'uuid-work'): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } }),
  );
  fs.writeFileSync(
    path.join(home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: `access-${uuid}` } }),
  );
}

function writeCodexAuth(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
}

function makeChildProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn(() => {
    child.emit('exit', null, 'SIGTERM');
    return true;
  });
  return child;
}

describe('accountManager', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-manager-test-'));
    ensureLiveClaudeDir();
    setPlatform('linux');
    mockSpawn.mockReset();
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('begins an isolated Claude login without spawning a process', () => {
    const result = beginAccountLogin('claude-code', 'Work');

    expect(result.success).toBe(true);
    expect(result.loginId).toBeTruthy();
    expect(result.command).toBe('claude');
    expect(result.args).toEqual(['/login']);
    expect(result.configDir).toBe(getClaudeProfileHome(result.loginId));
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: result.configDir });
    expect(fs.existsSync(result.configDir!)).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('begins an isolated Codex login with CODEX_HOME', () => {
    const result = beginAccountLogin('codex', 'Work');

    expect(result.success).toBe(true);
    expect(result.loginId).toBeTruthy();
    expect(result.command).toBe('codex');
    expect(result.args).toEqual(['login']);
    expect(result.configDir).toBe(getCodexProfileHome(result.loginId));
    expect(result.env).toEqual({ CODEX_HOME: result.configDir });
  });

  it('reports Claude login status as authenticated after credentials and identity appear', () => {
    const begin = beginAccountLogin('claude-code', 'Work');

    expect(getAccountLoginStatus('claude-code', begin.loginId).state).toBe('pending');

    writeClaudeLoginFiles(begin.configDir!);

    expect(getAccountLoginStatus('claude-code', begin.loginId)).toEqual({
      state: 'authenticated',
      email: 'work@example.com',
    });
  });

  it('finalizes a Claude login, writes backups, registers, and activates by default', () => {
    const begin = beginAccountLogin('claude-code', 'Work');
    writeClaudeLoginFiles(begin.configDir!);

    const result = finalizeAccountLogin('claude-code', begin.loginId);

    expect(result).toEqual({ success: true });
    expect(getActiveAccount()?.uuid).toBe('uuid-work');
    expect(fs.existsSync(path.join(tmpDir, '.config', 'sidekick', 'accounts', 'credentials', 'uuid-work.credentials.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.config', 'sidekick', 'accounts', 'configs', 'uuid-work.config.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8')))
      .toEqual({ claudeAiOauth: { accessToken: 'access-uuid-work' } });
  });

  it('can finalize Claude and Codex logins without activation', () => {
    const claude = beginAccountLogin('claude-code', 'Work');
    writeClaudeLoginFiles(claude.configDir!);
    expect(finalizeAccountLogin('claude-code', claude.loginId, { activate: false })).toEqual({ success: true });

    const codex = beginAccountLogin('codex', 'Personal');
    writeCodexAuth(codex.configDir!);
    expect(finalizeAccountLogin('codex', codex.loginId, { activate: false })).toEqual({ success: true });

    const registry = readSavedAccountRegistry();
    expect(registry?.activeByProvider).toEqual({ 'claude-code': null, codex: null });
    expect(listAllAccounts().claude).toHaveLength(1);
    expect(listAllAccounts().codex).toHaveLength(1);
  });

  it('switches accounts through the provider-neutral wrapper', () => {
    const begin = beginAccountLogin('claude-code', 'Work');
    writeClaudeLoginFiles(begin.configDir!);
    finalizeAccountLogin('claude-code', begin.loginId, { activate: false });

    expect(switchAccount('claude-code', 'uuid-work')).toEqual({ success: true });

    expect(getActiveAccount()?.uuid).toBe('uuid-work');
  });

  it('spawns a Claude login and finalizes when the isolated profile authenticates', async () => {
    mockSpawn.mockImplementation((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      writeClaudeLoginFiles(options.env!.CLAUDE_CONFIG_DIR!);
      const child = makeChildProcess();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });

    const result = await spawnAccountLogin('claude-code', 'Work', { stdio: 'pipe', timeoutMs: 100 });

    expect(result).toEqual({ success: true });
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['/login'],
      expect.objectContaining({
        stdio: 'pipe',
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: expect.any(String) }),
      }),
    );
    expect(getActiveAccount()?.uuid).toBe('uuid-work');
  });

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await spawnAccountLogin('claude-code', 'Work', {
      signal: controller.signal,
      stdio: 'pipe',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/aborted/i);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('fails a spawned login when timeout elapses before authentication', async () => {
    mockSpawn.mockReturnValue(makeChildProcess());

    const result = await spawnAccountLogin('claude-code', 'Work', { stdio: 'pipe', timeoutMs: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/complete|timed out/i);
  });
});
