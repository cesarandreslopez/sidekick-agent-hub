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
import { getAccountHealth, readHealthSidecar, writeClaudeHealthSidecar } from './accountHealth';
import { switchToAccount } from './accounts';
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
    expect(keepAliveCommand('codex')).toEqual({
      command: 'codex',
      args: ['app-server', '-c', 'cli_auth_credentials_store="file"'],
    });
  });

  describe('never refreshes a copy of the live chain (I3)', () => {
    const stale = {
      accessToken: 'a',
      refreshToken: 'r-stale',
      expiresAt: NOW - HOUR,
      refreshTokenExpiresAt: NOW + 10 * DAY,
    };
    const neverRun: KeepAliveRunner = async () => {
      throw new Error('keep-alive must not run the CLI here');
    };
    const reasonFor = (result: Awaited<ReturnType<typeof refreshInactiveAccounts>>): string =>
      result.skipped.find((s) => s.id === 'stale')?.reason ?? '';

    it('skips a profile whose refresh token equals the live one', async () => {
      seedClaude('stale', stale);
      fs.writeFileSync(
        path.join(tmpDir, '.claude', '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { ...stale, accessToken: 'live-access' } }),
      );
      const result = await refreshInactiveAccounts({ runner: neverRun, now: NOW });
      expect(reasonFor(result)).toBe('same refresh token as the live login');
    });

    it('skips a copy taken from the live store until a switch hands it back', async () => {
      seedClaude('stale', stale);
      writeClaudeHealthSidecar('stale', { claudeAiOauth: stale }, 'live-sync', NOW);
      const result = await refreshInactiveAccounts({ runner: neverRun, now: NOW });
      expect(reasonFor(result)).toMatch(/copied from the live login/);
    });

    it('never restores a backup into the profile home to refresh it', async () => {
      seedClaude('stale', stale);
      fs.rmSync(path.join(getClaudeProfileHome('stale'), '.credentials.json'));
      fs.mkdirSync(path.join(tmpDir, 'accounts', 'credentials'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'accounts', 'credentials', 'stale.credentials.json'),
        JSON.stringify({ claudeAiOauth: stale }),
      );
      const result = await refreshInactiveAccounts({ runner: neverRun, now: NOW });
      expect(reasonFor(result)).toMatch(/no profile copy/);
      expect(fs.existsSync(path.join(getClaudeProfileHome('stale'), '.credentials.json'))).toBe(
        false,
      );
    });

    it('skips a stale profile copy when the backup is newer', async () => {
      seedClaude('stale', stale);
      fs.mkdirSync(path.join(tmpDir, 'accounts', 'credentials'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'accounts', 'credentials', 'stale.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { ...stale, refreshToken: 'r-newer', expiresAt: NOW + HOUR },
        }),
      );
      const result = await refreshInactiveAccounts({ runner: neverRun, now: NOW });
      expect(reasonFor(result)).toMatch(/backup is newer/);
    });

    it('reports the reason in dry runs too', async () => {
      seedClaude('stale', stale);
      writeClaudeHealthSidecar('stale', { claudeAiOauth: stale }, 'live-sync', NOW);
      const dry = await refreshInactiveAccounts({ runner: neverRun, now: NOW, dryRun: true });
      expect(reasonFor(dry)).toMatch(/copied from the live login/);
    });

    it('holds a lease that makes a concurrent switch to that account refuse', async () => {
      seedClaude('stale', stale);
      let during: ReturnType<typeof switchToAccount> | undefined;
      const runner: KeepAliveRunner = async () => {
        during = switchToAccount('stale');
        return { status: 0, stdout: '' };
      };

      await refreshInactiveAccounts({ runner, now: NOW });

      expect(during).toMatchObject({ success: false });
      expect(during?.error).toMatch(/Keep-alive is refreshing/);
      // Released afterwards.
      expect(
        fs.existsSync(path.join(path.dirname(getClaudeProfileHome('stale')), 'keepalive.lease')),
      ).toBe(false);
    });

    it('records a refresh in the backup with keepalive provenance', async () => {
      seedClaude('stale', stale);
      const runner: KeepAliveRunner = async (_command, _args, env) => {
        fs.writeFileSync(
          path.join(env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
          JSON.stringify({
            claudeAiOauth: { ...stale, refreshToken: 'r-rotated', expiresAt: NOW + 8 * HOUR },
          }),
        );
        return { status: 0, stdout: '' };
      };

      const result = await refreshInactiveAccounts({ runner, now: NOW });

      expect(result.refreshed).toEqual([{ id: 'stale', providerId: 'claude-code' }]);
      expect(readHealthSidecar('claude-code', 'stale')?.source).toBe('keepalive');
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(tmpDir, 'accounts', 'credentials', 'stale.credentials.json'),
            'utf8',
          ),
        ).claudeAiOauth.refreshToken,
      ).toBe('r-rotated');
    });

    it('read-only health probes keep the provenance keep-alive relies on', () => {
      seedClaude('stale', stale);
      writeClaudeHealthSidecar('stale', { claudeAiOauth: stale }, 'live-sync', NOW);
      getAccountHealth('claude-code', 'stale', { probe: 'store', now: NOW });
      expect(readHealthSidecar('claude-code', 'stale')?.source).toBe('live-sync');
    });
  });
});
