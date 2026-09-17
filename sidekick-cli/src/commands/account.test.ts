import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListAction,
  mockAddAction,
  mockSwitchAction,
  mockRemoveAction,
  mockConfigAction,
  mockLauncherAction,
} = vi.hoisted(() => ({
  mockListAction: vi.fn(),
  mockAddAction: vi.fn(),
  mockSwitchAction: vi.fn(),
  mockRemoveAction: vi.fn(),
  mockConfigAction: vi.fn(),
  mockLauncherAction: vi.fn(),
}));

vi.mock('./accounts/actions', () => ({
  contextFromCommand: (_cmd: unknown, local: Record<string, unknown>) => ({
    json: false,
    provider: undefined,
    yes: Boolean(local.yes || local.force),
    interactive: true,
    out: vi.fn(),
    err: vi.fn(),
  }),
  listAction: mockListAction,
  addAction: mockAddAction,
  switchAction: mockSwitchAction,
  removeAction: mockRemoveAction,
  configAction: mockConfigAction,
  launcherAction: mockLauncherAction,
}));

import { accountAction, mapLegacyInvocation } from './account';

function makeCmd(localOpts: Record<string, unknown> = {}): import('commander').Command {
  return {
    parent: { opts: () => ({ json: false }) },
    opts: () => localOpts,
  } as unknown as import('commander').Command;
}

describe('sidekick account (deprecated alias)', () => {
  let stderrData = '';

  beforeEach(() => {
    stderrData = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrData += String(chunk);
      return true;
    });
    process.exitCode = undefined;
    for (const mock of [
      mockListAction,
      mockAddAction,
      mockSwitchAction,
      mockRemoveAction,
      mockConfigAction,
      mockLauncherAction,
    ])
      mock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('maps every legacy flag combination to its modern command', () => {
    expect(mapLegacyInvocation({})).toBe('sidekick accounts list');
    expect(mapLegacyInvocation({ provider: 'all' })).toBe('sidekick accounts list');
    expect(mapLegacyInvocation({ provider: 'codex' })).toBe(
      'sidekick accounts list --provider codex',
    );
    expect(mapLegacyInvocation({ add: true, label: 'Work' })).toBe(
      'sidekick accounts add --current --label "Work"',
    );
    expect(mapLegacyInvocation({ login: true, label: 'Work', provider: 'codex' })).toBe(
      'sidekick accounts add --provider codex --label "Work"',
    );
    expect(mapLegacyInvocation({ switch: true })).toBe('sidekick accounts switch --next');
    expect(mapLegacyInvocation({ switchTo: 'work' })).toBe('sidekick accounts switch "work"');
    expect(mapLegacyInvocation({ remove: 'work', yes: true })).toBe(
      'sidekick accounts remove "work" --yes',
    );
    expect(mapLegacyInvocation({ launcher: 'claude-work' })).toBe('sidekick accounts shell <name>');
    expect(mapLegacyInvocation({ autoSwitch: '80' })).toBe(
      'sidekick accounts config auto-switch 80',
    );
  });

  it('prints the deprecation hint and delegates listing', async () => {
    await accountAction({}, makeCmd({}));

    expect(stderrData).toContain('sidekick account is deprecated; use: sidekick accounts list');
    expect(mockListAction).toHaveBeenCalledWith(expect.objectContaining({ provider: undefined }));
  });

  it('delegates --switch-to, --switch, and --remove with the Claude default provider', async () => {
    await accountAction({}, makeCmd({ switchTo: 'work' }));
    expect(mockSwitchAction).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code' }),
      'work',
    );

    await accountAction({}, makeCmd({ switch: true, provider: 'codex' }));
    expect(mockSwitchAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'codex' }),
      undefined,
      { next: true },
    );

    await accountAction({}, makeCmd({ remove: 'home', yes: true }));
    expect(mockRemoveAction).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code', yes: true }),
      'home',
    );
  });

  it('delegates --add to registering the current login and --login to an isolated sign-in', async () => {
    await accountAction({}, makeCmd({ add: true, label: 'Work' }));
    expect(mockAddAction).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code' }),
      { label: 'Work', current: true },
    );

    await accountAction({}, makeCmd({ login: true, label: 'Client', provider: 'codex' }));
    expect(mockAddAction).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex' }), {
      label: 'Client',
    });
  });

  it('delegates --auto-switch and --launcher, and rejects OpenCode', async () => {
    await accountAction({}, makeCmd({ autoSwitch: 'off' }));
    expect(mockConfigAction).toHaveBeenCalledWith(expect.anything(), 'auto-switch', 'off');

    await accountAction({}, makeCmd({ launcher: 'codex-work', provider: 'codex' }));
    expect(mockLauncherAction).toHaveBeenCalledWith(expect.anything(), 'codex-work', 'codex');

    await accountAction({}, makeCmd({ provider: 'opencode' }));
    expect(stderrData).toContain('OpenCode account management is not supported.');
    expect(process.exitCode).toBe(1);
  });
});
