import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView, SwitchAccountResult } from 'sidekick-shared';

const shared = vi.hoisted(() => ({
  listAccountsWithHealth: vi.fn(),
  syncLiveAccountState: vi.fn(),
  switchAccountAsync: vi.fn(),
  undoLastSwitch: vi.fn(),
  getLastSwitch: vi.fn(),
  spawnAccountLogin: vi.fn(),
  removeAccount: vi.fn(),
  removeCodexAccount: vi.fn(),
  getAccountLaunchEnv: vi.fn(),
  detectRunningAccountConsumers: vi.fn(),
  getCodexCredentialStoreMode: vi.fn(),
  refreshInactiveAccounts: vi.fn(),
  addCurrentAccount: vi.fn(),
  listSavedAccountProfiles: vi.fn(),
  upsertSavedAccountProfile: vi.fn(),
  writeLauncher: vi.fn(),
  getClaudeProfileHome: vi.fn(() => '/profiles/claude'),
  getCodexProfileHome: vi.fn(() => '/profiles/codex'),
}));

vi.mock('sidekick-shared', () => ({
  ...shared,
  DEFAULT_AUTO_SWITCH_CONFIG: { enabled: false, thresholdPct: 90 },
}));

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../utils/cliConfig', () => ({
  readCliConfig: () => config.value,
  writeCliConfig: (next: Record<string, unknown>) => {
    config.value = next;
  },
}));

const mockConfirm = vi.hoisted(() => vi.fn());
vi.mock('../../utils/confirm', () => ({ confirmDestructive: mockConfirm }));

import {
  addAction,
  collectAccountChecks,
  configAction,
  envAction,
  listAction,
  removeAction,
  switchAction,
  undoAction,
  type AccountsContext,
} from './actions';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function view(overrides: Partial<AccountView> & { id: string }): AccountView {
  return {
    providerId: 'claude-code',
    label: overrides.id,
    email: `${overrides.id}@example.com`,
    isActive: false,
    source: 'registered',
    addedAt: '2026-01-01T00:00:00Z',
    health: {
      providerId: 'claude-code',
      accountId: overrides.id,
      state: 'fresh',
      checkedAt: NOW,
      isLive: false,
      refreshExpiresAt: NOW + 6 * DAY,
    },
    ...overrides,
  };
}

function switchResult(overrides: Partial<SwitchAccountResult> = {}): SwitchAccountResult {
  return {
    success: true,
    provider: 'claude-code',
    accountId: 'work',
    previousAccountId: 'home',
    verified: true,
    verification: 'store',
    warnings: [],
    hints: ['New claude sessions use work@example.com.'],
    runningConsumers: [],
    undoToken: 'tok',
    email: 'work@example.com',
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<AccountsContext> = {},
): AccountsContext & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    json: false,
    yes: false,
    interactive: false,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    now: () => NOW,
    stdout,
    stderr,
    ...overrides,
  };
}

const emptySync = {
  claude: { warnings: [] },
  codex: { warnings: [] },
  ranAt: NOW,
  reason: 'manual' as const,
};

describe('accounts actions', () => {
  beforeEach(() => {
    for (const fn of Object.values(shared))
      if ('mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
    shared.getClaudeProfileHome.mockReturnValue('/profiles/claude');
    shared.getCodexProfileHome.mockReturnValue('/profiles/codex');
    shared.syncLiveAccountState.mockResolvedValue(emptySync);
    shared.listAccountsWithHealth.mockReturnValue([]);
    config.value = {};
    mockConfirm.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('lists accounts as JSON with registeredNow and the active pointers', async () => {
    shared.syncLiveAccountState.mockResolvedValue({
      ...emptySync,
      claude: { registered: { id: 'work', email: 'work@example.com' }, warnings: [] },
    });
    shared.listAccountsWithHealth.mockReturnValue([
      view({ id: 'work', isActive: true, source: 'learned' }),
      view({ id: 'c', providerId: 'codex', isActive: true }),
    ]);
    const ctx = makeCtx({ json: true });

    await listAction(ctx);

    expect(ctx.stderr).toEqual([
      expect.stringContaining('Registered work@example.com (Claude Code).'),
    ]);
    const parsed = JSON.parse(ctx.stdout[0]);
    expect(parsed.registeredNow).toEqual(['work']);
    expect(parsed.activeByProvider).toEqual({ 'claude-code': 'work', codex: 'c' });
    expect(parsed.accounts).toHaveLength(2);
  });

  it('prints first-run guidance only when every account was learned, and the empty state otherwise', async () => {
    shared.listAccountsWithHealth.mockReturnValue([view({ id: 'work', source: 'learned' })]);
    let ctx = makeCtx();
    await listAction(ctx);
    expect(ctx.stdout.join('\n')).toContain('registered automatically');

    shared.listAccountsWithHealth.mockReturnValue([view({ id: 'work' })]);
    ctx = makeCtx();
    await listAction(ctx);
    expect(ctx.stdout.join('\n')).not.toContain('registered automatically');

    shared.listAccountsWithHealth.mockReturnValue([]);
    ctx = makeCtx();
    await listAction(ctx);
    expect(ctx.stdout[0]).toContain('No accounts yet');
  });

  it('switches by name and prints the verified summary with consumer warnings', async () => {
    shared.listAccountsWithHealth.mockReturnValue([
      view({ id: 'home', isActive: true }),
      view({ id: 'work' }),
    ]);
    shared.switchAccountAsync.mockResolvedValue(
      switchResult({
        warnings: ['Running claude sessions keep the previous account until restarted.'],
      }),
    );
    const ctx = makeCtx();

    await switchAction(ctx, 'wor');

    expect(shared.switchAccountAsync).toHaveBeenCalledWith('claude-code', 'work', {
      force: undefined,
    });
    expect(ctx.stdout[0]).toContain('Switched Claude Code → work (work@example.com)  ✓ verified');
    expect(ctx.stderr[0]).toContain('! Running claude sessions');
    expect(ctx.stdout).toContainEqual(expect.stringContaining('Undo: sidekick accounts undo'));
    expect(process.exitCode).toBeUndefined();
  });

  it('reports expired targets with a sign-in hint and a non-zero exit', async () => {
    shared.listAccountsWithHealth.mockReturnValue([view({ id: 'work' })]);
    shared.switchAccountAsync.mockResolvedValue(
      switchResult({
        success: false,
        needsLogin: true,
        error: 'Stored credentials for "work" have expired; sign in again.',
        verified: false,
        undoToken: undefined,
      }),
    );
    const ctx = makeCtx();

    await switchAction(ctx, 'work');

    expect(ctx.stderr[0]).toContain('expired');
    expect(ctx.stdout[0]).toBe(
      expect.stringContaining('Sign in again: sidekick accounts login "work"').toString() === ''
        ? ''
        : ctx.stdout[0],
    );
    expect(ctx.stdout.join('\n')).toContain('sidekick accounts login "work"');
    expect(process.exitCode).toBe(1);
  });

  it('switches to the next account of the only provider with --next and refuses with two providers', async () => {
    shared.listAccountsWithHealth.mockReturnValue([
      view({ id: 'a', isActive: true }),
      view({ id: 'b' }),
    ]);
    shared.switchAccountAsync.mockResolvedValue(
      switchResult({ accountId: 'b', email: 'b@example.com' }),
    );
    await switchAction(makeCtx(), undefined, { next: true });
    expect(shared.switchAccountAsync).toHaveBeenCalledWith('claude-code', 'b', {
      force: undefined,
    });

    shared.listAccountsWithHealth.mockReturnValue([
      view({ id: 'a', isActive: true }),
      view({ id: 'b' }),
      view({ id: 'c', providerId: 'codex' }),
    ]);
    const ctx = makeCtx();
    await switchAction(ctx, undefined, { next: true });
    expect(ctx.stderr[0]).toContain('add --provider');
    expect(process.exitCode).toBe(1);
  });

  it('refuses to remove without --yes when piped or in JSON mode, and removes after confirmation', async () => {
    shared.listAccountsWithHealth.mockReturnValue([
      view({ id: 'work' }),
      view({ id: 'c', providerId: 'codex' }),
    ]);
    let ctx = makeCtx({ interactive: false });
    await removeAction(ctx, 'work');
    expect(ctx.stderr[0]).toContain('Re-run with --yes');
    expect(shared.removeAccount).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    mockConfirm.mockResolvedValue(true);
    shared.removeCodexAccount.mockReturnValue({ success: true });
    ctx = makeCtx({ interactive: true });
    await removeAction(ctx, 'c');
    expect(shared.removeCodexAccount).toHaveBeenCalledWith('c');
    expect(ctx.stdout[0]).toContain('Removed');

    mockConfirm.mockResolvedValue(false);
    ctx = makeCtx({ interactive: true });
    await removeAction(ctx, 'work');
    expect(ctx.stderr[0]).toContain('Aborted');
    expect(shared.removeAccount).not.toHaveBeenCalled();
  });

  it('prints env exports for the requested shell and refuses expired accounts', async () => {
    shared.listAccountsWithHealth.mockReturnValue([view({ id: 'work' })]);
    shared.getAccountLaunchEnv.mockReturnValue({
      env: { CLAUDE_CONFIG_DIR: '/p/home' },
      envUnset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'],
      warnings: [],
    });
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      await envAction(makeCtx(), 'work', { shell: 'powershell' });
      expect(writes.join('')).toBe(
        "$env:CLAUDE_CONFIG_DIR = '/p/home'\nRemove-Item Env:CLAUDE_SECURESTORAGE_CONFIG_DIR -ErrorAction SilentlyContinue\n",
      );
    } finally {
      spy.mockRestore();
    }

    shared.getAccountLaunchEnv.mockReturnValue({
      env: {},
      envUnset: [],
      warnings: [],
      error: 'expired; sign in again',
    });
    const ctx = makeCtx();
    await envAction(ctx, 'work', { shell: 'bash' });
    expect(ctx.stderr[0]).toContain('expired');
    expect(process.exitCode).toBe(1);

    const bad = makeCtx();
    await envAction(bad, 'work', { shell: 'nushell' });
    expect(bad.stderr[0]).toContain('Unknown shell');
  });

  it('undoes the only recorded switch and asks for a provider when both have records', async () => {
    shared.getLastSwitch.mockImplementation((provider: string) =>
      provider === 'codex' ? { token: 't', provider, from: 'x', to: 'y', at: '' } : null,
    );
    shared.undoLastSwitch.mockResolvedValue(
      switchResult({ provider: 'codex', accountId: 'x', email: undefined }),
    );
    shared.listAccountsWithHealth.mockReturnValue([
      view({ id: 'x', providerId: 'codex', label: 'X' }),
    ]);
    const ctx = makeCtx();
    await undoAction(ctx);
    expect(shared.undoLastSwitch).toHaveBeenCalledWith('codex');
    expect(ctx.stdout[0]).toContain('Switched Codex → X');

    shared.getLastSwitch.mockReturnValue({
      token: 't',
      provider: 'codex',
      from: 'x',
      to: 'y',
      at: '',
    });
    const both = makeCtx();
    await undoAction(both);
    expect(both.stderr[0]).toContain('Both providers');
  });

  it('adds an account through an isolated login and offers activation', async () => {
    shared.spawnAccountLogin.mockResolvedValue({ success: true, profileId: 'new' });
    shared.listAccountsWithHealth.mockReturnValue([
      view({ id: 'home', isActive: true }),
      view({ id: 'new', label: 'Work' }),
    ]);
    shared.switchAccountAsync.mockResolvedValue(switchResult({ accountId: 'new' }));
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const outTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const ctx = makeCtx({ provider: 'claude-code', yes: true, interactive: true });
      await addAction(ctx, { label: 'Work' });

      expect(shared.spawnAccountLogin).toHaveBeenCalledWith(
        'claude-code',
        'Work',
        expect.objectContaining({ activate: false, stdio: 'inherit' }),
      );
      expect(ctx.stderr[0]).toContain('claude auth login in an isolated profile');
      expect(ctx.stdout[0]).toContain('Saved Work (new@example.com)');
      expect(shared.switchAccountAsync).toHaveBeenCalledWith('claude-code', 'new');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: outTTY, configurable: true });
    }
  });

  it('names the re-run command when a login times out', async () => {
    shared.spawnAccountLogin.mockResolvedValue({
      success: false,
      error: 'Account login timed out.',
    });
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const outTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const ctx = makeCtx({ provider: 'codex', yes: true, interactive: true });
      await addAction(ctx, { label: 'Client' });
      expect(ctx.stderr.join('\n')).toContain(
        'Re-run: sidekick accounts add --provider codex --label "Client"',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: outTTY, configurable: true });
    }
  });

  it('collects doctor checks for accounts, running apps, the Codex store, and keep-alive', async () => {
    shared.listAccountsWithHealth.mockReturnValue([
      view({ id: 'work', isActive: true }),
      view({
        id: 'old',
        health: {
          providerId: 'claude-code',
          accountId: 'old',
          state: 'expired',
          checkedAt: NOW,
          isLive: false,
        },
      }),
    ]);
    shared.detectRunningAccountConsumers.mockResolvedValue([
      {
        kind: 'claude-desktop',
        pids: [1],
        switched: false,
        reachability: 'Claude Desktop is not switched by sidekick.',
      },
    ]);
    shared.getCodexCredentialStoreMode.mockReturnValue('keyring');

    const checks = await collectAccountChecks(makeCtx());

    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['account:claude-code:work', 'ok'],
      ['account:claude-code:old', 'error'],
      ['running-apps', 'info'],
      ['codex-credential-store', 'warning'],
      ['keep-alive', 'info'],
    ]);
    expect(checks[1].repair).toBe('sidekick accounts login "old"');
    expect(checks[2].message).toContain('Claude Desktop is not switched');
    expect(checks[3].repair).toContain('cli_auth_credentials_store = "file"');
    expect(checks[4].repair).toBe('sidekick accounts config keep-alive on');
  });

  it('persists auto-switch and keep-alive settings with validation', () => {
    const ctx = makeCtx();
    configAction(ctx, 'auto-switch', '80');
    expect(config.value).toEqual({ accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } } });
    configAction(ctx, 'keep-alive', 'on');
    expect(config.value).toEqual({
      accounts: { autoSwitch: { enabled: true, thresholdPct: 80 }, keepAlive: true },
    });
    configAction(ctx, 'keep-alive', 'maybe');
    expect(ctx.stderr.at(-1)).toContain('Use `on` or `off`');
    configAction(ctx, 'other', 'x');
    expect(ctx.stderr.at(-1)).toContain('Unknown setting');
    expect(process.exitCode).toBe(1);
  });
});
