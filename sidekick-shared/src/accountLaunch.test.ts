import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

import { getAccountLaunchEnv } from './accountLaunch';
import { writeClaudeHealthSidecar } from './accountHealth';
import { writeSavedAccountRegistry } from './accountRegistry';
import { getClaudeProfileHome } from './claudeProfiles';
import { getCodexProfileHome } from './codexPaths';
import { accountLaunchEnvSchema } from './schemas/accountManager';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();

describe('getAccountLaunchEnv', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-launch-'));
    writeSavedAccountRegistry({
      version: 2,
      activeByProvider: { 'claude-code': 'uuid-a', codex: 'codex-a' },
      accounts: [
        {
          id: 'uuid-a',
          providerId: 'claude-code',
          providerAccountId: 'uuid-a',
          email: 'a@example.com',
          label: 'A',
          addedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'codex-a',
          providerId: 'codex',
          email: 'c@example.com',
          label: 'C',
          addedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), '{"theme":"dark"}');
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.codex', 'config.toml'),
      'model = "gpt-5"\ncli_auth_credentials_store = "auto"\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds an isolated Claude env, materialises settings and onboarding once, and never touches oauthAccount', () => {
    const home = getClaudeProfileHome('uuid-a');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com', accountUuid: 'uuid-a' } }),
    );
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}');
    writeClaudeHealthSidecar(
      'uuid-a',
      {
        claudeAiOauth: {
          accessToken: 'a',
          expiresAt: NOW + HOUR,
          refreshTokenExpiresAt: NOW + 10 * DAY,
        },
      },
      'login',
      NOW,
    );

    const launch = getAccountLaunchEnv('claude-code', 'uuid-a');

    expect(accountLaunchEnvSchema.parse(launch)).toEqual(launch);
    expect(launch).toMatchObject({
      command: 'claude',
      home,
      env: { CLAUDE_CONFIG_DIR: home },
      envUnset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'],
      label: 'A',
      email: 'a@example.com',
    });
    expect(launch.error).toBeUndefined();
    expect(launch.health.state).toBe('fresh');
    expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))).toEqual({
      oauthAccount: { emailAddress: 'a@example.com', accountUuid: 'uuid-a' },
      hasCompletedOnboarding: true,
    });
  });

  it('refuses expired or unknown accounts and warns when launching the live account', () => {
    const home = getClaudeProfileHome('uuid-a');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}');
    writeClaudeHealthSidecar(
      'uuid-a',
      {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW - DAY,
          refreshTokenExpiresAt: NOW - HOUR,
        },
      },
      'login',
      NOW,
    );
    expect(getAccountLaunchEnv('claude-code', 'uuid-a').error).toMatch(/expired/);
    expect(getAccountLaunchEnv('claude-code', 'uuid-a', { force: true }).error).toBeUndefined();

    expect(getAccountLaunchEnv('claude-code', 'nope').error).toMatch(/not found/);

    fs.writeFileSync(
      path.join(tmpDir, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com', accountUuid: 'uuid-a' } }),
    );
    writeClaudeHealthSidecar(
      'uuid-a',
      {
        claudeAiOauth: {
          accessToken: 'a',
          expiresAt: NOW + HOUR,
          refreshTokenExpiresAt: NOW + 10 * DAY,
        },
      },
      'login',
      NOW,
    );
    const live = getAccountLaunchEnv('claude-code', 'uuid-a');
    expect(live.error).toBeUndefined();
    expect(live.warnings[0]).toMatch(/also the live login/);
  });

  it('builds an isolated Codex env with a file-mode config', () => {
    const home = getCodexProfileHome('codex-a');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'x.y.z' } }),
    );

    const launch = getAccountLaunchEnv('codex', 'codex-a');

    expect(launch.env).toEqual({ CODEX_HOME: home });
    expect(launch.envUnset).toEqual([]);
    expect(launch.command).toBe('codex');
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(
      'model = "gpt-5"\ncli_auth_credentials_store = "file"\n',
    );
  });
});
