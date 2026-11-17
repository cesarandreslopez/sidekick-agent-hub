import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView } from 'sidekick-shared';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: vi.fn(),
  },
  window: {
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    createTerminal: vi.fn(),
  },
  extensions: { getExtension: () => undefined },
  QuickPickItemKind: { Separator: -1 },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn(), showLog: vi.fn() }));

import * as vscode from 'vscode';
import { registerAccountCommands } from './accountCommands';

function view(id: string, isActive = false): AccountView {
  return {
    id,
    providerId: 'claude-code',
    label: id,
    email: `${id}@example.com`,
    isActive,
    source: 'registered',
    addedAt: '2026-01-01T00:00:00Z',
    health: {
      providerId: 'claude-code',
      accountId: id,
      state: 'fresh',
      checkedAt: Date.now(),
      isLive: isActive,
    },
  } as AccountView;
}

function register(accounts: AccountView[]): void {
  handlers.clear();
  registerAccountCommands({ subscriptions: [] } as never, {
    accountService: {
      listAccountsWithHealth: () => accounts,
      removeAccount: vi.fn(),
    } as never,
    loginRunner: {} as never,
    getInferenceProviderId: () => null,
  });
}

describe('account commands picked from the palette', () => {
  beforeEach(() => {
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.window.showInformationMessage).mockReset();
  });

  it('says nothing when the picker is dismissed', async () => {
    register([view('work', true), view('personal')]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    await handlers.get('sidekick.accounts.remove')!();

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('offers Add Account when no account is saved', async () => {
    register([]);

    await handlers.get('sidekick.accounts.remove')!();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No accounts saved yet.',
      'Add Account…',
    );
  });

  it('says there is no other account to switch to when only the active one is saved', async () => {
    register([view('work', true)]);

    await handlers.get('sidekick.accounts.switch')!();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No other saved account to switch to.',
      'Add Account…',
    );
  });
});
