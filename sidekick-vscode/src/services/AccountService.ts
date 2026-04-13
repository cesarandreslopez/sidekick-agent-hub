/**
 * VS Code wrapper around Sidekick account management.
 *
 * Provides provider-aware account operations plus file watching for external
 * registry and Claude credential changes.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  addCurrentAccount as addCurrentClaudeAccount,
  switchToAccount as switchToClaudeAccount,
  removeAccount as removeClaudeAccount,
  listAccounts as listClaudeAccounts,
  getActiveAccount as getActiveClaudeAccount,
  readActiveClaudeAccount,
  getAccountsDir,
  prepareCodexAccount,
  finalizeCodexAccount as finalizeSavedCodexAccount,
  switchToCodexAccount,
  removeCodexAccount,
  listCodexAccounts,
  getActiveCodexAccount,
} from 'sidekick-shared';
import type {
  AccountEntry,
  AccountManagerResult,
  AccountProviderId,
  SavedAccountProfile,
} from 'sidekick-shared';
import { log } from './Logger';

export type ManagedAccount = AccountEntry | SavedAccountProfile;

export function isSavedAccountProfile(account: ManagedAccount): account is SavedAccountProfile {
  return 'providerId' in account;
}

export class AccountService implements vscode.Disposable {
  private readonly _onAccountChange = new vscode.EventEmitter<AccountProviderId>();
  readonly onAccountChange = this._onAccountChange.event;

  private registryWatcher: fs.FSWatcher | null = null;
  private credentialsWatcher: fs.FSWatcher | null = null;
  private lastKnownActiveIds: Record<AccountProviderId, string | null> = {
    'claude-code': null,
    codex: null,
  };

  constructor() {
    this.lastKnownActiveIds['claude-code'] = getActiveClaudeAccount()?.uuid ?? readActiveClaudeAccount()?.uuid ?? null;
    this.lastKnownActiveIds.codex = getActiveCodexAccount()?.id ?? null;
    this.startWatching();
  }

  addCurrentAccount(providerId: AccountProviderId, label?: string): AccountManagerResult {
    const result = providerId === 'claude-code'
      ? addCurrentClaudeAccount(label)
      : prepareCodexAccount(label ?? '');

    if (result.success) {
      this.refresh();
    }
    return result;
  }

  finalizeCodexAccount(profileId: string): AccountManagerResult {
    const result = finalizeSavedCodexAccount(profileId);
    if (result.success) {
      this.refresh();
    }
    return result;
  }

  switchToAccount(providerId: AccountProviderId, accountId: string): AccountManagerResult {
    const result = providerId === 'claude-code'
      ? switchToClaudeAccount(accountId)
      : switchToCodexAccount(accountId);

    if (result.success) {
      this.refresh();
    }
    return result;
  }

  removeAccount(providerId: AccountProviderId, accountId: string): AccountManagerResult {
    const result = providerId === 'claude-code'
      ? removeClaudeAccount(accountId)
      : removeCodexAccount(accountId);

    if (result.success) {
      this.refresh();
    }
    return result;
  }

  listAccounts(providerId: 'claude-code'): AccountEntry[];
  listAccounts(providerId: 'codex'): SavedAccountProfile[];
  listAccounts(providerId: AccountProviderId): ManagedAccount[];
  listAccounts(providerId: AccountProviderId): ManagedAccount[] {
    return providerId === 'claude-code'
      ? listClaudeAccounts()
      : listCodexAccounts();
  }

  getActiveAccount(providerId: 'claude-code'): AccountEntry | null;
  getActiveAccount(providerId: 'codex'): SavedAccountProfile | null;
  getActiveAccount(providerId: AccountProviderId): ManagedAccount | null;
  getActiveAccount(providerId: AccountProviderId): ManagedAccount | null {
    return providerId === 'claude-code'
      ? getActiveClaudeAccount()
      : getActiveCodexAccount();
  }

  isMultiAccountEnabled(providerId: AccountProviderId): boolean {
    return this.listAccounts(providerId).length >= 2;
  }

  refresh(): void {
    const currentIds: Record<AccountProviderId, string | null> = {
      'claude-code': getActiveClaudeAccount()?.uuid ?? readActiveClaudeAccount()?.uuid ?? null,
      codex: getActiveCodexAccount()?.id ?? null,
    };

    for (const providerId of ['claude-code', 'codex'] as const) {
      if (currentIds[providerId] !== this.lastKnownActiveIds[providerId]) {
        this.lastKnownActiveIds[providerId] = currentIds[providerId];
        this._onAccountChange.fire(providerId);
        log(`AccountService: active ${providerId} account changed to ${currentIds[providerId] ?? 'none'}`);
      }
    }
  }

  private startWatching(): void {
    try {
      const registryPath = path.join(getAccountsDir(), 'accounts.json');
      const registryDir = path.dirname(registryPath);
      if (fs.existsSync(registryDir)) {
        this.registryWatcher = fs.watch(registryDir, (_event, filename) => {
          if (filename === 'accounts.json') {
            this.refresh();
          }
        });
      }
    } catch (err) {
      log(`AccountService: could not watch accounts dir: ${err}`);
    }

    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      if (fs.existsSync(claudeDir)) {
        this.credentialsWatcher = fs.watch(claudeDir, (_event, filename) => {
          if (filename === '.credentials.json' || filename === '.claude.json') {
            setTimeout(() => this.refresh(), 500);
          }
        });
      }
    } catch (err) {
      log(`AccountService: could not watch claude dir: ${err}`);
    }
  }

  dispose(): void {
    this.registryWatcher?.close();
    this.credentialsWatcher?.close();
    this._onAccountChange.dispose();
  }
}
