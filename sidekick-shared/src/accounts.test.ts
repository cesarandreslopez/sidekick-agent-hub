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
  reconcileClaudeAuthState,
  removeAccount,
  listAccounts,
  getActiveAccount,
  resolveActiveClaudeAccount,
  isMultiAccountEnabled,
} from './accounts';
import type { AccountRegistry } from './accounts';
import { getClaudeProfileHome } from './claudeProfiles';

// Use a temp dir for all test data
let tmpDir: string;

// Mock getConfigDir to use temp dir
vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('./credentialIO', () => ({
  readActiveCredentials: (configDir?: string) => {
    try {
      return JSON.parse(
        fs.readFileSync(
          path.join(configDir ?? path.join(tmpDir, '.claude'), '.credentials.json'),
          'utf8',
        ),
      );
    } catch {
      return null;
    }
  },
  writeActiveCredentials: (credentials: unknown, configDir?: string) => {
    const claudeDir = configDir ?? path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify(credentials));
  },
}));

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-accounts-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readAccountRegistry', () => {
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

describe('writeAccountRegistry', () => {
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

describe('readActiveClaudeAccount', () => {
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

describe('addCurrentAccount', () => {
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

describe('switchToAccount', () => {
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

    expect(switchToAccount('uuid-b')).toEqual({ success: true });
    expect(readActiveClaudeAccount()).toEqual({ email: 'b@example.com', uuid: 'uuid-b' });

    expect(switchToAccount('uuid-a')).toEqual({ success: true });

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

    expect(switchToAccount('uuid-b')).toEqual({ success: true });

    expect(readActiveClaudeAccount()).toEqual({ email: 'b@example.com', uuid: 'uuid-b' });
    expect(fs.existsSync(path.join(getClaudeProfileHome('uuid-b'), '.credentials.json'))).toBe(
      true,
    );
  });
});

describe('Claude profile-home apply and migration', () => {
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

describe('removeAccount', () => {
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

describe('isMultiAccountEnabled', () => {
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

describe('resolveActiveClaudeAccount', () => {
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
});
