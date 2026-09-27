import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import * as registry from './accountRegistry';
import * as io from './codexCredentialStore';
import { getCodexBackupPath, getCodexProfileHome } from './codexPaths';
import {
  prepareCodexAccount,
  finalizeCodexAccount,
  storeCodexProfileAuth,
  syncCodexLiveState,
  switchToCodexAccount,
  beginCodexKeepAlive,
  finishCodexKeepAlive,
  getCodexKeepAliveBlocker,
} from './codexProfiles';
import { compareCodexAuthFreshness } from './codexAuth';
import { getAccountLaunchEnv } from './accountLaunch';
import { refreshInactiveAccounts } from './keepAlive';
import { inspectCodexCredentialStores, repairCodexCredentialStores } from './codexCredentialDoctor';

let temp: string;
const scan = vi.hoisted(() => vi.fn(() => ({ ok: true, consumers: [] as unknown[] })));
vi.mock('./paths', () => ({ getConfigDir: () => temp }));
vi.mock('./processDetection', () => ({
  inspectRunningAccountConsumersSync: scan,
  inspectRunningAccountConsumers: async () => scan(),
}));
const epoch = Date.parse('2026-09-26T12:00:00Z');
const accessExpiryBase = Date.now() + 86400000;
function auth(account: string, revision = 0): string {
  const jwt = (payload: unknown): string =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test`;
  return (
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        extra_future_field: { retained: true },
        last_refresh: new Date(epoch + revision * 1000).toISOString(),
        tokens: {
          id_token: jwt({
            email: `${account}@example.test`,
            'https://api.openai.com/auth': { chatgpt_account_id: account },
          }),
          access_token: jwt({ exp: Math.floor((accessExpiryBase + revision * 1000) / 1000) }),
          refresh_token: `synthetic-${account}-${revision}`,
          account_id: account,
        },
      },
      null,
      3,
    ) + '\n'
  );
}
const hash = (raw: string): string => createHash('sha256').update(raw).digest('hex');
const livePath = (): string => path.join(temp, 'live', 'auth.json');
function writeLive(raw: string): void {
  fs.mkdirSync(path.dirname(livePath()), { recursive: true });
  fs.writeFileSync(livePath(), raw);
}
function register(account: string): string {
  writeLive(auth(account));
  const result = prepareCodexAccount(account);
  expect(result.success, result.error).toBe(true);
  return result.profileId!;
}
function accounts(): { a: string; b: string } {
  const a = register('a'),
    b = register('b');
  return { a, b };
}
function writeProfile(id: string, raw: string): void {
  fs.mkdirSync(getCodexProfileHome(id), { recursive: true });
  fs.writeFileSync(path.join(getCodexProfileHome(id), 'auth.json'), raw);
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-safety-'));
  process.env.CODEX_HOME = path.join(temp, 'live');
  scan.mockReturnValue({ ok: true, consumers: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CODEX_HOME;
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('Codex single-copy storage (I1)', () => {
  it('does not restore or refresh accounts when CODEX_HOME names an isolated Sidekick home', () => {
    const { a, b } = accounts();
    process.env.CODEX_HOME = getCodexProfileHome(a);
    expect(getAccountLaunchEnv('codex', b).error).toMatch(/Unset CODEX_HOME/);
    expect(getCodexKeepAliveBlocker(b)).toMatch(/unset CODEX_HOME/);
    expect(io.readCodexCredentialStore(getCodexProfileHome(b)).status).toBe('absent');
  });
  it('imports raw bytes privately, routes live launches to live, and never recreates the live profile credential', () => {
    const a = register('a');
    const original = fs.readFileSync(livePath(), 'utf8');
    expect(hash(fs.readFileSync(getCodexBackupPath(a), 'utf8'))).toBe(hash(original));
    expect(fs.statSync(getCodexBackupPath(a)).mode & 0o777).toBe(0o600);
    storeCodexProfileAuth(a, original, null, 'live-sync');
    expect(fs.existsSync(path.join(getCodexProfileHome(a), 'auth.json'))).toBe(false);
    expect(getAccountLaunchEnv('codex', a).home).toBe(process.env.CODEX_HOME);
    syncCodexLiveState();
    expect(fs.existsSync(path.join(getCodexProfileHome(a), 'auth.json'))).toBe(false);
  });
  it('repairs a strictly newer duplicate before demoting it, using expiry as a tie-breaker', () => {
    const a = register('a');
    const newer = auth('a', 2);
    writeProfile(a, newer);
    const report = syncCodexLiveState();
    expect(report.repaired).toBe(a);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(hash(newer));
    expect(fs.existsSync(path.join(getCodexProfileHome(a), 'auth.json'))).toBe(false);
    const aRaw = JSON.parse(auth('a', 1));
    const bRaw = JSON.parse(auth('a', 2));
    bRaw.last_refresh = aRaw.last_refresh;
    expect(compareCodexAuthFreshness(JSON.stringify(bRaw), JSON.stringify(aRaw))).toBe(1);
    expect(compareCodexAuthFreshness('{}', '{}')).toBe(0);
  });
  it('keeps newer backups pending while consumers run and repairs on a later sync', () => {
    const a = register('a');
    const newer = auth('a', 4);
    writeProfile(a, newer);
    scan.mockReturnValue({
      ok: true,
      consumers: [{ kind: 'codex-cli', pids: [123], switched: true, reachability: 'busy' }],
    });
    const before = hash(fs.readFileSync(livePath(), 'utf8'));
    expect(syncCodexLiveState().warnings.length).toBeGreaterThan(0);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(before);
    scan.mockReturnValue({ ok: true, consumers: [] });
    expect(syncCodexLiveState().repaired).toBe(a);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(hash(newer));
  });
});

describe('Codex guarded switching (I2, I5)', () => {
  it('hands off one usable copy and leaves unrelated MCP credentials intact', () => {
    const { a, b } = accounts();
    const mcp = JSON.stringify({ server: { unrelated: true } });
    fs.writeFileSync(path.join(temp, 'live', '.credentials.json'), mcp);
    const result = switchToCodexAccount(a);
    expect(result.success, result.error).toBe(true);
    expect(fs.existsSync(path.join(getCodexProfileHome(a), 'auth.json'))).toBe(false);
    expect(io.readCodexCredentialStore(getCodexProfileHome(b)).status).toBe('ok');
    expect(hash(fs.readFileSync(path.join(temp, 'live', '.credentials.json'), 'utf8'))).toBe(
      hash(mcp),
    );
  });
  it('refuses force when capture fails or process discovery is unavailable', () => {
    const { a } = accounts();
    const before = hash(fs.readFileSync(livePath(), 'utf8'));
    scan.mockReturnValue({ ok: false, consumers: [] });
    expect(switchToCodexAccount(a, { force: true }).success).toBe(false);
    scan.mockReturnValue({ ok: true, consumers: [] });
    vi.spyOn(io, 'writeCodexBackup').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(switchToCodexAccount(a, { force: true }).success).toBe(false);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(before);
  });
  it('preserves a live snapshot changed after outgoing capture', () => {
    const { a, b } = accounts();
    const moved = auth('b', 8);
    const original = io.writeCodexBackup;
    let captures = 0;
    vi.spyOn(io, 'writeCodexBackup').mockImplementation((id, snapshot) => {
      original(id, snapshot);
      if (id === b && ++captures === 2) writeLive(moved);
    });
    expect(switchToCodexAccount(a).success).toBe(false);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(hash(moved));
  });
  it('never rolls back over a refreshed target after registry failure', () => {
    const { a } = accounts();
    const moved = auth('a', 8);
    const original = registry.setActiveSavedAccount;
    vi.spyOn(registry, 'setActiveSavedAccount').mockImplementation((provider, id, options) => {
      if (id === a && !options?.silent) {
        writeLive(moved);
        throw new Error('registry unavailable');
      }
      return original(provider, id, options);
    });
    expect(switchToCodexAccount(a).success).toBe(false);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(hash(moved));
  });
  it('refuses a target changed after selection and recovery preserves that newer profile', () => {
    const { a } = accounts();
    const moved = auth('a', 9);
    const original = io.writeCodexBackup;
    vi.spyOn(io, 'writeCodexBackup').mockImplementation((id, snapshot) => {
      original(id, snapshot);
      if (id === a) writeProfile(a, moved);
    });
    const before = hash(fs.readFileSync(livePath(), 'utf8'));
    expect(switchToCodexAccount(a).success).toBe(false);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(before);
    syncCodexLiveState();
    expect(hash(fs.readFileSync(path.join(getCodexProfileHome(a), 'auth.json'), 'utf8'))).toBe(
      hash(moved),
    );
  });
  it('refuses corrupt live data, a shared refresh link, and both keyring modes', () => {
    const { a } = accounts();
    writeLive('{');
    expect(switchToCodexAccount(a, { force: true }).success).toBe(false);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(hash('{'));
    for (const mode of ['keyring', 'auto']) {
      writeLive(auth('b'));
      fs.writeFileSync(
        path.join(temp, 'live', 'config.toml'),
        `cli_auth_credentials_store = "${mode}"\n`,
      );
      expect(switchToCodexAccount(a, { force: true }).success).toBe(false);
    }
  });
  it('recovers a crash after target demotion without overwriting live', () => {
    const { a, b } = accounts();
    const from = io.readCodexCredentialStore(),
      to = io.readCodexBackup(a);
    if (from.status !== 'ok' || to.status !== 'ok') throw new Error('invalid fixture');
    const journal = path.join(temp, 'accounts', 'codex', 'switch-journal.json');
    fs.writeFileSync(
      journal,
      JSON.stringify({
        from: b,
        to: a,
        fromHash: io.codexSnapshotFingerprint(io.codexLoginOnly(from.snapshot)),
        toHash: io.codexSnapshotFingerprint(to.snapshot),
        at: new Date().toISOString(),
      }),
    );
    expect(syncCodexLiveState().journal).toBe('rolled-back');
    expect(io.readCodexCredentialStore(getCodexProfileHome(a)).status).toBe('ok');
    expect(io.readCodexCredentialStore(getCodexProfileHome(b)).status).toBe('absent');
    expect(fs.existsSync(journal)).toBe(false);
  });
  it('allows only one live-writer call site (I2, static)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'codexProfiles.ts'), 'utf8');
    expect(source.match(/writeLiveCodexCredentialStoreUnguarded\(/g)).toHaveLength(1);
    const files = fs.readdirSync(__dirname, { recursive: true, encoding: 'utf8' });
    const references = files.filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        fs
          .readFileSync(path.join(__dirname, f), 'utf8')
          .includes('writeLiveCodexCredentialStoreUnguarded'),
    );
    expect(references.sort()).toEqual(['codexCredentialStore.ts', 'codexProfiles.ts']);
  });
});

describe('Codex keep-alive eligibility (I3)', () => {
  it('rejects a live refresh link even when profile metadata names another account', () => {
    const { a } = accounts();
    const duplicate = JSON.parse(auth('a'));
    duplicate.tokens.refresh_token = JSON.parse(
      fs.readFileSync(livePath(), 'utf8'),
    ).tokens.refresh_token;
    writeProfile(a, JSON.stringify(duplicate));
    expect(getCodexKeepAliveBlocker(a)).toMatch(/same refresh token/);
    expect(getAccountLaunchEnv('codex', a).error).toBeDefined();
    expect(switchToCodexAccount(a, { force: true }).success).toBe(false);
  });
  it('requires a persisted advance and releases the lease on runner failure', async () => {
    const { a } = accounts();
    storeCodexProfileAuth(a, auth('a'), null, 'switch');
    const unchanged = await refreshInactiveAccounts({
      providers: ['codex'],
      includeFresh: true,
      runner: async () => ({ status: 0, stdout: '' }),
    });
    expect(unchanged.refreshed).toHaveLength(0);
    expect(unchanged.failed.map((f) => f.id)).toEqual([a]);
    const refreshed = await refreshInactiveAccounts({
      providers: ['codex'],
      includeFresh: true,
      runner: async (_command, _args, env) => {
        expect(env.CODEX_HOME).toBe(getCodexProfileHome(a));
        writeProfile(a, auth('a', 2));
        return { status: 0, stdout: '' };
      },
    });
    expect(refreshed.refreshed.map((f) => f.id)).toEqual([a]);
    await refreshInactiveAccounts({
      providers: ['codex'],
      includeFresh: true,
      runner: async () => {
        throw new Error('unavailable');
      },
    });
    expect(beginCodexKeepAlive(a, 1000).ok).toBe(true);
    finishCodexKeepAlive(a);
  });
  it('blocks live identities, missing copies, provenance, stale copies, and leases', () => {
    const { a, b } = accounts();
    expect(getCodexKeepAliveBlocker(b)).toMatch(/live account/);
    expect(getCodexKeepAliveBlocker(a)).toMatch(/no readable profile/);
    writeProfile(a, auth('a'));
    expect(getCodexKeepAliveBlocker(a)).toMatch(/copied from the live/);
    storeCodexProfileAuth(a, auth('a'), null, 'switch');
    expect(beginCodexKeepAlive(a, 10000).ok).toBe(true);
    expect(switchToCodexAccount(a, { force: true }).success).toBe(false);
    finishCodexKeepAlive(a);
    io.writeCodexBackup(a, { authRaw: auth('a', 3), legacyRaw: null });
    expect(getCodexKeepAliveBlocker(a)).toMatch(/backup is newer/);
  });
});

describe('Codex temporary homes and doctor (I4)', () => {
  it('reports an unreadable private backup without replacing or deleting it', () => {
    const a = register('a');
    fs.writeFileSync(getCodexBackupPath(a), '{');
    const findings = inspectCodexCredentialStores().findings;
    expect(findings.some((f) => f.kind === 'corrupt' && f.ownership === 'backup')).toBe(true);
    expect(repairCodexCredentialStores().dryRun).toBe(true);
    expect(hash(fs.readFileSync(getCodexBackupPath(a), 'utf8'))).toBe(hash('{'));
  });
  it('starts explicit sign-in empty, saves separately, and removes its temporary home', () => {
    register('a');
    const login = prepareCodexAccount('New', { importCurrent: false });
    expect(login.needsLogin).toBe(true);
    expect(login.codexHome).toContain(`${path.sep}logins${path.sep}`);
    expect(io.readCodexCredentialStore(login.codexHome!).status).toBe('absent');
    fs.writeFileSync(path.join(login.codexHome!, 'auth.json'), auth('b'));
    const result = finalizeCodexAccount(login.profileId!, { activate: false });
    expect(result.success, result.error).toBe(true);
    expect(fs.existsSync(login.codexHome!)).toBe(false);
    expect(io.readCodexCredentialStore(getCodexProfileHome(result.profileId!)).status).toBe('ok');
  });
  it('reports without writing and prunes a known stale stash only after preserving credentials', () => {
    const a = register('a');
    writeProfile(a, auth('a'));
    const stash = path.join(temp, 'accounts', 'codex', 'stash');
    fs.mkdirSync(stash);
    const file = path.join(stash, 'auth-old.json');
    fs.writeFileSync(file, auth('a', -1));
    const before = fs.statSync(livePath()).mtimeMs;
    expect(
      inspectCodexCredentialStores()
        .findings.map((f) => f.kind)
        .sort(),
    ).toEqual(['live-duplicate', 'stale-stash']);
    expect(repairCodexCredentialStores().dryRun).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    const repair = repairCodexCredentialStores({ dryRun: false });
    expect(repair.repaired.every((r) => r.ok)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.statSync(livePath()).mtimeMs).toBe(before);
  });
  it('repairs a newer stash copy before deleting it, and preserves incomparable credentials', () => {
    register('a');
    const stash = path.join(temp, 'accounts', 'codex', 'stash');
    fs.mkdirSync(stash);
    const newer = auth('a', 4);
    const file = path.join(stash, 'auth-new.json');
    fs.writeFileSync(file, newer);
    expect(repairCodexCredentialStores({ dryRun: false }).repaired.every((r) => r.ok)).toBe(true);
    expect(hash(fs.readFileSync(livePath(), 'utf8'))).toBe(hash(newer));
    expect(fs.existsSync(file)).toBe(false);
    const ambiguous = JSON.parse(newer);
    ambiguous.tokens.refresh_token = 'synthetic-different-chain';
    fs.writeFileSync(file, JSON.stringify(ambiguous));
    expect(repairCodexCredentialStores({ dryRun: false }).repaired.some((r) => !r.ok)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });
});
