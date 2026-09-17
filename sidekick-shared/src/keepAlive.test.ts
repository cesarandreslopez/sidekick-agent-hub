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

import { keepAliveCommand, refreshInactiveAccounts, type KeepAliveRunner } from './keepAlive';
import { writeClaudeHealthSidecar } from './accountHealth';
import { writeSavedAccountRegistry } from './accountRegistry';
import { getClaudeProfileHome } from './claudeProfiles';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();

function seedClaude(uuid: string, oauth: Record<string, unknown>): void {
  const home = getClaudeProfileHome(uuid);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: `${uuid}@example.com`, accountUuid: uuid } }),
  );
  writeClaudeHealthSidecar(uuid, { claudeAiOauth: oauth }, 'login', NOW);
}

describe('refreshInactiveAccounts', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-keep-alive-'));
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    writeSavedAccountRegistry({
      version: 2,
      activeByProvider: { 'claude-code': 'live', codex: null },
      accounts: [
        {
          id: 'live',
          providerId: 'claude-code',
          providerAccountId: 'live',
          email: 'live@example.com',
          addedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'stale',
          providerId: 'claude-code',
          providerAccountId: 'stale',
          email: 'stale@example.com',
          addedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'fresh',
          providerId: 'claude-code',
          providerAccountId: 'fresh',
          email: 'fresh@example.com',
          addedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'dead',
          providerId: 'claude-code',
          providerAccountId: 'dead',
          email: 'dead@example.com',
          addedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'live@example.com', accountUuid: 'live' } }),
    );
    seedClaude('live', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: NOW - HOUR,
      refreshTokenExpiresAt: NOW + 10 * DAY,
    });
    seedClaude('stale', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: NOW - HOUR,
      refreshTokenExpiresAt: NOW + 10 * DAY,
    });
    seedClaude('fresh', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: NOW + HOUR,
      refreshTokenExpiresAt: NOW + 10 * DAY,
    });
    seedClaude('dead', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: NOW - 5 * DAY,
      refreshTokenExpiresAt: NOW - HOUR,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs the official CLI only for inactive expiring accounts and records the refreshed expiry', async () => {
    const calls: Array<{ command: string; args: string[]; home?: string }> = [];
    const runner: KeepAliveRunner = async (command, args, env) => {
      calls.push({ command, args, home: env.CLAUDE_CONFIG_DIR });
      // Simulate the CLI refreshing the token inside the isolated home.
      fs.writeFileSync(
        path.join(env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'b',
            refreshToken: 'r2',
            expiresAt: NOW + 8 * HOUR,
            refreshTokenExpiresAt: NOW + 20 * DAY,
          },
        }),
      );
      expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
      return { status: 0, stdout: '{"loggedIn":true}' };
    };

    const result = await refreshInactiveAccounts({ runner, now: NOW });

    expect(calls).toEqual([
      { command: 'claude', args: ['auth', 'status'], home: getClaudeProfileHome('stale') },
    ]);
    expect(result.refreshed).toEqual([{ id: 'stale', providerId: 'claude-code' }]);
    expect(result.skipped.map((s) => [s.id, s.reason])).toEqual([
      ['live', 'live account; the CLI refreshes it in normal use'],
      ['fresh', 'fresh'],
      ['dead', 'expired; sign in again'],
    ]);
    expect(result.failed).toEqual([]);
  });

  it('reports a failure when the CLI does not refresh, and supports dry runs', async () => {
    const runner: KeepAliveRunner = async () => ({ status: 0, stdout: '' });
    const result = await refreshInactiveAccounts({ runner, now: NOW });
    expect(result.failed).toEqual([
      {
        id: 'stale',
        providerId: 'claude-code',
        error: 'claude ran but the stored credential is still expiring.',
      },
    ]);

    const dry = await refreshInactiveAccounts({ runner, now: NOW, dryRun: true });
    expect(dry.skipped.find((s) => s.id === 'stale')?.reason).toMatch(
      /dry run: would run claude auth status/,
    );
    expect(keepAliveCommand('codex')).toEqual({ command: 'codex', args: ['login', 'status'] });
  });
});
