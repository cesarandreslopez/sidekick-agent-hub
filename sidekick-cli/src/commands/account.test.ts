import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockListAccounts = vi.fn();
const mockGetActiveAccount = vi.fn();
const mockAddCurrentAccount = vi.fn();
const mockSwitchToAccount = vi.fn();
const mockRemoveAccount = vi.fn();
const mockReadActiveClaudeAccount = vi.fn();
const mockListCodexAccounts = vi.fn();
const mockGetActiveCodexAccount = vi.fn();
const mockPrepareCodexAccount = vi.fn();
const mockFinalizeCodexAccount = vi.fn();
const mockSwitchToCodexAccount = vi.fn();
const mockRemoveCodexAccount = vi.fn();
const mockResolveProviderId = vi.fn();

vi.mock('sidekick-shared', () => ({
  listAccounts: mockListAccounts,
  getActiveAccount: mockGetActiveAccount,
  addCurrentAccount: mockAddCurrentAccount,
  switchToAccount: mockSwitchToAccount,
  removeAccount: mockRemoveAccount,
  readActiveClaudeAccount: mockReadActiveClaudeAccount,
  listCodexAccounts: mockListCodexAccounts,
  getActiveCodexAccount: mockGetActiveCodexAccount,
  prepareCodexAccount: mockPrepareCodexAccount,
  finalizeCodexAccount: mockFinalizeCodexAccount,
  switchToCodexAccount: mockSwitchToCodexAccount,
  removeCodexAccount: mockRemoveCodexAccount,
}));

vi.mock('../cli', () => ({
  resolveProviderId: mockResolveProviderId,
}));

describe('accountAction', () => {
  let stdoutData = '';
  let stderrData = '';
  const originalExit = process.exit;

  const makeCmd = (
    localOpts: Record<string, unknown> = {},
    globalOpts: Record<string, unknown> = {},
  ) => ({
    parent: { opts: () => ({ json: false, ...globalOpts }) },
    opts: () => localOpts,
  }) as unknown as import('commander').Command;

  beforeEach(() => {
    stdoutData = '';
    stderrData = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutData += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrData += String(chunk);
      return true;
    });
    process.exit = vi.fn() as never;

    mockListAccounts.mockReset();
    mockGetActiveAccount.mockReset();
    mockAddCurrentAccount.mockReset();
    mockSwitchToAccount.mockReset();
    mockRemoveAccount.mockReset();
    mockReadActiveClaudeAccount.mockReset();
    mockListCodexAccounts.mockReset();
    mockGetActiveCodexAccount.mockReset();
    mockPrepareCodexAccount.mockReset();
    mockFinalizeCodexAccount.mockReset();
    mockSwitchToCodexAccount.mockReset();
    mockRemoveCodexAccount.mockReset();
    mockResolveProviderId.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('lists Claude accounts by default', async () => {
    mockResolveProviderId.mockReturnValue('claude-code');
    mockListAccounts.mockReturnValue([
      { uuid: 'claude-1', email: 'user@example.com', label: 'Work', addedAt: '2026-01-01T00:00:00Z' },
    ]);
    mockGetActiveAccount.mockReturnValue({
      uuid: 'claude-1',
      email: 'user@example.com',
      label: 'Work',
      addedAt: '2026-01-01T00:00:00Z',
    });

    const { accountAction } = await import('./account');
    await accountAction({}, makeCmd());

    expect(stdoutData).toContain('Claude Accounts');
    expect(stdoutData).toContain('user@example.com');
    expect(mockListAccounts).toHaveBeenCalled();
  });

  it('requires a label when adding a Codex account', async () => {
    mockResolveProviderId.mockReturnValue('codex');

    const { accountAction } = await import('./account');
    await accountAction({}, makeCmd({ add: true }));

    expect(stderrData).toContain('Codex accounts require `--label`.');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockPrepareCodexAccount).not.toHaveBeenCalled();
  });

  it('lists Codex accounts with the active marker', async () => {
    mockResolveProviderId.mockReturnValue('codex');
    mockListCodexAccounts.mockReturnValue([
      {
        id: 'codex-1',
        providerId: 'codex',
        label: 'Work',
        email: 'user@example.com',
        addedAt: '2026-01-01T00:00:00Z',
        metadata: { authMode: 'chatgpt', planType: 'plus' },
      },
    ]);
    mockGetActiveCodexAccount.mockReturnValue({
      id: 'codex-1',
      providerId: 'codex',
      label: 'Work',
      email: 'user@example.com',
      addedAt: '2026-01-01T00:00:00Z',
      metadata: { authMode: 'chatgpt', planType: 'plus' },
    });

    const { accountAction } = await import('./account');
    await accountAction({}, makeCmd({ provider: 'codex' }));

    expect(stdoutData).toContain('Codex Accounts');
    expect(stdoutData).toContain('Work');
    expect(stdoutData).toContain('user@example.com');
  });

  it('finds Claude account by email case-insensitively for --remove', async () => {
    mockResolveProviderId.mockReturnValue('claude-code');
    mockListAccounts.mockReturnValue([
      { uuid: 'claude-1', email: 'User@Example.com', label: 'Work', addedAt: '2026-01-01T00:00:00Z' },
    ]);
    mockRemoveAccount.mockReturnValue({ success: true });

    const { accountAction } = await import('./account');
    await accountAction({}, makeCmd({ remove: 'user@example.com' }));

    expect(mockRemoveAccount).toHaveBeenCalledWith('claude-1');
  });
});
