import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SavedAccountRegistry } from './accountRegistry';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('./credentialIO', () => ({
  readActiveCredentials: () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8'));
    } catch {
      return null;
    }
  },
  writeActiveCredentials: (credentials: unknown) => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify(credentials));
  },
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

import { getActiveSavedAccount, writeSavedAccountRegistry } from './accountRegistry';
import { ensureDefaultAccounts } from './ensureDefaultAccounts';
import { listAccounts } from './accounts';
import { getActiveCodexAccount, getCodexProfilesDir, listCodexAccounts } from './codexProfiles';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function writeClaudeSystemAccount(email = 'claude@example.com', uuid = 'claude-default'): void {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } }),
  );
  fs.writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'access-token', refreshToken: 'refresh-token' } }),
  );
}

function writeCodexSystemAuth(email = 'codex@example.com'): void {
  const codexHome = path.join(tmpDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n');
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: makeJwt({ email }),
        access_token: 'codex-access-token',
        refresh_token: 'codex-refresh-token',
      },
    }),
  );
}

function countCodexProfileDirs(): number {
  try {
    return fs.readdirSync(getCodexProfilesDir()).length;
  } catch {
    return 0;
  }
}

describe('ensureDefaultAccounts', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-ensure-default-accounts-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers default Claude and Codex accounts from system credentials', async () => {
    writeClaudeSystemAccount('claude@example.com', 'claude-1');
    writeCodexSystemAuth('codex@example.com');

    const result = await ensureDefaultAccounts();

    expect(result).toEqual({ claude: 'registered', codex: 'registered' });
    expect(getActiveSavedAccount('claude-code')).toEqual(expect.objectContaining({
      id: 'claude-1',
      label: 'Default',
      email: 'claude@example.com',
    }));
    expect(getActiveCodexAccount()).toEqual(expect.objectContaining({
      label: 'Default',
      email: 'codex@example.com',
    }));
  });

  it('is idempotent when called repeatedly', async () => {
    writeClaudeSystemAccount('claude@example.com', 'claude-1');
    writeCodexSystemAuth('codex@example.com');

    const first = await ensureDefaultAccounts();
    const activeClaudeId = getActiveSavedAccount('claude-code')?.id;
    const activeCodexId = getActiveCodexAccount()?.id;
    const profileDirs = countCodexProfileDirs();
    const second = await ensureDefaultAccounts();

    expect(first).toEqual({ claude: 'registered', codex: 'registered' });
    expect(second).toEqual({ claude: 'skipped', codex: 'skipped' });
    expect(listAccounts()).toHaveLength(1);
    expect(listCodexAccounts()).toHaveLength(1);
    expect(getActiveSavedAccount('claude-code')?.id).toBe(activeClaudeId);
    expect(getActiveCodexAccount()?.id).toBe(activeCodexId);
    expect(countCodexProfileDirs()).toBe(profileDirs);
  });

  it('registers only Claude when only Claude credentials exist', async () => {
    writeClaudeSystemAccount('claude@example.com', 'claude-1');

    const result = await ensureDefaultAccounts();

    expect(result).toEqual({ claude: 'registered', codex: 'skipped' });
    expect(listAccounts()).toHaveLength(1);
    expect(listCodexAccounts()).toHaveLength(0);
  });

  it('registers only Codex when only Codex auth exists', async () => {
    writeCodexSystemAuth('codex@example.com');

    const result = await ensureDefaultAccounts();

    expect(result).toEqual({ claude: 'skipped', codex: 'registered' });
    expect(listAccounts()).toHaveLength(0);
    expect(listCodexAccounts()).toHaveLength(1);
  });

  it('does not overwrite existing active provider accounts', async () => {
    const existing: SavedAccountRegistry = {
      version: 2,
      activeByProvider: {
        'claude-code': 'claude-existing',
        codex: 'codex-existing',
      },
      accounts: [
        {
          id: 'claude-existing',
          providerId: 'claude-code',
          providerAccountId: 'claude-existing',
          email: 'existing-claude@example.com',
          label: 'Existing Claude',
          addedAt: '2026-04-01T00:00:00Z',
        },
        {
          id: 'codex-existing',
          providerId: 'codex',
          email: 'existing-codex@example.com',
          label: 'Existing Codex',
          addedAt: '2026-04-01T00:00:00Z',
        },
      ],
    };
    writeSavedAccountRegistry(existing);
    writeClaudeSystemAccount('new-claude@example.com', 'claude-new');
    writeCodexSystemAuth('new-codex@example.com');

    const result = await ensureDefaultAccounts();

    expect(result).toEqual({ claude: 'skipped', codex: 'skipped' });
    expect(getActiveSavedAccount('claude-code')?.id).toBe('claude-existing');
    expect(getActiveCodexAccount()?.id).toBe('codex-existing');
  });

  it('logs and swallows registration failures', async () => {
    const existing: SavedAccountRegistry = {
      version: 2,
      activeByProvider: {
        'claude-code': null,
        codex: null,
      },
      accounts: [
        {
          id: 'codex-inactive-default',
          providerId: 'codex',
          label: 'Default',
          addedAt: '2026-04-01T00:00:00Z',
        },
      ],
    };
    writeSavedAccountRegistry(existing);
    writeCodexSystemAuth('codex@example.com');
    const logger = vi.fn();

    const result = await ensureDefaultAccounts({ logger });

    expect(result).toEqual({ claude: 'skipped', codex: 'error' });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Codex'), expect.anything());
  });
});
