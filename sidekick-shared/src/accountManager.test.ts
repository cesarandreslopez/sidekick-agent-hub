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

// Real credential I/O (file mode on the forced linux platform), spy-able so
// the cleanup of every temporary login home can be asserted.
vi.mock('./credentialIO', { spy: true });

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  };
});

import { getActiveAccount } from './accounts';
import * as credentialIO from './credentialIO';
import { readClaudeCredentialLedger } from './claudeCredentialLedger';
import {
  beginAccountLogin,
  discardAccountLogin,
  finalizeAccountLogin,
  getAccountLoginStatus,
  listAllAccounts,
  spawnAccountLogin,
  switchAccount,
} from './accountManager';
import { getClaudeProfileHome } from './claudeProfiles';
import { getCodexProfileHome } from './codexProfiles';
import { readSavedAccountRegistry } from './accountRegistry';
import {
  accountLoginStatusSchema,
  accountManagerResultSchema,
  beginAccountLoginResultSchema,
  listAllAccountsResultSchema,
} from './schemas/accountManager';

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

describe('accountManager', { timeout: 30_000 }, () => {
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

    expect(beginAccountLoginResultSchema.parse(result)).toEqual(result);
    expect(result.success).toBe(true);
    expect(result.loginId).toBeTruthy();
    expect(result.command).toBe('claude');
    expect(result.args).toEqual(['auth', 'login']);
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

    expect(accountManagerResultSchema.parse(result)).toMatchObject({ success: true });
    expect(result).toMatchObject({ success: true, verified: true });
    expect(getActiveAccount()?.uuid).toBe('uuid-work');
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          '.config',
          'sidekick',
          'accounts',
          'credentials',
          'uuid-work.credentials.json',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, '.config', 'sidekick', 'accounts', 'configs', 'uuid-work.config.json'),
      ),
    ).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8')),
    ).toEqual({ claudeAiOauth: { accessToken: 'access-uuid-work' } });
  });

  it('can finalize Claude and Codex logins without activation', () => {
    const claude = beginAccountLogin('claude-code', 'Work');
    writeClaudeLoginFiles(claude.configDir!);
    expect(finalizeAccountLogin('claude-code', claude.loginId, { activate: false })).toMatchObject({
      success: true,
    });

    const codex = beginAccountLogin('codex', 'Personal');
    writeCodexAuth(codex.configDir!);
    expect(finalizeAccountLogin('codex', codex.loginId, { activate: false })).toMatchObject({
      success: true,
    });

    const registry = readSavedAccountRegistry();
    expect(registry?.activeByProvider).toEqual({ 'claude-code': null, codex: null });
    const accounts = listAllAccounts();
    expect(listAllAccountsResultSchema.parse(accounts)).toEqual(accounts);
    expect(accounts.claude).toHaveLength(1);
    expect(accounts.codex).toHaveLength(1);
  });

  it('returns schema-valid login polling results', () => {
    const begin = beginAccountLogin('claude-code', 'Work');
    const status = getAccountLoginStatus('claude-code', begin.loginId);
    expect(accountLoginStatusSchema.parse(status)).toEqual(status);
  });

  it('switches accounts through the provider-neutral wrapper', () => {
    const begin = beginAccountLogin('claude-code', 'Work');
    writeClaudeLoginFiles(begin.configDir!);
    finalizeAccountLogin('claude-code', begin.loginId, { activate: false });

    expect(switchAccount('claude-code', 'uuid-work')).toMatchObject({
      success: true,
      verified: true,
    });

    expect(getActiveAccount()?.uuid).toBe('uuid-work');
  });

  it('spawns a Claude login and finalizes when the isolated profile authenticates', async () => {
    mockSpawn.mockImplementation(
      (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        writeClaudeLoginFiles(options.env!.CLAUDE_CONFIG_DIR!);
        const child = makeChildProcess();
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      },
    );

    const result = await spawnAccountLogin('claude-code', 'Work', {
      stdio: 'pipe',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['auth', 'login'],
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

  it('returns an immediate failure when spawning emits an error', async () => {
    mockSpawn.mockImplementation(() => {
      const child = makeChildProcess();
      queueMicrotask(() => child.emit('error', new Error('spawn claude ENOENT')));
      return child;
    });

    const result = await spawnAccountLogin('claude-code', 'Work', {
      stdio: 'pipe',
      timeoutMs: 100,
    });

    expect(result).toEqual({
      success: false,
      error: 'Could not spawn account login: spawn claude ENOENT',
    });
  });
});

describe('undoLastSwitch', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-undo-'));
    ensureLiveClaudeDir();
    setPlatform('linux');
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reverts to the previous account, rejects stale tokens, and reports when nothing can be undone', async () => {
    const { getLastSwitch, undoLastSwitch } = await import('./accountManager');
    expect((await undoLastSwitch('claude-code')).error).toMatch(/no account switch to undo/i);

    const a = beginAccountLogin('claude-code', 'A');
    writeClaudeLoginFiles(a.configDir!, 'a@example.com', 'uuid-a');
    finalizeAccountLogin('claude-code', a.loginId);
    const b = beginAccountLogin('claude-code', 'B');
    writeClaudeLoginFiles(b.configDir!, 'b@example.com', 'uuid-b');
    finalizeAccountLogin('claude-code', b.loginId, { activate: false });

    const switched = switchAccount('claude-code', 'uuid-b');
    expect(switched).toMatchObject({ success: true, previousAccountId: 'uuid-a' });
    expect(getLastSwitch('claude-code')?.token).toBe(switched.undoToken);

    expect((await undoLastSwitch('claude-code', 'not-the-token')).error).toMatch(
      /newer account switch/i,
    );
    expect(getActiveAccount()?.uuid).toBe('uuid-b');

    const undone = await undoLastSwitch('claude-code', switched.undoToken);
    expect(undone).toMatchObject({ success: true, accountId: 'uuid-a', verified: true });
    expect(getActiveAccount()?.uuid).toBe('uuid-a');
  });

  it('re-authenticates an existing Claude profile in place and defaults an empty label to the email', () => {
    const first = beginAccountLogin('claude-code', '');
    writeClaudeLoginFiles(first.configDir!, 'a@example.com', 'uuid-a');
    expect(finalizeAccountLogin('claude-code', first.loginId)).toMatchObject({ success: true });
    expect(getActiveAccount()).toMatchObject({ uuid: 'uuid-a', label: 'a@example.com' });

    const again = beginAccountLogin('claude-code', 'ignored', { existingAccountId: 'uuid-a' });
    expect(again.success && again.existingAccountId).toBe('uuid-a');
    writeClaudeLoginFiles(again.configDir!, 'a@example.com', 'uuid-a');
    // A fresh sign-in mints a new chain whose access token expires later.
    fs.writeFileSync(
      path.join(again.configDir!, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fresh-token',
          refreshToken: 'fresh-refresh',
          expiresAt: Date.now() + 8 * 60 * 60 * 1000,
        },
      }),
    );
    expect(finalizeAccountLogin('claude-code', again.loginId)).toMatchObject({ success: true });
    expect(listAllAccounts().claude).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8')),
    ).toMatchObject({ claudeAiOauth: { accessToken: 'fresh-token' } });
    expect(fs.existsSync(again.configDir!)).toBe(false);
    // I1: the live account's profile home never receives the new login.
    expect(fs.existsSync(path.join(getClaudeProfileHome('uuid-a'), '.credentials.json'))).toBe(
      false,
    );

    expect(beginAccountLogin('claude-code', 'x', { existingAccountId: 'missing' })).toMatchObject({
      success: false,
    });
  });
});

describe(
  'temporary Claude login homes are released on every exit (I4)',
  { timeout: 30_000 },
  () => {
    let spawnedHome: string | undefined;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-login-cleanup-'));
      ensureLiveClaudeDir();
      setPlatform('linux');
      spawnedHome = undefined;
      mockSpawn.mockReset();
      mockSpawnSync.mockReset();
      mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
      vi.mocked(credentialIO.deleteStoredCredentials).mockClear();
    });

    afterEach(() => {
      setPlatform(originalPlatform);
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Spawn stub: records the login home; `onSpawn` scripts the child. */
    function stubSpawn(
      onSpawn: (child: ReturnType<typeof makeChildProcess>, home: string) => void,
    ): void {
      mockSpawn.mockImplementation(
        (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          spawnedHome = options.env!.CLAUDE_CONFIG_DIR!;
          const child = makeChildProcess();
          onSpawn(child, spawnedHome);
          return child;
        },
      );
    }

    function expectReleased(): void {
      expect(spawnedHome).toBeDefined();
      expect(credentialIO.deleteStoredCredentials).toHaveBeenCalledWith(spawnedHome);
      expect(fs.existsSync(path.dirname(spawnedHome!))).toBe(false);
      // The ledger no longer lists the home once its store is gone.
      expect(readClaudeCredentialLedger().map((entry) => entry.configDir)).not.toContain(
        path.resolve(spawnedHome!),
      );
    }

    it('records the login home in the ledger before the CLI can create its item', () => {
      const begin = beginAccountLogin('claude-code', 'Work');
      expect(readClaudeCredentialLedger()).toEqual([
        expect.objectContaining({ configDir: path.resolve(begin.configDir!), purpose: 'login' }),
      ]);
    });

    it('on success', async () => {
      stubSpawn((child, home) => {
        writeClaudeLoginFiles(home);
        queueMicrotask(() => child.emit('exit', 0, null));
      });
      expect(
        await spawnAccountLogin('claude-code', 'Work', { stdio: 'pipe', timeoutMs: 100 }),
      ).toMatchObject({
        success: true,
      });
      expectReleased();
    });

    it('when the CLI exits before authenticating', async () => {
      stubSpawn((child) => queueMicrotask(() => child.emit('exit', 1, null)));
      expect(
        (await spawnAccountLogin('claude-code', 'Work', { stdio: 'pipe', timeoutMs: 100 })).success,
      ).toBe(false);
      expectReleased();
    });

    it('when spawning fails', async () => {
      stubSpawn((child) =>
        queueMicrotask(() => child.emit('error', new Error('spawn claude ENOENT'))),
      );
      expect(
        (await spawnAccountLogin('claude-code', 'Work', { stdio: 'pipe', timeoutMs: 100 })).success,
      ).toBe(false);
      expectReleased();
    });

    it('when aborted mid-login', async () => {
      const controller = new AbortController();
      stubSpawn(() => setTimeout(() => controller.abort(), 10));
      const result = await spawnAccountLogin('claude-code', 'Work', {
        stdio: 'pipe',
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      expect(result.error).toMatch(/aborted/i);
      expectReleased();
    });

    it('on timeout', async () => {
      stubSpawn(() => undefined);
      expect(
        (await spawnAccountLogin('claude-code', 'Work', { stdio: 'pipe', timeoutMs: 0 })).error,
      ).toMatch(/timed out/i);
      expectReleased();
    });

    it('when finalize fails after authentication', async () => {
      stubSpawn((child, home) => {
        writeClaudeLoginFiles(home);
        queueMicrotask(() => child.emit('exit', 0, null));
      });
      vi.mocked(credentialIO.writeActiveCredentials).mockImplementationOnce(() => {
        throw new credentialIO.ClaudeCredentialWriteError('simulated Keychain failure');
      });
      const result = await spawnAccountLogin('claude-code', 'Work', {
        stdio: 'pipe',
        timeoutMs: 100,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/simulated Keychain failure/);
      expectReleased();
      // The sign-in itself is not lost: the private backup was written first.
      expect(
        fs.existsSync(
          path.join(
            tmpDir,
            '.config',
            'sidekick',
            'accounts',
            'credentials',
            'uuid-work.credentials.json',
          ),
        ),
      ).toBe(true);
    });

    it('when a host abandons a login through discardAccountLogin, but never for a saved account', () => {
      const begin = beginAccountLogin('claude-code', 'Work');
      writeClaudeLoginFiles(begin.configDir!);
      spawnedHome = begin.configDir!;

      expect(discardAccountLogin('claude-code', begin.loginId)).toBe(true);
      expectReleased();

      const saved = beginAccountLogin('claude-code', 'Saved');
      writeClaudeLoginFiles(saved.configDir!, 's@example.com', 'uuid-saved');
      finalizeAccountLogin('claude-code', saved.loginId, { activate: false });
      expect(discardAccountLogin('claude-code', 'uuid-saved')).toBe(false);
      expect(fs.existsSync(getClaudeProfileHome('uuid-saved'))).toBe(true);
    });
  },
);
