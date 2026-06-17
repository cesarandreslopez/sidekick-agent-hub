import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockSpawnSync = vi.hoisted(() => vi.fn());

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  };
});

import {
  prepareCodexAccount,
  finalizeCodexAccount,
  listCodexAccounts,
  getActiveCodexAccount,
  switchToCodexAccount,
  removeCodexAccount,
  getCodexProfileHome,
  getCodexMonitoringHomes,
  resolveSidekickCodexHome,
  reconcileCodexAuthState,
} from './codexProfiles';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function systemHome(): string {
  return path.join(tmpDir, '.codex');
}

function systemAuthPath(): string {
  return path.join(systemHome(), 'auth.json');
}

function makeAuthJson(email: string, workspaceId: string, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: makeJwt({
        email,
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'plus',
          chatgpt_account_id: workspaceId,
        },
      }),
      access_token: `access-${workspaceId}`,
      refresh_token: `refresh-${workspaceId}`,
      account_id: workspaceId,
    },
    ...extras,
  }, null, 2);
}

function writeSystemAuth(content: string): void {
  fs.mkdirSync(systemHome(), { recursive: true });
  fs.writeFileSync(systemAuthPath(), content);
}

function writeSourceCodexAuth(email = 'codex@example.com'): void {
  fs.mkdirSync(systemHome(), { recursive: true });
  fs.writeFileSync(path.join(systemHome(), 'config.toml'), 'model = "gpt-5"\n');
  writeSystemAuth(makeAuthJson(email, 'ws-123'));
}

function mockCodexCli({ loggedIn, pgrepHit = false }: { loggedIn: boolean; pgrepHit?: boolean }): void {
  mockSpawnSync.mockImplementation((command: unknown) => {
    if (command === 'pgrep') {
      return { status: pgrepHit ? 0 : 1, stdout: '', stderr: '', error: undefined };
    }
    return {
      status: loggedIn ? 0 : 1,
      stdout: loggedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n',
      stderr: '',
      error: undefined,
    };
  });
}

// Creates two saved accounts; leaves "Personal" live in the system home and active.
function setupTwoAccounts(): { work: string; personal: string } {
  writeSystemAuth(makeAuthJson('work@example.com', 'ws-work'));
  const work = prepareCodexAccount('Work');
  writeSystemAuth(makeAuthJson('personal@example.com', 'ws-personal'));
  const personal = prepareCodexAccount('Personal');
  expect(work.success && personal.success).toBe(true);
  return { work: work.profileId!, personal: personal.profileId! };
}

describe('codexProfiles', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-profiles-test-'));
    mockSpawnSync.mockReset();
    mockCodexCli({ loggedIn: false });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports current Codex auth into a managed profile and makes it active', () => {
    writeSourceCodexAuth('work@example.com');

    const result = prepareCodexAccount('Work');

    expect(result.success).toBe(true);
    expect(result.needsLogin).toBe(false);
    expect(result.profileId).toBeTruthy();

    const profileHome = getCodexProfileHome(result.profileId!);
    expect(fs.existsSync(path.join(profileHome, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(profileHome, 'config.toml'))).toBe(true);
    expect(getActiveCodexAccount()).toEqual(
      expect.objectContaining({
        id: result.profileId,
        label: 'Work',
        providerId: 'codex',
        email: 'work@example.com',
        metadata: expect.objectContaining({
          email: 'work@example.com',
          authMode: 'chatgpt',
          planType: 'plus',
          workspaceId: 'ws-123',
        }),
      }),
    );
    expect(resolveSidekickCodexHome()).toBe(systemHome());
  });

  it('creates a pending managed profile when current auth is not importable and finalizes after login', () => {
    const prepared = prepareCodexAccount('Personal');

    expect(prepared.success).toBe(true);
    expect(prepared.needsLogin).toBe(true);
    expect(prepared.profileId).toBeTruthy();

    mockCodexCli({ loggedIn: true });

    const finalized = finalizeCodexAccount(prepared.profileId!);
    expect(finalized.success).toBe(true);
    expect(finalized.warning).toMatch(/keyring/i);
    expect(getActiveCodexAccount()).toEqual(
      expect.objectContaining({
        id: prepared.profileId,
        label: 'Personal',
        providerId: 'codex',
        metadata: expect.objectContaining({
          authMode: 'chatgpt',
        }),
      }),
    );
  });

  it('switches and removes managed Codex profiles', () => {
    const { work, personal } = setupTwoAccounts();

    expect(listCodexAccounts()).toHaveLength(2);

    const switched = switchToCodexAccount(work);
    expect(switched.success).toBe(true);
    expect(getActiveCodexAccount()?.id).toBe(work);
    expect(resolveSidekickCodexHome()).toBe(systemHome());
    expect(fs.readFileSync(systemAuthPath(), 'utf8'))
      .toBe(fs.readFileSync(path.join(getCodexProfileHome(work), 'auth.json'), 'utf8'));

    const removed = removeCodexAccount(work);
    expect(removed.success).toBe(true);
    expect(fs.existsSync(getCodexProfileHome(work))).toBe(false);
    expect(getActiveCodexAccount()?.id).toBe(personal);
  });

  describe('account switching (auth.json swap)', () => {
    it('swaps the system auth.json and backs up the rotated live credentials', () => {
      const { work, personal } = setupTwoAccounts();

      // Simulate codex rotating the live tokens since the backup was taken.
      const rotated = makeAuthJson('personal@example.com', 'ws-personal', { last_refresh: '2026-06-01T00:00:00Z' });
      writeSystemAuth(rotated);

      const result = switchToCodexAccount(work);

      expect(result.success).toBe(true);
      const workStored = fs.readFileSync(path.join(getCodexProfileHome(work), 'auth.json'), 'utf8');
      expect(fs.readFileSync(systemAuthPath(), 'utf8')).toBe(workStored);
      expect(fs.readFileSync(path.join(getCodexProfileHome(personal), 'auth.json'), 'utf8')).toBe(rotated);
      expect(getActiveCodexAccount()?.id).toBe(work);
      expect(fs.statSync(systemAuthPath()).mode & 0o777).toBe(0o600);
    });

    it('syncs live credentials back to whichever saved account they belong to', () => {
      const { work, personal } = setupTwoAccounts();

      // The user ran `codex login` with the Work account outside sidekick.
      const externalWork = makeAuthJson('work@example.com', 'ws-work', { last_refresh: '2026-06-02T00:00:00Z' });
      writeSystemAuth(externalWork);

      const result = switchToCodexAccount(personal);

      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(getCodexProfileHome(work), 'auth.json'), 'utf8')).toBe(externalWork);
      expect(fs.readFileSync(systemAuthPath(), 'utf8'))
        .toBe(fs.readFileSync(path.join(getCodexProfileHome(personal), 'auth.json'), 'utf8'));
      expect(getActiveCodexAccount()?.id).toBe(personal);
    });

    it('never replaces live credentials with a staler copy of the same account', () => {
      const { work } = setupTwoAccounts();

      const rotatedWork = makeAuthJson('work@example.com', 'ws-work', { last_refresh: '2026-06-03T00:00:00Z' });
      writeSystemAuth(rotatedWork);

      const result = switchToCodexAccount(work);

      expect(result.success).toBe(true);
      expect(fs.readFileSync(systemAuthPath(), 'utf8')).toBe(rotatedWork);
      expect(fs.readFileSync(path.join(getCodexProfileHome(work), 'auth.json'), 'utf8')).toBe(rotatedWork);
      expect(getActiveCodexAccount()?.id).toBe(work);
    });

    it('stashes live credentials that match no saved account', () => {
      const { work } = setupTwoAccounts();
      writeSystemAuth(makeAuthJson('stranger@example.com', 'ws-stranger'));

      const result = switchToCodexAccount(work);

      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/stashed/i);
      const stashDir = path.join(tmpDir, 'accounts', 'codex', 'stash');
      expect(fs.readdirSync(stashDir)).toHaveLength(1);
      expect(fs.readFileSync(systemAuthPath(), 'utf8'))
        .toBe(fs.readFileSync(path.join(getCodexProfileHome(work), 'auth.json'), 'utf8'));
    });

    it('rolls back and reports an error when the system home is not writable', () => {
      const { work, personal } = setupTwoAccounts();
      const before = fs.readFileSync(systemAuthPath(), 'utf8');

      fs.chmodSync(systemHome(), 0o500);
      try {
        const result = switchToCodexAccount(work);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Failed to write Codex credentials/);
      } finally {
        fs.chmodSync(systemHome(), 0o700);
      }

      expect(fs.readFileSync(systemAuthPath(), 'utf8')).toBe(before);
      expect(getActiveCodexAccount()?.id).toBe(personal);
    });

    it('refuses to switch when codex stores credentials in the OS keyring', () => {
      const { work } = setupTwoAccounts();
      fs.rmSync(systemAuthPath());
      mockCodexCli({ loggedIn: true });

      const result = switchToCodexAccount(work);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/keyring/i);
      expect(fs.existsSync(systemAuthPath())).toBe(false);
    });

    it('switches onto an empty system home when codex is not logged in at all', () => {
      const { work } = setupTwoAccounts();
      fs.rmSync(systemAuthPath());

      const result = switchToCodexAccount(work);

      expect(result.success).toBe(true);
      expect(fs.readFileSync(systemAuthPath(), 'utf8'))
        .toBe(fs.readFileSync(path.join(getCodexProfileHome(work), 'auth.json'), 'utf8'));
    });

    it('swaps legacy .credentials.json profiles', () => {
      fs.mkdirSync(systemHome(), { recursive: true });
      const legacyCreds = JSON.stringify({ OPENAI_API_KEY: 'sk-legacy' });
      fs.writeFileSync(path.join(systemHome(), '.credentials.json'), legacyCreds);
      const legacy = prepareCodexAccount('Legacy');
      expect(legacy.success).toBe(true);

      fs.rmSync(path.join(systemHome(), '.credentials.json'));
      writeSystemAuth(makeAuthJson('work@example.com', 'ws-work'));
      const work = prepareCodexAccount('Work');
      expect(work.success).toBe(true);

      const toLegacy = switchToCodexAccount(legacy.profileId!);
      expect(toLegacy.success).toBe(true);
      expect(fs.readFileSync(path.join(systemHome(), '.credentials.json'), 'utf8')).toBe(legacyCreds);
      expect(fs.existsSync(systemAuthPath())).toBe(false);

      const toWork = switchToCodexAccount(work.profileId!);
      expect(toWork.success).toBe(true);
      expect(fs.existsSync(path.join(systemHome(), '.credentials.json'))).toBe(false);
      expect(fs.readFileSync(systemAuthPath(), 'utf8'))
        .toBe(fs.readFileSync(path.join(getCodexProfileHome(work.profileId!), 'auth.json'), 'utf8'));
    });

    it('activates a freshly logged-in profile by promoting its auth.json to the system home', () => {
      const prepared = prepareCodexAccount('Fresh');
      expect(prepared.needsLogin).toBe(true);

      const freshAuth = makeAuthJson('fresh@example.com', 'ws-fresh');
      fs.writeFileSync(path.join(prepared.codexHome!, 'auth.json'), freshAuth);

      const finalized = finalizeCodexAccount(prepared.profileId!);

      expect(finalized.success).toBe(true);
      expect(getActiveCodexAccount()?.id).toBe(prepared.profileId);
      expect(fs.readFileSync(systemAuthPath(), 'utf8')).toBe(freshAuth);
    });

    it('warns when a codex process is running during the switch', () => {
      const { work } = setupTwoAccounts();
      mockCodexCli({ loggedIn: false, pgrepHit: true });

      const result = switchToCodexAccount(work);

      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/codex process/i);
    });

    it('warns when the stored credentials are older than the refresh window', () => {
      const { work } = setupTwoAccounts();
      fs.writeFileSync(
        path.join(getCodexProfileHome(work), 'auth.json'),
        makeAuthJson('work@example.com', 'ws-work', { last_refresh: '2020-01-01T00:00:00Z' }),
      );

      const result = switchToCodexAccount(work);

      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/8 days/);
    });
  });

  describe('reconcileCodexAuthState', () => {
    it('promotes a fresher profile copy over the system copy once', () => {
      const { personal } = setupTwoAccounts();
      const oldLive = makeAuthJson('personal@example.com', 'ws-personal', { last_refresh: '2020-01-01T00:00:00Z' });
      writeSystemAuth(oldLive);
      const fresher = makeAuthJson('personal@example.com', 'ws-personal', { last_refresh: '2020-02-01T00:00:00Z' });
      fs.writeFileSync(path.join(getCodexProfileHome(personal), 'auth.json'), fresher);

      reconcileCodexAuthState();

      expect(fs.readFileSync(systemAuthPath(), 'utf8')).toBe(fresher);
      const stashDir = path.join(tmpDir, 'accounts', 'codex', 'stash');
      expect(fs.readdirSync(stashDir)).toHaveLength(1);

      // The marker prevents a second run from touching anything.
      writeSystemAuth(oldLive);
      reconcileCodexAuthState();
      expect(fs.readFileSync(systemAuthPath(), 'utf8')).toBe(oldLive);
    });

    it('repoints the registry when the live credentials belong to a different saved account', () => {
      const { work, personal } = setupTwoAccounts();
      expect(getActiveCodexAccount()?.id).toBe(personal);
      const externalWork = makeAuthJson('work@example.com', 'ws-work', { last_refresh: '2020-03-01T00:00:00Z' });
      writeSystemAuth(externalWork);

      reconcileCodexAuthState();

      expect(getActiveCodexAccount()?.id).toBe(work);
      expect(fs.readFileSync(systemAuthPath(), 'utf8')).toBe(externalWork);
      expect(fs.readFileSync(path.join(getCodexProfileHome(work), 'auth.json'), 'utf8')).toBe(externalWork);
    });
  });

  describe('getCodexMonitoringHomes', () => {
    it('returns the system home plus profile homes that contain recorded sessions', () => {
      const { work, personal } = setupTwoAccounts();
      fs.mkdirSync(path.join(getCodexProfileHome(work), 'sessions'), { recursive: true });

      const homes = getCodexMonitoringHomes();

      expect(homes[0]).toBe(systemHome());
      expect(homes).toContain(getCodexProfileHome(work));
      expect(homes).not.toContain(getCodexProfileHome(personal));
    });
  });
});
