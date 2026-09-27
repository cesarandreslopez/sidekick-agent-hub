import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

// The real credentialIO runs in file mode (platform forced to linux below), so
// these tests exercise the real write verification and never reach `security`.

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

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

import {
  _resetSyncFingerprints,
  cleanupAbandonedLogins,
  syncLiveAccountStateSync,
} from './accountSync';
import { _onRawAccountsChanged } from './accountChangeSignal';
import {
  getActiveSavedAccount,
  listSavedAccountProfiles,
  writeSavedAccountRegistry,
} from './accountRegistry';
import { getClaudeProfileHome } from './claudeProfiles';
import { getCodexProfileHome, getCodexProfilesDir } from './codexPaths';
import { readHealthSidecar } from './accountHealth';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import { claudeRefreshFingerprint } from './claudeCredentials';
import { syncReportSchema } from './schemas/accountManager';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-16T12:00:00Z');

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function writeLiveClaude(uuid: string, email: string, token: string, expiresAt: number): void {
  const home = path.join(tmpDir, '.claude');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid }, other: 1 }),
  );
  fs.writeFileSync(
    path.join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt },
    }),
  );
}

function codexAuth(email: string, workspaceId: string, lastRefresh?: string): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: makeJwt({
        email,
        'https://api.openai.com/auth': { chatgpt_account_id: workspaceId },
      }),
      access_token: `a-${workspaceId}-${lastRefresh ?? ''}`,
      refresh_token: 'r',
    },
    ...(lastRefresh ? { last_refresh: lastRefresh } : {}),
  });
}

function writeLiveCodex(raw: string): void {
  const home = path.join(tmpDir, '.codex');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), raw);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5"\n');
}

function writeProfileCodex(id: string, raw: string): void {
  const home = getCodexProfileHome(id);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), raw);
}

function readBackupClaudeCreds(uuid: string): { claudeAiOauth: { accessToken: string } } | null {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, 'accounts', 'credentials', `${uuid}.credentials.json`),
        'utf8',
      ),
    );
  } catch {
    return null;
  }
}

function readLiveClaudeCreds(): { claudeAiOauth: { accessToken: string } } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeProfileClaude(uuid: string, email: string, oauth: Record<string, unknown>): void {
  const home = getClaudeProfileHome(uuid);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } }),
  );
}

function registerClaude(ids: string[], active: string | null): void {
  writeSavedAccountRegistry({
    version: 2,
    activeByProvider: { 'claude-code': active, codex: null },
    accounts: ids.map((id) => ({
      id,
      providerId: 'claude-code' as const,
      providerAccountId: id,
      email: `${id}@example.com`,
      addedAt: '2026-01-01T00:00:00Z',
    })),
  });
}

function readProfileClaudeCreds(uuid: string): { claudeAiOauth: { accessToken: string } } | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(getClaudeProfileHome(uuid), '.credentials.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}

const originalPlatform = process.platform;

describe('accountSync', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-sync-'));
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    _resetSyncFingerprints();
    lockEvents.length = 0;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers an unknown live Claude login with label = email, backs it up, and records health', () => {
    writeLiveClaude('uuid-live', 'live@example.com', 'tok-live', NOW + HOUR);

    const report = syncLiveAccountStateSync({ reason: 'startup', now: NOW });

    expect(syncReportSchema.parse(report)).toEqual(report);
    expect(report.claude).toMatchObject({
      registered: { id: 'uuid-live', email: 'live@example.com' },
      folded: 'uuid-live',
      repointed: 'uuid-live',
      warnings: [],
    });
    expect(report.codex.skipped).toBe('logged-out');
    expect(getActiveSavedAccount('claude-code')).toEqual(
      expect.objectContaining({
        id: 'uuid-live',
        label: 'live@example.com',
        metadata: expect.objectContaining({ origin: 'live-sync' }),
      }),
    );
    // I1: the live account keeps no CLI-usable copy in its profile home; the
    // private backup (never read by Claude Code) mirrors it instead.
    expect(readProfileClaudeCreds('uuid-live')).toBeNull();
    expect(readBackupClaudeCreds('uuid-live')?.claudeAiOauth.accessToken).toBe('tok-live');
    expect(readHealthSidecar('claude-code', 'uuid-live')).toMatchObject({
      accessExpiresAt: NOW + HOUR,
      refreshFp: expect.stringMatching(/^[0-9a-f]{16}$/),
      source: 'live-sync',
    });
    // The identity file in the profile keeps only oauthAccount.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(getClaudeProfileHome('uuid-live'), '.claude.json'), 'utf8'),
      ),
    ).toEqual({ oauthAccount: { emailAddress: 'live@example.com', accountUuid: 'uuid-live' } });
  });

  it('repairs a dying live login from a strictly newer profile copy, then removes the copy', () => {
    registerClaude(['uuid-a'], 'uuid-a');
    // The profile copy is newer than live (an older build mirrored the chain
    // there and a CLI refreshed it): live is the dead link.
    writeLiveClaude('uuid-a', 'a@example.com', 'tok-old', NOW + HOUR);
    writeProfileClaude('uuid-a', 'uuid-a@example.com', {
      accessToken: 'tok-newer',
      refreshToken: 'r-tok-newer',
      expiresAt: NOW + 5 * HOUR,
    });

    let report = syncLiveAccountStateSync({ reason: 'manual', now: NOW });
    expect(report.claude).toMatchObject({ repaired: 'uuid-a', demoted: 'uuid-a' });
    expect(readLiveClaudeCreds()?.claudeAiOauth.accessToken).toBe('tok-newer');
    expect(readProfileClaudeCreds('uuid-a')).toBeNull();
    expect(readBackupClaudeCreds('uuid-a')?.claudeAiOauth.accessToken).toBe('tok-newer');

    // Live rotates past the backup: fold into the backup, still no profile copy.
    writeLiveClaude('uuid-a', 'a@example.com', 'tok-rotated', NOW + 9 * HOUR);
    report = syncLiveAccountStateSync({ reason: 'manual', now: NOW });
    expect(report.claude.folded).toBe('uuid-a');
    expect(readBackupClaudeCreds('uuid-a')?.claudeAiOauth.accessToken).toBe('tok-rotated');
    expect(readProfileClaudeCreds('uuid-a')).toBeNull();
  });

  it('demotes an older or same-link copy of the live login without touching live', () => {
    registerClaude(['uuid-a'], 'uuid-a');
    writeLiveClaude('uuid-a', 'a@example.com', 'tok-live', NOW + 5 * HOUR);
    writeProfileClaude('uuid-a', 'uuid-a@example.com', {
      accessToken: 'tok-stale',
      refreshToken: 'r-tok-stale',
      expiresAt: NOW + HOUR,
    });
    const liveBefore = fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8');

    const report = syncLiveAccountStateSync({ reason: 'manual', now: NOW });

    expect(report.claude.demoted).toBe('uuid-a');
    expect(report.claude.repaired).toBeUndefined();
    expect(readProfileClaudeCreds('uuid-a')).toBeNull();
    expect(fs.readFileSync(path.join(tmpDir, '.claude', '.credentials.json'), 'utf8')).toBe(
      liveBefore,
    );
    expect(readBackupClaudeCreds('uuid-a')?.claudeAiOauth.accessToken).toBe('tok-live');
  });

  it("refuses to fold when the live credential is another profile's chain", () => {
    registerClaude(['uuid-a', 'uuid-b'], 'uuid-a');
    // `.claude.json` says A, but the credential is B's (a switch died mid-way).
    writeLiveClaude('uuid-a', 'a@example.com', 'tok-b', NOW + HOUR);
    const bDir = path.dirname(getClaudeProfileHome('uuid-b'));
    fs.mkdirSync(bDir, { recursive: true });
    fs.writeFileSync(
      path.join(bDir, 'health.json'),
      JSON.stringify({
        version: 1,
        capturedAt: NOW,
        refreshFp: claudeRefreshFingerprint({ accessToken: 'x', refreshToken: 'r-tok-b' }),
        source: 'switch',
      }),
    );

    const report = syncLiveAccountStateSync({ reason: 'manual', now: NOW });

    expect(report.claude.folded).toBeUndefined();
    expect(report.claude.warnings.join(' ')).toMatch(/belongs to uuid-b@example.com/);
    expect(readBackupClaudeCreds('uuid-a')).toBeNull();
  });

  describe('interrupted switch journal', () => {
    const journalPath = (): string =>
      path.join(tmpDir, 'accounts', 'claude', 'switch-journal.json');
    const fp = (token: string): string | null =>
      claudeRefreshFingerprint({ accessToken: token, refreshToken: `r-${token}` });

    function seedJournal(): void {
      registerClaude(['uuid-a', 'uuid-b'], 'uuid-a');
      // A was captured into its backup before the install.
      fs.mkdirSync(path.join(tmpDir, 'accounts', 'credentials'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'accounts', 'credentials', 'uuid-a.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'tok-a', refreshToken: 'r-tok-a', expiresAt: NOW + HOUR },
        }),
      );
      writeProfileClaude('uuid-b', 'uuid-b@example.com', {
        accessToken: 'tok-b',
        refreshToken: 'r-tok-b',
        expiresAt: NOW + 2 * HOUR,
      });
      fs.writeFileSync(
        journalPath(),
        JSON.stringify({
          from: 'uuid-a',
          to: 'uuid-b',
          fromFp: fp('tok-a'),
          toFp: fp('tok-b'),
          at: '',
        }),
      );
    }

    it('finishes a switch that crashed after installing the target', () => {
      seedJournal();
      // Crash after the credential write, before the identity merge.
      writeLiveClaude('uuid-a', 'a@example.com', 'tok-b', NOW + 2 * HOUR);

      const report = syncLiveAccountStateSync({ reason: 'startup', now: NOW });

      expect(report.claude.journal).toBe('finished');
      expect(fs.existsSync(journalPath())).toBe(false);
      expect(getActiveSavedAccount('claude-code')?.id).toBe('uuid-b');
      // A (now inactive) got its single CLI copy back, login only; B's copy is gone.
      expect(readProfileClaudeCreds('uuid-a')).toEqual({
        claudeAiOauth: { accessToken: 'tok-a', refreshToken: 'r-tok-a', expiresAt: NOW + HOUR },
      });
      expect(readProfileClaudeCreds('uuid-b')).toBeNull();
    });

    it('rolls back a switch that crashed before installing', () => {
      seedJournal();
      writeLiveClaude('uuid-a', 'a@example.com', 'tok-a', NOW + HOUR);

      const report = syncLiveAccountStateSync({ reason: 'startup', now: NOW });

      expect(report.claude.journal).toBe('rolled-back');
      expect(fs.existsSync(journalPath())).toBe(false);
      expect(readProfileClaudeCreds('uuid-b')?.claudeAiOauth.accessToken).toBe('tok-b');
    });

    it('leaves the stores alone when live matches neither side', () => {
      seedJournal();
      writeLiveClaude('uuid-a', 'a@example.com', 'tok-elsewhere', NOW + HOUR);

      const report = syncLiveAccountStateSync({ reason: 'startup', now: NOW });

      expect(report.claude.journal).toBe('cleared');
      expect(readProfileClaudeCreds('uuid-b')?.claudeAiOauth.accessToken).toBe('tok-b');
    });
  });

  it('re-points the active pointer silently and takes the swap lock before the registry lock', () => {
    writeSavedAccountRegistry({
      version: 2,
      activeByProvider: { 'claude-code': 'uuid-other', codex: null },
      accounts: [
        {
          id: 'uuid-other',
          providerId: 'claude-code',
          providerAccountId: 'uuid-other',
          email: 'o@example.com',
          addedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'uuid-a',
          providerId: 'claude-code',
          providerAccountId: 'uuid-a',
          email: 'a@example.com',
          addedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    writeLiveClaude('uuid-a', 'a@example.com', 'tok', NOW + HOUR);
    const signals: string[] = [];
    const stop = _onRawAccountsChanged((reason) => signals.push(reason));
    lockEvents.length = 0;

    const report = syncLiveAccountStateSync({ reason: 'manual', now: NOW });
    stop();

    expect(report.claude.repointed).toBe('uuid-a');
    expect(getActiveSavedAccount('claude-code')?.id).toBe('uuid-a');
    expect(signals).toEqual([]);
    expect(lockEvents.indexOf('enter:auth-swap.lock')).toBeLessThan(
      lockEvents.indexOf('enter:accounts.json.lock'),
    );
  });

  it('registers an unknown live Codex login and folds rotated tokens into the matching profile', () => {
    writeLiveCodex(codexAuth('c@example.com', 'ws-c', '2026-09-01T00:00:00Z'));

    let report = syncLiveAccountStateSync({ reason: 'startup', now: NOW });
    const registered = report.codex.registered!;
    expect(registered.email).toBe('c@example.com');
    const profile = getActiveSavedAccount('codex');
    expect(profile).toEqual(
      expect.objectContaining({
        id: registered.id,
        label: 'c@example.com',
        metadata: expect.objectContaining({ workspaceId: 'ws-c', origin: 'live-sync' }),
      }),
    );
    expect(
      fs.readFileSync(path.join(getCodexProfileHome(registered.id), 'config.toml'), 'utf8'),
    ).toContain('cli_auth_credentials_store = "file"');

    // Codex rotates the live file: the profile backup follows.
    const rotated = codexAuth('c@example.com', 'ws-c', '2026-09-12T00:00:00Z');
    writeLiveCodex(rotated);
    report = syncLiveAccountStateSync({ reason: 'manual', now: NOW });
    expect(report.codex.folded).toBe(registered.id);
    expect(
      fs.readFileSync(path.join(getCodexProfileHome(registered.id), 'auth.json'), 'utf8'),
    ).toBe(rotated);

    // A saved copy that says it is newer than the live file is kept.
    const newer = codexAuth('c@example.com', 'ws-c', '2026-09-15T00:00:00Z');
    writeProfileCodex(registered.id, newer);
    report = syncLiveAccountStateSync({ reason: 'manual', now: NOW });
    expect(report.codex.folded).toBeUndefined();
    expect(
      fs.readFileSync(path.join(getCodexProfileHome(registered.id), 'auth.json'), 'utf8'),
    ).toBe(newer);
  });

  it('merges duplicate Codex profiles: oldest keeps id and label, freshest auth wins, quota is re-keyed, losers are stashed', () => {
    writeSavedAccountRegistry({
      version: 2,
      activeByProvider: { 'claude-code': null, codex: 'dup-new' },
      accounts: [
        {
          id: 'dup-new',
          providerId: 'codex',
          label: 'Codex CLI',
          email: 'c@example.com',
          addedAt: '2026-06-21T00:00:00Z',
          metadata: { email: 'c@example.com', workspaceId: 'ws-c' },
        },
        {
          id: 'dup-old',
          providerId: 'codex',
          label: 'cal',
          email: 'c@example.com',
          addedAt: '2026-04-13T00:00:00Z',
          metadata: { email: 'c@example.com', workspaceId: 'ws-c' },
        },
        {
          id: 'other',
          providerId: 'codex',
          label: 'Other',
          email: 'o@example.com',
          addedAt: '2026-05-01T00:00:00Z',
          metadata: { email: 'o@example.com', workspaceId: 'ws-o' },
        },
      ],
    });
    writeProfileCodex('dup-old', codexAuth('c@example.com', 'ws-c', '2026-06-01T00:00:00Z'));
    const fresher = codexAuth('c@example.com', 'ws-c', '2026-06-21T00:00:00Z');
    writeProfileCodex('dup-new', fresher);
    writeProfileCodex('other', codexAuth('o@example.com', 'ws-o'));
    writeQuotaSnapshot('codex', 'dup-new', {
      providerId: 'codex',
      fiveHour: { utilization: 42, resetsAt: null },
      sevenDay: { utilization: 7, resetsAt: null },
      source: 'api',
      capturedAt: new Date(NOW).toISOString(),
    } as never);
    const live = codexAuth('c@example.com', 'ws-c', '2026-09-12T00:00:00Z');
    writeLiveCodex(live);

    const report = syncLiveAccountStateSync({ reason: 'startup', now: NOW });

    expect(report.codex.merged).toEqual(['dup-new']);
    const ids = listSavedAccountProfiles('codex')
      .map((p) => p.id)
      .sort();
    expect(ids).toEqual(['dup-old', 'other']);
    expect(getActiveSavedAccount('codex')).toEqual(
      expect.objectContaining({ id: 'dup-old', label: 'cal' }),
    );
    // The live file is the freshest of all and lands in the keeper.
    expect(fs.readFileSync(path.join(getCodexProfileHome('dup-old'), 'auth.json'), 'utf8')).toBe(
      live,
    );
    expect(readQuotaSnapshot('codex', 'dup-old')?.fiveHour.utilization).toBe(42);
    const stash = fs.readdirSync(path.join(tmpDir, 'accounts', 'codex', 'stash'));
    expect(stash).toHaveLength(1);
    expect(stash[0]).toMatch(/^dup-dup-new-/);
    expect(fs.existsSync(getCodexProfileHome('dup-new'))).toBe(false);
  });

  it('skips with a keyring warning when codex keeps its login in the OS keyring', () => {
    const home = path.join(tmpDir, '.codex');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');

    const report = syncLiveAccountStateSync({ reason: 'manual', now: NOW });

    expect(report.codex.skipped).toBe('keyring');
    expect(report.codex.warnings[0]).toMatch(/cli_auth_credentials_store = "file"/);
  });

  it('short-circuits watch-driven syncs while the live files are unchanged', () => {
    writeLiveClaude('uuid-live', 'live@example.com', 'tok', NOW + HOUR);

    expect(syncLiveAccountStateSync({ reason: 'watch', now: NOW }).claude.registered).toBeDefined();
    expect(syncLiveAccountStateSync({ reason: 'watch', now: NOW + 1000 }).claude.skipped).toBe(
      'unchanged',
    );
    expect(
      syncLiveAccountStateSync({ reason: 'manual', now: NOW + 1000 }).claude.skipped,
    ).toBeUndefined();

    // A real change (new login) is picked up again.
    writeLiveClaude('uuid-two', 'two@example.com', 'tok2', NOW + 2 * HOUR);
    const report = syncLiveAccountStateSync({ reason: 'watch', now: NOW + 2000 });
    expect(report.claude.registered?.id).toBe('uuid-two');
    expect(listSavedAccountProfiles('claude-code')).toHaveLength(2);
  });

  it('removes abandoned isolated logins older than the threshold only', () => {
    const oldClaude = path.join(tmpDir, 'accounts', 'claude', 'profiles', 'login-old');
    fs.mkdirSync(path.join(oldClaude, 'home'), { recursive: true });
    fs.writeFileSync(
      path.join(oldClaude, 'profile.json'),
      JSON.stringify({ label: 'x', addedAt: new Date(NOW - 2 * DAY).toISOString() }),
    );
    const freshClaude = path.join(tmpDir, 'accounts', 'claude', 'profiles', 'login-fresh');
    fs.mkdirSync(path.join(freshClaude, 'home'), { recursive: true });
    fs.writeFileSync(
      path.join(freshClaude, 'profile.json'),
      JSON.stringify({ label: 'y', addedAt: new Date(NOW - HOUR).toISOString() }),
    );
    const oldCodex = path.join(getCodexProfilesDir(), 'codex-old');
    fs.mkdirSync(path.join(oldCodex, 'codex-home'), { recursive: true });
    fs.writeFileSync(
      path.join(oldCodex, 'profile.json'),
      JSON.stringify({ label: 'z', addedAt: new Date(NOW - 2 * DAY).toISOString() }),
    );
    const authedCodex = path.join(getCodexProfilesDir(), 'codex-authed');
    fs.mkdirSync(path.join(authedCodex, 'codex-home'), { recursive: true });
    fs.writeFileSync(
      path.join(authedCodex, 'profile.json'),
      JSON.stringify({ label: 'w', addedAt: new Date(NOW - 2 * DAY).toISOString() }),
    );
    fs.writeFileSync(path.join(authedCodex, 'codex-home', 'auth.json'), '{}');

    const removed = cleanupAbandonedLogins(6 * HOUR, NOW);

    expect(removed).toEqual({ claude: ['login-old'], codex: ['codex-old'] });
    expect(fs.existsSync(oldClaude)).toBe(false);
    expect(fs.existsSync(freshClaude)).toBe(true);
    expect(fs.existsSync(oldCodex)).toBe(false);
    expect(fs.existsSync(authedCodex)).toBe(true);
  });

  it('removes an authenticated login that was never finalized after a day (I4)', () => {
    const stale = path.join(tmpDir, 'accounts', 'claude', 'profiles', 'login-authed-stale');
    const recent = path.join(tmpDir, 'accounts', 'claude', 'profiles', 'login-authed-recent');
    for (const [dir, age] of [
      [stale, 2 * DAY],
      [recent, 8 * HOUR],
    ] as const) {
      fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'profile.json'),
        JSON.stringify({ label: 'x', addedAt: new Date(NOW - age).toISOString() }),
      );
      fs.writeFileSync(
        path.join(dir, 'home', '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com', accountUuid: 'uuid-x' } }),
      );
      fs.writeFileSync(path.join(dir, 'home', '.credentials.json'), '{"claudeAiOauth":{}}');
    }

    const removed = cleanupAbandonedLogins(6 * HOUR, NOW);

    expect(removed.claude).toEqual(['login-authed-stale']);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });
});
