import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readAccountRegistry,
  writeAccountRegistry,
  readActiveClaudeAccount,
  addCurrentAccount,
  switchToAccount,
  resolveActiveClaudeHome,
  applyActiveClaudeToLiveHome,
  applyClaudeProfileToLiveHome,
  reconcileClaudeAuthState,
  readStoredClaudeAccount,
  removeAccount,
  listAccounts,
  getActiveAccount,
  resolveActiveClaudeAccount,
  isMultiAccountEnabled,
} from './accounts';
import type { AccountRegistry } from './accounts';
import { getClaudeProfileHome } from './claudeProfiles';
import { _onRawAccountsChanged } from './accountChangeSignal';
import { getActiveSavedAccount, setActiveSavedAccount } from './accountRegistry';

// Use a temp dir for all test data
let tmpDir: string;

// Mock getConfigDir to use temp dir
vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

// The real credentialIO in file mode (platform forced to linux below): the
// write verification and the ledger run for real, and exports stay spy-able.
vi.mock('./credentialIO', { spy: true });

// Record registry-lock scopes and registry reads to prove the facade's
// read-modify-write happens inside one lock acquisition.
const lockEvents = vi.hoisted(() => [] as string[]);
vi.mock('./writers/atomic', async () => {
  const actual = await vi.importActual<typeof import('./writers/atomic')>('./writers/atomic');
  return {
    ...actual,
    withFileLockSync: <T>(lockPath: string, operation: () => T): T => {
      const name = lockPath.split(/[\\/]/).pop() ?? lockPath;
      lockEvents.push(`enter:${name}`);
      try {
        return actual.withFileLockSync(lockPath, operation);
      } finally {
        lockEvents.push(`exit:${name}`);
      }
    },
  };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).endsWith('accounts.json')) lockEvents.push('read:accounts.json');
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readFileSync,
  };
});

// Mock os.homedir to isolate .claude dir
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

function writeClaudeConfig(email: string, uuid: string): void {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } }),
  );
}

function writeClaudeCredentials(token: string): void {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'rt_' + token } }),
  );
}

function writeClaudeProfileAccount(uuid: string, email: string, token: string): void {
  const home = getClaudeProfileHome(uuid);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } }),
  );
  fs.writeFileSync(
    path.join(home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'rt_' + token } }),
  );
}

function writeLegacyBackup(uuid: string, email: string, token: string): void {
  const credentialsDir = path.join(tmpDir, 'accounts', 'credentials');
  const configsDir = path.join(tmpDir, 'accounts', 'configs');
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.mkdirSync(configsDir, { recursive: true });
  fs.writeFileSync(
    path.join(credentialsDir, `${uuid}.credentials.json`),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'rt_' + token } }),
  );
  fs.writeFileSync(
    path.join(configsDir, `${uuid}.config.json`),
    JSON.stringify({ emailAddress: email, accountUuid: uuid }),
  );
}

const originalPlatform = process.platform;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-accounts-test-'));
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readJson<T = { claudeAiOauth: { accessToken: string } }>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const liveCredsPath = (): string => path.join(tmpDir, '.claude', '.credentials.json');
const profileCredsPath = (uuid: string): string =>
  path.join(getClaudeProfileHome(uuid), '.credentials.json');
const backupPath = (uuid: string): string =>
  path.join(tmpDir, 'accounts', 'credentials', `${uuid}.credentials.json`);

describe('readAccountRegistry', { timeout: 30_000 }, () => {
  it('returns null when no registry exists', () => {
    expect(readAccountRegistry()).toBeNull();
  });

  it('returns parsed registry when valid', () => {
    const registry: AccountRegistry = {
      version: 1,
      activeAccountUuid: 'uuid-1',
      accounts: [{ uuid: 'uuid-1', email: 'a@b.com', addedAt: '2025-01-01T00:00:00Z' }],
    };
    const dir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(registry));

    const result = readAccountRegistry();
    expect(result).toEqual(registry);
  });

  it('returns null for malformed JSON', () => {
    const dir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'accounts.json'), 'not json');
    expect(readAccountRegistry()).toBeNull();
  });
});

describe('writeAccountRegistry', { timeout: 30_000 }, () => {
  it('writes and reads back correctly', () => {
    const registry: AccountRegistry = {
      version: 1,
      activeAccountUuid: null,
      accounts: [],
    };
    writeAccountRegistry(registry);
    expect(readAccountRegistry()).toEqual(registry);
  });
});

describe('readActiveClaudeAccount', { timeout: 30_000 }, () => {
  it('returns null when no .claude.json exists', () => {
    expect(readActiveClaudeAccount()).toBeNull();
  });

  it('returns email and uuid from valid config', () => {
    writeClaudeConfig('test@example.com', 'uuid-123');
    const result = readActiveClaudeAccount();
    expect(result).toEqual({ email: 'test@example.com', uuid: 'uuid-123' });
  });

  it('returns null when oauthAccount is missing', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ someKey: 'value' }));
    expect(readActiveClaudeAccount()).toBeNull();
  });
});

describe('addCurrentAccount', { timeout: 30_000 }, () => {
  it('returns error when no active claude account', () => {
    const result = addCurrentAccount();
    expect(result.success).toBe(false);
    expect(result.error).toContain('No active Claude account');
  });

  it('saves current account with label', () => {
    writeClaudeConfig('work@corp.com', 'uuid-work');
    writeClaudeCredentials('tok_work');

    const result = addCurrentAccount('Work');
    expect(result.success).toBe(true);

    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe('work@corp.com');
    expect(accounts[0].label).toBe('Work');
    expect(accounts[0].uuid).toBe('uuid-work');
  });

  it('updates existing account credentials on re-add', () => {
    writeClaudeConfig('work@corp.com', 'uuid-work');
    writeClaudeCredentials('tok_work_v1');
    addCurrentAccount('Work');

    // Update credentials
    writeClaudeCredentials('tok_work_v2');
    const result = addCurrentAccount('Work Updated');
    expect(result.success).toBe(true);

    // Should still be 1 account
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).toBe('Work Updated');

    // Credentials file should be updated
    const credPath = path.join(tmpDir, 'accounts', 'credentials', 'uuid-work.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    expect(creds.claudeAiOauth.accessToken).toBe('tok_work_v2');
  });
});

describe('switchToAccount', { timeout: 30_000 }, () => {
  beforeEach(() => {
    // Set up two accounts
    writeClaudeConfig('personal@gmail.com', 'uuid-personal');
    writeClaudeCredentials('tok_personal');
    addCurrentAccount('Personal');

    writeClaudeConfig('work@corp.com', 'uuid-work');
    writeClaudeCredentials('tok_work');
    addCurrentAccount('Work');
  });

  it('switches from work to personal', () => {
    const result = switchToAccount('uuid-personal');
    expect(result.success).toBe(true);

    const active = getActiveAccount();
    expect(active?.uuid).toBe('uuid-personal');

    // Verify credentials were swapped
    const creds = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8'),
    );
    expect(creds.claudeAiOauth.accessToken).toBe('tok_personal');
  });

  it('returns success when already on target account', () => {
    const result = switchToAccount('uuid-work');
    expect(result.success).toBe(true);
  });

  it('returns error for unknown uuid', () => {
    const result = switchToAccount('uuid-nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error when no registry exists', () => {
    // Wipe registry
    const regPath = path.join(tmpDir, 'accounts', 'accounts.json');
    fs.unlinkSync(regPath);

    const result = switchToAccount('uuid-personal');
    expect(result.success).toBe(false);
  });

  it('switches from profile homes and preserves rotated credentials losslessly', () => {
    const registry: AccountRegistry = {
      version: 1,
      activeAccountUuid: 'uuid-a',
      accounts: [
        { uuid: 'uuid-a', email: 'a@example.com', label: 'A', addedAt: '2026-01-01T00:00:00Z' },
        { uuid: 'uuid-b', email: 'b@example.com', label: 'B', addedAt: '2026-01-01T00:00:00Z' },
      ],
    };
    writeAccountRegistry(registry);
    writeClaudeProfileAccount('uuid-a', 'a@example.com', 'tok_a_rotated');
    writeClaudeProfileAccount('uuid-b', 'b@example.com', 'tok_b');

    expect(switchToAccount('uuid-b')).toMatchObject({ success: true, verified: true });
    expect(readActiveClaudeAccount()).toEqual({ email: 'b@example.com', uuid: 'uuid-b' });

    expect(switchToAccount('uuid-a')).toMatchObject({ success: true, verified: true });

    const liveCreds = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8'),
    );
    expect(getActiveAccount()?.uuid).toBe('uuid-a');
    expect(readActiveClaudeAccount()).toEqual({ email: 'a@example.com', uuid: 'uuid-a' });
    expect(liveCreds.claudeAiOauth.accessToken).toBe('tok_a_rotated');
  });

  it('switches pre-migration flat backups and creates the target profile home', () => {
    const registry: AccountRegistry = {
      version: 1,
      activeAccountUuid: null,
      accounts: [
        { uuid: 'uuid-b', email: 'b@example.com', label: 'B', addedAt: '2026-01-01T00:00:00Z' },
      ],
    };
    writeAccountRegistry(registry);
    writeLegacyBackup('uuid-b', 'b@example.com', 'tok_b');

    expect(switchToAccount('uuid-b')).toMatchObject({ success: true, verified: true });

    expect(readActiveClaudeAccount()).toEqual({ email: 'b@example.com', uuid: 'uuid-b' });
    // B is live now: its profile home gets no CLI copy (I1); the backup stays.
    expect(fs.existsSync(profileCredsPath('uuid-b'))).toBe(false);
    expect(readJson(liveCredsPath())?.claudeAiOauth.accessToken).toBe('tok_b');
    expect(readJson(backupPath('uuid-b'))?.claudeAiOauth.accessToken).toBe('tok_b');
  });

  it('refuses to interleave with another process holding the auth-swap lock', () => {
    // A held lock must fail the switch cleanly — callers only test
    // result.success — and a successful switch must leave no lock residue.
    const lockPath = path.join(tmpDir, 'accounts', 'claude', 'auth-swap.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${process.pid}:wedged`, { mode: 0o600 });

    const started = Date.now();
    const blocked = switchToAccount('uuid-personal');
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/no progress/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);

    fs.rmSync(lockPath, { force: true });
    const retried = switchToAccount('uuid-personal');
    expect(retried.success).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 15_000);
});

describe('Claude profile-home apply and migration', { timeout: 30_000 }, () => {
  it('resolves the active Claude profile home or falls back to the live home', () => {
    expect(resolveActiveClaudeHome()).toBe(path.join(tmpDir, '.claude'));

    writeAccountRegistry({
      version: 1,
      activeAccountUuid: 'uuid-a',
      accounts: [{ uuid: 'uuid-a', email: 'a@example.com', addedAt: '2026-01-01T00:00:00Z' }],
    });

    expect(resolveActiveClaudeHome()).toBe(getClaudeProfileHome('uuid-a'));
  });

  it('applies the active Claude profile to the live home', () => {
    writeAccountRegistry({
      version: 1,
      activeAccountUuid: 'uuid-a',
      accounts: [{ uuid: 'uuid-a', email: 'a@example.com', addedAt: '2026-01-01T00:00:00Z' }],
    });
    writeClaudeProfileAccount('uuid-a', 'a@example.com', 'tok_a');

    expect(applyActiveClaudeToLiveHome()).toEqual({ success: true });

    expect(readActiveClaudeAccount()).toEqual({ email: 'a@example.com', uuid: 'uuid-a' });
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8'))
        .claudeAiOauth.accessToken,
    ).toBe('tok_a');
  });

  it('migrates flat backup accounts into profile homes once', () => {
    writeAccountRegistry({
      version: 1,
      activeAccountUuid: 'uuid-a',
      accounts: [{ uuid: 'uuid-a', email: 'a@example.com', addedAt: '2026-01-01T00:00:00Z' }],
    });
    writeLegacyBackup('uuid-a', 'a@example.com', 'tok_a');

    reconcileClaudeAuthState();

    const markerPath = path.join(tmpDir, 'accounts', 'claude', '.profiles-migrated-v1');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(
      readActiveCredentialsFrom(getClaudeProfileHome('uuid-a')).claudeAiOauth.accessToken,
    ).toBe('tok_a');

    writeLegacyBackup('uuid-a', 'a@example.com', 'tok_modified');
    reconcileClaudeAuthState();

    expect(
      readActiveCredentialsFrom(getClaudeProfileHome('uuid-a')).claudeAiOauth.accessToken,
    ).toBe('tok_a');
  });

  it('does not throw when migration sees malformed flat backup data', () => {
    writeAccountRegistry({
      version: 1,
      activeAccountUuid: null,
      accounts: [{ uuid: 'uuid-bad', email: 'bad@example.com', addedAt: '2026-01-01T00:00:00Z' }],
    });
    const configsDir = path.join(tmpDir, 'accounts', 'configs');
    fs.mkdirSync(configsDir, { recursive: true });
    fs.writeFileSync(path.join(configsDir, 'uuid-bad.config.json'), '{not-json');

    expect(() => reconcileClaudeAuthState()).not.toThrow();
    expect(fs.existsSync(path.join(tmpDir, 'accounts', 'claude', '.profiles-migrated-v1'))).toBe(
      true,
    );
  });
});

function readActiveCredentialsFrom(configDir: string): { claudeAiOauth: { accessToken: string } } {
  return JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
}

describe('removeAccount', { timeout: 30_000 }, () => {
  beforeEach(() => {
    writeClaudeConfig('a@b.com', 'uuid-a');
    writeClaudeCredentials('tok_a');
    addCurrentAccount();
  });

  it('removes an account', () => {
    expect(listAccounts()).toHaveLength(1);

    const result = removeAccount('uuid-a');
    expect(result.success).toBe(true);
    expect(listAccounts()).toHaveLength(0);

    // Backed-up files should be deleted
    expect(
      fs.existsSync(path.join(tmpDir, 'accounts', 'credentials', 'uuid-a.credentials.json')),
    ).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'accounts', 'configs', 'uuid-a.config.json'))).toBe(
      false,
    );
  });

  it('returns error for unknown uuid', () => {
    const result = removeAccount('uuid-unknown');
    expect(result.success).toBe(false);
  });
});

describe('isMultiAccountEnabled', { timeout: 30_000 }, () => {
  it('returns false when no accounts', () => {
    expect(isMultiAccountEnabled()).toBe(false);
  });

  it('returns true when at least one account', () => {
    writeClaudeConfig('a@b.com', 'uuid-a');
    writeClaudeCredentials('tok');
    addCurrentAccount();
    expect(isMultiAccountEnabled()).toBe(true);
  });
});

describe('resolveActiveClaudeAccount', { timeout: 30_000 }, () => {
  // Saves accounts A and B; leaves B live in the system home and active.
  function setupTwoClaudeAccounts(): void {
    writeClaudeConfig('a@x.com', 'uuid-a');
    writeClaudeCredentials('tok-a');
    addCurrentAccount('A');
    writeClaudeConfig('b@y.com', 'uuid-b');
    writeClaudeCredentials('tok-b');
    addCurrentAccount('B');
  }

  it('prefers the live login and self-heals the active pointer to the matching saved profile', () => {
    setupTwoClaudeAccounts();
    expect(getActiveAccount()?.uuid).toBe('uuid-b');

    // Simulate a native `claude /login` back into account A (no sidekick switch).
    writeClaudeConfig('a@x.com', 'uuid-a');

    const resolved = resolveActiveClaudeAccount();

    expect(resolved).toMatchObject({ email: 'a@x.com', label: 'A', source: 'live' });
    // Registry pointer self-healed to the live login.
    expect(getActiveAccount()?.uuid).toBe('uuid-a');
  });

  it('does not change the pointer when the live login already matches the active profile', () => {
    setupTwoClaudeAccounts();

    const resolved = resolveActiveClaudeAccount();

    expect(resolved).toMatchObject({ email: 'b@y.com', label: 'B', source: 'live' });
    expect(getActiveAccount()?.uuid).toBe('uuid-b');
  });

  it('matches a saved profile by email when the live account UUID changed (re-auth)', () => {
    setupTwoClaudeAccounts(); // active = B

    // Same account A email, but a re-auth produced a new accountUuid that does
    // not match the saved providerAccountId.
    writeClaudeConfig('a@x.com', 'uuid-a-rotated');

    const resolved = resolveActiveClaudeAccount();

    expect(resolved).toMatchObject({ email: 'a@x.com', label: 'A', source: 'live' });
    // Self-healed to profile A via the email fallback.
    expect(getActiveAccount()?.uuid).toBe('uuid-a');
  });

  it('shows an unknown live account as-is without saving it or moving the pointer', () => {
    setupTwoClaudeAccounts();

    // Logged into an account sidekick has never saved.
    writeClaudeConfig('c@z.com', 'uuid-c');

    const resolved = resolveActiveClaudeAccount();

    expect(resolved.email).toBe('c@z.com');
    expect(resolved.label).toBeUndefined();
    expect(resolved.source).toBe('live');
    // No matching profile → pointer untouched, no new profile created.
    expect(getActiveAccount()?.uuid).toBe('uuid-b');
    expect(listAccounts()).toHaveLength(2);
  });

  it('falls back to the saved account when there is no live auth', () => {
    setupTwoClaudeAccounts();
    fs.rmSync(path.join(tmpDir, '.claude', '.claude.json'));

    const resolved = resolveActiveClaudeAccount();

    expect(resolved).toMatchObject({ email: 'b@y.com', label: 'B', source: 'registry' });
    expect(getActiveAccount()?.uuid).toBe('uuid-b');
  });

  it('survives a registry write failure during self-heal and still returns the live identity', () => {
    setupTwoClaudeAccounts(); // active = B

    // Simulate a native `claude /login` back into account A (mismatch → self-heal).
    writeClaudeConfig('a@x.com', 'uuid-a');

    // Make the accounts dir read-only so the self-heal write fails. The invariant
    // under test: resolution never throws and still reports account A.
    const accountsDir = path.join(tmpDir, 'accounts');
    fs.chmodSync(accountsDir, 0o500);
    try {
      expect(() => resolveActiveClaudeAccount()).not.toThrow();
      expect(resolveActiveClaudeAccount()).toMatchObject({
        email: 'a@x.com',
        label: 'A',
        source: 'live',
      });
    } finally {
      fs.chmodSync(accountsDir, 0o700);
    }
  });

  it("reports source 'none' with no live login and no saved account", () => {
    // Fresh tmpDir: no .claude.json, empty registry.
    const resolved = resolveActiveClaudeAccount();

    expect(resolved).toEqual({ source: 'none' });
  });
});

describe('registry lock scope of the legacy facade', { timeout: 30_000 }, () => {
  it('reads and writes the registry inside one lock acquisition for add and remove', () => {
    writeClaudeConfig('a@example.com', 'uuid-a');
    writeClaudeCredentials('token-a');

    lockEvents.length = 0;
    expect(addCurrentAccount('A').success).toBe(true);
    const enter = lockEvents.indexOf('enter:accounts.json.lock');
    const exit = lockEvents.lastIndexOf('exit:accounts.json.lock');
    const read = lockEvents.indexOf('read:accounts.json');
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(enter);
    expect(read).toBeLessThan(exit);
    expect(lockEvents.filter((e) => e === 'enter:accounts.json.lock')).toHaveLength(1);

    lockEvents.length = 0;
    expect(removeAccount('uuid-a').success).toBe(true);
    const enter2 = lockEvents.indexOf('enter:accounts.json.lock');
    const read2 = lockEvents.indexOf('read:accounts.json');
    expect(read2).toBeGreaterThan(enter2);
    expect(lockEvents.filter((e) => e === 'enter:accounts.json.lock')).toHaveLength(1);
  });

  it('self-heals the active pointer without notifying subscribers', () => {
    writeClaudeConfig('a@example.com', 'uuid-a');
    writeClaudeCredentials('token-a');
    addCurrentAccount('A');
    // Point the registry elsewhere so the next resolve has to repair it.
    setActiveSavedAccount('claude-code', null);

    const reasons: string[] = [];
    const off = _onRawAccountsChanged((reason) => reasons.push(reason));
    try {
      const resolved = resolveActiveClaudeAccount();
      expect(resolved.registryAccountId).toBe('uuid-a');
      expect(getActiveSavedAccount('claude-code')?.id).toBe('uuid-a');
      expect(reasons).toEqual([]);
    } finally {
      off();
    }
  });
});

describe('verified switch', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-accounts-switch-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedTwo(): void {
    writeAccountRegistry({
      version: 1,
      activeAccountUuid: 'uuid-a',
      accounts: [
        { uuid: 'uuid-a', email: 'a@example.com', label: 'A', addedAt: '2026-01-01T00:00:00Z' },
        { uuid: 'uuid-b', email: 'b@example.com', label: 'B', addedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    writeClaudeConfig('a@example.com', 'uuid-a');
    writeClaudeCredentials('tok_a');
    writeClaudeProfileAccount('uuid-b', 'b@example.com', 'tok_b');
  }

  it('refuses a target whose stored refresh token has expired and reports needsLogin', () => {
    seedTwo();
    const now = Date.now();
    fs.writeFileSync(
      path.join(getClaudeProfileHome('uuid-b'), '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok_b',
          refreshToken: 'r',
          expiresAt: now - 5 * DAY,
          refreshTokenExpiresAt: now - HOUR,
        },
      }),
    );

    const result = switchToAccount('uuid-b');

    expect(result).toMatchObject({ success: false, needsLogin: true, verified: false });
    expect(result.error).toMatch(/expired/);
    expect(readActiveClaudeAccount()?.uuid).toBe('uuid-a');
    expect(getActiveSavedAccount('claude-code')?.id).toBe('uuid-a');

    expect(switchToAccount('uuid-b', { force: true })).toMatchObject({ success: true });
  });

  it('captures the outgoing login (registering it if unknown), verifies, records undo, and sets the pointer last', () => {
    seedTwo();
    // The live login is an account sidekick never saw.
    writeClaudeConfig('c@example.com', 'uuid-c');
    writeClaudeCredentials('tok_c');

    const result = switchToAccount('uuid-b');

    expect(result).toMatchObject({
      success: true,
      verified: true,
      verification: 'store',
      accountId: 'uuid-b',
      email: 'b@example.com',
      hints: ['New claude sessions use b@example.com.'],
    });
    expect(result.undoToken).toBeTruthy();
    expect(result.previousAccountId).toBe('uuid-c');
    expect(readActiveClaudeAccount()).toEqual({ email: 'b@example.com', uuid: 'uuid-b' });
    const learned = listAccounts().find((a) => a.uuid === 'uuid-c');
    expect(learned?.label).toBe('c@example.com');
    expect(
      JSON.parse(
        fs.readFileSync(path.join(getClaudeProfileHome('uuid-c'), '.credentials.json'), 'utf8'),
      ).claudeAiOauth.accessToken,
    ).toBe('tok_c');
  });

  it('returns alreadyActive without writing when the target is the live login', () => {
    seedTwo();
    const before = fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8');

    const result = switchToAccount('uuid-a');

    expect(result).toMatchObject({ success: true, alreadyActive: true, verified: true });
    expect(result.undoToken).toBeUndefined();
    expect(fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8')).toBe(before);
  });

  it('rolls back and reports a failed verification when the live store does not reflect the write', async () => {
    seedTwo();
    const credentialIO = await import('./credentialIO');
    // Pretend the live store silently ignored the write (a Keychain that
    // reports success without updating the item).
    const spy = vi
      .spyOn(credentialIO, 'writeLiveClaudeCredentialStoreUnguarded')
      .mockImplementation(() => undefined);

    const result = switchToAccount('uuid-b');
    spy.mockRestore();

    expect(result).toMatchObject({ success: false, verification: 'failed', verified: false });
    expect(result.error).toMatch(/previous login was restored/);
    expect(readActiveClaudeAccount()?.uuid).toBe('uuid-a');
    expect(getActiveSavedAccount('claude-code')?.id).toBe('uuid-a');
    expect(readJson(liveCredsPath())?.claudeAiOauth.accessToken).toBe('tok_a');
  });
});

describe('one CLI-usable copy per refresh-token chain', { timeout: 30_000 }, () => {
  const HOUR = 60 * 60 * 1000;

  function seed(): void {
    writeAccountRegistry({
      version: 1,
      activeAccountUuid: 'uuid-a',
      accounts: [
        { uuid: 'uuid-a', email: 'a@example.com', label: 'A', addedAt: '2026-01-01T00:00:00Z' },
        { uuid: 'uuid-b', email: 'b@example.com', label: 'B', addedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    writeClaudeConfig('a@example.com', 'uuid-a');
    fs.writeFileSync(
      liveCredsPath(),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok_a',
          refreshToken: 'rt_a',
          expiresAt: Date.now() + 6 * HOUR,
        },
        mcpOAuth: { 'slack|1': { accessToken: 'mcp-live' } },
      }),
    );
    writeClaudeProfileAccount('uuid-b', 'b@example.com', 'tok_b');
  }

  it('I1: addCurrentAccount keeps the live account out of its profile home', () => {
    writeClaudeConfig('work@corp.com', 'uuid-work');
    writeClaudeCredentials('tok_work');

    expect(addCurrentAccount('Work').success).toBe(true);

    expect(fs.existsSync(profileCredsPath('uuid-work'))).toBe(false);
    expect(readJson(backupPath('uuid-work'))?.claudeAiOauth.accessToken).toBe('tok_work');
  });

  it('I1+I2: a switch captures the outgoing login, moves the target out of its profile home, and keeps live MCP tokens', () => {
    seed();

    expect(switchToAccount('uuid-b')).toMatchObject({ success: true, verified: true });

    const live = readJson<{ claudeAiOauth: { accessToken: string }; mcpOAuth?: unknown }>(
      liveCredsPath(),
    );
    expect(live?.claudeAiOauth.accessToken).toBe('tok_b');
    // MCP chains stay with the live store instead of a snapshot's copies.
    expect(live?.mcpOAuth).toEqual({ 'slack|1': { accessToken: 'mcp-live' } });
    // B is live: no CLI copy in its profile home.
    expect(fs.existsSync(profileCredsPath('uuid-b'))).toBe(false);
    // A is inactive: its single CLI copy holds the login only (no MCP chains).
    expect(readJson(profileCredsPath('uuid-a'))).toEqual({
      claudeAiOauth: expect.objectContaining({ accessToken: 'tok_a', refreshToken: 'rt_a' }),
    });
    // A's captured backup is the full blob.
    expect(readJson<{ mcpOAuth?: unknown }>(backupPath('uuid-a'))?.mcpOAuth).toBeDefined();
    // No journal is left behind.
    expect(fs.existsSync(path.join(tmpDir, 'accounts', 'claude', 'switch-journal.json'))).toBe(
      false,
    );
  });

  it('I2: refuses to switch when the outgoing login cannot be saved, even with force', () => {
    seed();
    const liveBefore = fs.readFileSync(liveCredsPath(), 'utf8');
    const credentialsDir = path.join(tmpDir, 'accounts', 'credentials');
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.chmodSync(credentialsDir, 0o500);
    try {
      const result = switchToAccount('uuid-b', { force: true });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/outgoing login could not be saved/);
    } finally {
      fs.chmodSync(credentialsDir, 0o700);
    }
    expect(fs.readFileSync(liveCredsPath(), 'utf8')).toBe(liveBefore);
    expect(readActiveClaudeAccount()?.uuid).toBe('uuid-a');
  });

  it('I2: rollback never clobbers a live store that changed after the failed write', async () => {
    seed();
    const credentialIO = await import('./credentialIO');
    // The write fails after something else (Claude Code) put a different
    // credential in the live store.
    const spy = vi
      .spyOn(credentialIO, 'writeLiveClaudeCredentialStoreUnguarded')
      .mockImplementation(() => {
        fs.writeFileSync(
          liveCredsPath(),
          JSON.stringify({ claudeAiOauth: { accessToken: 'tok_other', refreshToken: 'rt_other' } }),
        );
        throw new credentialIO.ClaudeCredentialWriteError('simulated');
      });

    const result = switchToAccount('uuid-b');
    spy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/could not be restored automatically/);
    expect(readJson(liveCredsPath())?.claudeAiOauth.accessToken).toBe('tok_other');
  });

  it('I2: re-login never downgrades live, and applyActiveClaudeToLiveHome never crosses accounts', () => {
    seed();
    // A's saved copy is older than live.
    fs.mkdirSync(path.dirname(backupPath('uuid-a')), { recursive: true });
    fs.writeFileSync(
      backupPath('uuid-a'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok_a_old', refreshToken: 'rt_a_old', expiresAt: 1 },
      }),
    );
    storeProfileIdentity('uuid-a', 'a@example.com');
    const liveBefore = fs.readFileSync(liveCredsPath(), 'utf8');

    const applied = applyClaudeProfileToLiveHome('uuid-a');
    expect(applied.success).toBe(true);
    expect(applied.warning).toMatch(/already at least as new/);
    expect(fs.readFileSync(liveCredsPath(), 'utf8')).toBe(liveBefore);

    // Registry pointer names B while live is A: refuse instead of overwriting.
    setActiveSavedAccount('claude-code', 'uuid-b', { silent: true });
    const crossed = applyActiveClaudeToLiveHome();
    expect(crossed.success).toBe(false);
    expect(crossed.error).toMatch(/another account/);
    expect(fs.readFileSync(liveCredsPath(), 'utf8')).toBe(liveBefore);
  });

  it('I2: a strictly fresher re-login replaces live and leaves no profile copy', () => {
    seed();
    fs.mkdirSync(path.dirname(backupPath('uuid-a')), { recursive: true });
    fs.writeFileSync(
      backupPath('uuid-a'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok_a_new',
          refreshToken: 'rt_a_new',
          expiresAt: Date.now() + 8 * HOUR,
        },
      }),
    );
    storeProfileIdentity('uuid-a', 'a@example.com');

    expect(applyClaudeProfileToLiveHome('uuid-a')).toEqual({ success: true });

    const live = readJson<{ claudeAiOauth: { accessToken: string }; mcpOAuth?: unknown }>(
      liveCredsPath(),
    );
    expect(live?.claudeAiOauth.accessToken).toBe('tok_a_new');
    expect(live?.mcpOAuth).toBeDefined();
    expect(fs.existsSync(profileCredsPath('uuid-a'))).toBe(false);
  });

  it('I2: refuses to switch when the live credential belongs to another profile (never files a chain under the wrong account)', async () => {
    seed();
    const { claudeRefreshFingerprint } = await import('./claudeCredentials');
    // B's sidecar records the live refresh token: identity says A, credential is B's.
    const bDir = path.dirname(getClaudeProfileHome('uuid-b'));
    fs.writeFileSync(
      path.join(bDir, 'health.json'),
      JSON.stringify({
        version: 1,
        capturedAt: Date.now(),
        refreshFp: claudeRefreshFingerprint({ accessToken: 'x', refreshToken: 'rt_a' }),
        source: 'switch',
      }),
    );
    writeAccountRegistry({
      version: 1,
      activeAccountUuid: 'uuid-a',
      accounts: [
        { uuid: 'uuid-a', email: 'a@example.com', label: 'A', addedAt: '2026-01-01T00:00:00Z' },
        { uuid: 'uuid-b', email: 'b@example.com', label: 'B', addedAt: '2026-01-01T00:00:00Z' },
        { uuid: 'uuid-c', email: 'c@example.com', label: 'C', addedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    writeClaudeProfileAccount('uuid-c', 'c@example.com', 'tok_c');
    const liveBefore = fs.readFileSync(liveCredsPath(), 'utf8');

    const result = switchToAccount('uuid-c');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/live credential belongs to B/);
    expect(fs.readFileSync(liveCredsPath(), 'utf8')).toBe(liveBefore);
    expect(fs.existsSync(backupPath('uuid-a'))).toBe(false);
  });

  it('I2: treats the live login under a rotated account id as already active (no downgrade)', () => {
    seed();
    // Same email as B, but a re-auth minted a new account id.
    writeClaudeConfig('b@example.com', 'uuid-b-rotated');
    const liveBefore = fs.readFileSync(liveCredsPath(), 'utf8');

    const result = switchToAccount('uuid-b');

    expect(result).toMatchObject({ success: true, alreadyActive: true });
    expect(fs.readFileSync(liveCredsPath(), 'utf8')).toBe(liveBefore);
  });

  it('migration and reads never materialise a backup for the live account', () => {
    writeAccountRegistry({
      version: 1,
      activeAccountUuid: 'uuid-a',
      accounts: [{ uuid: 'uuid-a', email: 'a@example.com', addedAt: '2026-01-01T00:00:00Z' }],
    });
    writeClaudeConfig('a@example.com', 'uuid-a');
    writeClaudeCredentials('tok_live');
    writeLegacyBackup('uuid-a', 'a@example.com', 'tok_backup');

    reconcileClaudeAuthState();
    expect(fs.existsSync(profileCredsPath('uuid-a'))).toBe(false);

    // Reads are read-only: the fresher saved copy is returned, nothing is written.
    expect(readStoredClaudeAccount('uuid-a')?.credentials).toMatchObject({
      claudeAiOauth: { accessToken: 'tok_backup' },
    });
    expect(fs.existsSync(profileCredsPath('uuid-a'))).toBe(false);
  });
});

function storeProfileIdentity(uuid: string, email: string): void {
  const home = getClaudeProfileHome(uuid);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } }),
  );
}
