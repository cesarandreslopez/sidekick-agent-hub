import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSpawnAccountLogin,
  mockListAllAccounts,
  mockSwitchAccountAsync,
  mockSwitchToCodexAccountAsync,
  mockPrepareCodexAccountAsync,
  mockFinalizeCodexAccountAsync,
  mockGetActiveClaudeAccount,
  mockGetActiveCodexAccount,
  mockGetAccountsDir,
} = vi.hoisted(() => ({
  mockSpawnAccountLogin: vi.fn(),
  mockListAllAccounts: vi.fn(),
  mockSwitchAccountAsync: vi.fn(),
  mockSwitchToCodexAccountAsync: vi.fn(),
  mockPrepareCodexAccountAsync: vi.fn(),
  mockFinalizeCodexAccountAsync: vi.fn(),
  mockGetActiveClaudeAccount: vi.fn(),
  mockGetActiveCodexAccount: vi.fn(),
  mockGetAccountsDir: vi.fn(),
}));

vi.mock('vscode', () => ({
  default: {},
  EventEmitter: class<T> {
    private listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  },
}));

vi.mock('sidekick-shared', () => ({
  addCurrentAccount: vi.fn(),
  switchToAccount: vi.fn(),
  removeAccount: vi.fn(),
  listAccounts: vi.fn(() => []),
  getActiveAccount: (...args: unknown[]) => mockGetActiveClaudeAccount(...args),
  resolveActiveClaudeAccount: vi.fn(() => ({ source: 'none' })),
  readActiveClaudeAccount: vi.fn(() => null),
  getAccountsDir: (...args: unknown[]) => mockGetAccountsDir(...args),
  prepareCodexAccountAsync: (...args: unknown[]) => mockPrepareCodexAccountAsync(...args),
  finalizeCodexAccountAsync: (...args: unknown[]) => mockFinalizeCodexAccountAsync(...args),
  switchToCodexAccountAsync: (...args: unknown[]) => mockSwitchToCodexAccountAsync(...args),
  removeCodexAccount: vi.fn(),
  listCodexAccounts: vi.fn(() => []),
  getActiveCodexAccount: (...args: unknown[]) => mockGetActiveCodexAccount(...args),
  resolveActiveCodexAccount: vi.fn(() => ({ source: 'none' })),
  spawnAccountLogin: (...args: unknown[]) => mockSpawnAccountLogin(...args),
  listAllAccounts: (...args: unknown[]) => mockListAllAccounts(...args),
  switchAccountAsync: (...args: unknown[]) => mockSwitchAccountAsync(...args),
}));

vi.mock('./Logger', () => ({
  log: vi.fn(),
}));

import { AccountService } from './AccountService';

describe('AccountService account management 2.0 facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccountsDir.mockReturnValue('/tmp/sidekick/accounts');
    mockGetActiveClaudeAccount.mockReturnValue(null);
    mockGetActiveCodexAccount.mockReturnValue(null);
  });

  it('signs in through the shared login facade and refreshes on success', async () => {
    mockSpawnAccountLogin.mockResolvedValue({ success: true });
    const service = new AccountService();
    const changes: string[] = [];
    service.onAccountChange((provider) => changes.push(provider));
    mockGetActiveClaudeAccount.mockReturnValue({
      uuid: 'claude-1',
      email: 'work@example.com',
      addedAt: '2026-01-01T00:00:00Z',
    });

    const result = await service.signInAccount('claude-code', 'Work');

    expect(result).toEqual({ success: true });
    expect(mockSpawnAccountLogin).toHaveBeenCalledWith('claude-code', 'Work', { stdio: 'inherit' });
    expect(changes).toEqual(['claude-code']);
    service.dispose();
  });

  it('lists all providers through the shared facade', () => {
    mockListAllAccounts.mockReturnValue({
      claude: [],
      codex: [],
      activeByProvider: { 'claude-code': null, codex: null },
    });
    const service = new AccountService();

    expect(service.listAllAccounts()).toEqual({
      claude: [],
      codex: [],
      activeByProvider: { 'claude-code': null, codex: null },
    });
    service.dispose();
  });

  it('switches through the provider-neutral shared wrapper', async () => {
    mockSwitchAccountAsync.mockResolvedValue({ success: true, warning: 'restart sessions' });
    const service = new AccountService();

    await expect(service.switchManagedAccount('codex', 'codex-1')).resolves.toEqual({
      success: true,
      warning: 'restart sessions',
    });
    expect(mockSwitchAccountAsync).toHaveBeenCalledWith('codex', 'codex-1');
    service.dispose();
  });

  it('routes codex save and finalize through the non-blocking shared variants', async () => {
    mockPrepareCodexAccountAsync.mockResolvedValue({ success: true });
    mockFinalizeCodexAccountAsync.mockResolvedValue({ success: true });
    const service = new AccountService();

    await expect(service.addCurrentAccount('codex', 'Work')).resolves.toEqual({ success: true });
    expect(mockPrepareCodexAccountAsync).toHaveBeenCalledWith('Work');
    await expect(service.finalizeCodexAccount('profile-1')).resolves.toEqual({ success: true });
    expect(mockFinalizeCodexAccountAsync).toHaveBeenCalledWith('profile-1');
    service.dispose();
  });

  it('routes codex switches through the non-blocking shared variant', async () => {
    mockSwitchToCodexAccountAsync.mockResolvedValue({ success: true });
    const service = new AccountService();
    const changes: string[] = [];
    service.onAccountChange((provider) => changes.push(provider));
    mockGetActiveCodexAccount.mockReturnValue({ id: 'codex-1', addedAt: '2026-01-01T00:00:00Z' });

    await expect(service.switchToAccount('codex', 'codex-1')).resolves.toEqual({ success: true });
    expect(mockSwitchToCodexAccountAsync).toHaveBeenCalledWith('codex-1');
    expect(changes).toEqual(['codex']);
    service.dispose();
  });
});
