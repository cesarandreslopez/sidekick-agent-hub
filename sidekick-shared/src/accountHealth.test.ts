import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

import {
  getAccountHealth,
  getHealthSidecarPath,
  listAccountsWithHealth,
  readHealthSidecar,
  writeClaudeHealthSidecar,
  writeCodexHealthSidecar,
} from './accountHealth';
import { writeSavedAccountRegistry } from './accountRegistry';
import { getClaudeProfileHome } from './claudeProfiles';
import { getCodexProfileHome } from './codexPaths';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-16T12:00:00Z');
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function registry(): void {
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
        metadata: { email: 'a@example.com', origin: 'live-sync' },
      },
      {
        id: 'uuid-b',
        providerId: 'claude-code',
        providerAccountId: 'uuid-b',
        email: 'b@example.com',
        addedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'codex-a',
        providerId: 'codex',
        email: 'c@example.com',
        label: 'C',
        addedAt: '2026-01-01T00:00:00Z',
        metadata: { email: 'c@example.com', workspaceId: 'ws-c', planType: 'pro' },
      },
    ],
  });
}

function writeLiveClaude(uuid: string, email: string): void {
  const home = path.join(tmpDir, '.claude');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } }),
  );
}

function writeCodexAuth(
  home: string,
  workspaceId: string,
  exp: number,
  lastRefresh?: string,
): string {
  fs.mkdirSync(home, { recursive: true });
  const raw = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: makeJwt({
        email: 'c@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: workspaceId },
      }),
      access_token: makeJwt({ exp }),
      refresh_token: 'r',
    },
    ...(lastRefresh ? { last_refresh: lastRefresh } : {}),
  });
  fs.writeFileSync(path.join(home, 'auth.json'), raw);
  return raw;
}

describe('accountHealth', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-health-'));
    setPlatform('linux');
    mockExecFileSync.mockReset();
    registry();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Claude state matrix', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        'fresh with recorded refresh expiry',
        {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW + HOUR,
          refreshTokenExpiresAt: NOW + 20 * DAY,
        },
        'fresh',
      ],
      [
        'expiring when the access token lapsed but refresh is valid',
        {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW - HOUR,
          refreshTokenExpiresAt: NOW + 20 * DAY,
        },
        'expiring',
      ],
      [
        'expiring when the refresh token expires within 3 days',
        {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW + HOUR,
          refreshTokenExpiresAt: NOW + 2 * DAY,
        },
        'expiring',
      ],
      [
        'expired when the refresh token expiry passed',
        {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW - DAY,
          refreshTokenExpiresAt: NOW - HOUR,
        },
        'expired',
      ],
      [
        'expired (estimated) for a legacy snapshot older than the refresh lifetime',
        { accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 60 * DAY },
        'expired',
      ],
      [
        'expiring (estimated) for a legacy snapshot a few days old',
        { accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 2 * DAY },
        'expiring',
      ],
      [
        'expired when there is no refresh token and access lapsed',
        { accessToken: 'a', expiresAt: NOW - HOUR },
        'expired',
      ],
      [
        'fresh when there is no refresh token but access is valid',
        { accessToken: 'a', expiresAt: NOW + HOUR },
        'fresh',
      ],
      ['unknown when the credential carries no expiry at all', { accessToken: 'a' }, 'unknown'],
    ];

    for (const [name, oauth, expected] of cases) {
      it(name, () => {
        const sidecar = writeClaudeHealthSidecar('uuid-b', { claudeAiOauth: oauth }, 'login', NOW);
        expect(sidecar?.source).toBe('login');
        expect(readHealthSidecar('claude-code', 'uuid-b')).toEqual(sidecar);
        const health = getAccountHealth('claude-code', 'uuid-b', { now: NOW });
        expect(health.state).toBe(expected);
        expect(health.isLive).toBe(false);
        if (
          expected === 'expired' &&
          oauth.refreshTokenExpiresAt === undefined &&
          oauth.refreshToken
        ) {
          expect(health.refreshExpiryEstimated).toBe(true);
        }
      });
    }
  });

  it('reports missing when nothing is stored, unknown when credentials exist without a sidecar, and never spawns in cache mode', () => {
    expect(getAccountHealth('claude-code', 'uuid-b', { now: NOW }).state).toBe('missing');

    fs.mkdirSync(getClaudeProfileHome('uuid-b'), { recursive: true });
    fs.writeFileSync(
      path.join(getClaudeProfileHome('uuid-b'), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: NOW + HOUR } }),
    );
    expect(getAccountHealth('claude-code', 'uuid-b', { now: NOW }).state).toBe('unknown');

    // A store probe reads the credential and records the sidecar.
    expect(getAccountHealth('claude-code', 'uuid-b', { now: NOW, probe: 'store' }).state).toBe(
      'fresh',
    );
    expect(fs.existsSync(getHealthSidecarPath('claude-code', 'uuid-b'))).toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('flags the live Claude account', () => {
    writeLiveClaude('uuid-a', 'a@example.com');
    writeClaudeHealthSidecar(
      'uuid-a',
      { claudeAiOauth: { accessToken: 'a', expiresAt: NOW + HOUR } },
      'live-sync',
      NOW,
    );

    expect(getAccountHealth('claude-code', 'uuid-a', { now: NOW })).toMatchObject({
      state: 'fresh',
      isLive: true,
    });
  });

  it('derives Codex health from the auth file without a sidecar and flags the live account', () => {
    writeCodexAuth(getCodexProfileHome('codex-a'), 'ws-c', (NOW + HOUR) / 1000);
    expect(getAccountHealth('codex', 'codex-a', { now: NOW }).state).toBe('fresh');

    writeCodexAuth(
      getCodexProfileHome('codex-a'),
      'ws-c',
      (NOW - HOUR) / 1000,
      new Date(NOW - 20 * DAY).toISOString(),
    );
    const stale = getAccountHealth('codex', 'codex-a', { now: NOW, probe: 'store' });
    expect(stale.state).toBe('expiring');
    expect(stale.reason).toMatch(/20 days/);

    writeCodexAuth(path.join(tmpDir, '.codex'), 'ws-c', (NOW + HOUR) / 1000);
    expect(getAccountHealth('codex', 'codex-a', { now: NOW }).isLive).toBe(true);

    const apiKey = writeCodexHealthSidecar(
      'codex-a',
      JSON.stringify({ OPENAI_API_KEY: 'sk' }),
      'login',
      NOW,
    );
    expect(apiKey?.authMode).toBe('api-key');
    expect(getAccountHealth('codex', 'codex-a', { now: NOW }).state).toBe('unknown');
  });

  it('lists accounts with health, active flag, and learned/registered source', () => {
    writeLiveClaude('uuid-a', 'a@example.com');
    writeClaudeHealthSidecar(
      'uuid-a',
      {
        claudeAiOauth: {
          accessToken: 'a',
          expiresAt: NOW + HOUR,
          refreshTokenExpiresAt: NOW + 10 * DAY,
        },
      },
      'live-sync',
      NOW,
    );

    const views = listAccountsWithHealth(undefined, { now: NOW });

    expect(views.map((v) => [v.id, v.isActive, v.source, v.health.state])).toEqual([
      ['uuid-a', true, 'learned', 'fresh'],
      ['uuid-b', false, 'registered', 'missing'],
      ['codex-a', true, 'registered', 'missing'],
    ]);
    expect(views[2].planType).toBe('pro');
    expect(listAccountsWithHealth('codex', { now: NOW })).toHaveLength(1);
  });
});
