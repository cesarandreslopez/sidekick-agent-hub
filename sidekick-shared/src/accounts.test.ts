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
  removeAccount,
  listAccounts,
  getActiveAccount,
  isMultiAccountEnabled,
} from './accounts';
import type { AccountRegistry } from './accounts';

// Use a temp dir for all test data
let tmpDir: string;

// Mock getConfigDir to use temp dir
vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('./credentialIO', () => ({
  readActiveCredentials: () => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8')
      );
    } catch {
      return null;
    }
  },
  writeActiveCredentials: (credentials: unknown) => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify(credentials)
    );
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
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } })
  );
}

function writeClaudeCredentials(token: string): void {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'rt_' + token } })
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
      fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8')
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
});

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
    expect(fs.existsSync(path.join(tmpDir, 'accounts', 'credentials', 'uuid-a.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'accounts', 'configs', 'uuid-a.config.json'))).toBe(false);
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
