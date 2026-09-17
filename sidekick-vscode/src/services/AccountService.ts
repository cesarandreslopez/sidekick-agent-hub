/**
 * VS Code wrapper around Sidekick account management.
 *
 * Provides provider-aware account operations, health-annotated listings,
 * verified switching with undo, and change notification driven by the shared
 * account watcher (which also folds external `claude /login` / `codex login`
 * runs into the saved profiles).
 */

import * as vscode from 'vscode';
import {
  addCurrentAccount as addCurrentClaudeAccount,
  switchToAccountAsync as switchToClaudeAccountAsync,
  removeAccount as removeClaudeAccount,
  listAccounts as listClaudeAccounts,
  getActiveAccount as getActiveClaudeAccount,
  resolveActiveClaudeAccount,
  readActiveClaudeAccount,
  prepareCodexAccountAsync,
  finalizeCodexAccountAsync,
  switchToCodexAccountAsync,
  removeCodexAccount,
  listCodexAccounts,
  getActiveCodexAccount,
  resolveActiveCodexAccount,
  spawnAccountLogin,
  listAllAccounts as listAllManagedAccounts,
  listAccountsWithHealth,
  switchAccountAsync,
  undoLastSwitch,
  getLastSwitch,
  getAccountLaunchEnv,
  syncLiveAccountState,
  refreshInactiveAccounts,
  onAccountsChanged,
} from 'sidekick-shared';
import type {
  AccountEntry,
  AccountLaunchEnv,
  AccountManagerResult,
  AccountProviderId,
  AccountView,
  ListAllAccountsResult,
  RefreshInactiveAccountsResult,
  SavedAccountProfile,
  SwitchAccountOptions,
  SwitchAccountResult,
  SyncReport,
} from 'sidekick-shared';
import { log } from './Logger';

export type ManagedAccount = AccountEntry | SavedAccountProfile;

export function isSavedAccountProfile(account: ManagedAccount): account is SavedAccountProfile {
  return 'providerId' in account;
}

const UNDO_CONTEXT_KEY = 'sidekick.accounts.canUndo';

export class AccountService implements vscode.Disposable {
  /** Fires when the active account of a provider changes. */
  private readonly _onAccountChange = new vscode.EventEmitter<AccountProviderId>();
  readonly onAccountChange = this._onAccountChange.event;

  /** Fires on any registry or health change (new accounts, refreshed tokens). */
  private readonly _onAccountsUpdated = new vscode.EventEmitter<void>();
  readonly onAccountsUpdated = this._onAccountsUpdated.event;

  private subscription: { dispose(): void } | null = null;
  private lastKnownActiveIds: Record<AccountProviderId, string | null> = {
    'claude-code': null,
    codex: null,
  };
  private undoTokens: Record<AccountProviderId, string | undefined> = {
    'claude-code': undefined,
    codex: undefined,
  };

  constructor() {
    // Self-heal the saved active pointer to the live login before snapshotting ids.
    resolveActiveClaudeAccount();
    resolveActiveCodexAccount();
    this.lastKnownActiveIds['claude-code'] =
      getActiveClaudeAccount()?.uuid ?? readActiveClaudeAccount()?.uuid ?? null;
    this.lastKnownActiveIds.codex = getActiveCodexAccount()?.id ?? null;
    this.startWatching();
    void this.updateUndoContext();
  }

  // ── Listing ────────────────────────────────────────────────────────────

  listAccountsWithHealth(providerId?: AccountProviderId): AccountView[] {
    try {
      return listAccountsWithHealth(providerId);
    } catch (err) {
      log(`AccountService: listAccountsWithHealth failed: ${err}`);
      return [];
    }
  }

  listAllAccounts(): ListAllAccountsResult {
    return listAllManagedAccounts();
  }

  listAccounts(providerId: 'claude-code'): AccountEntry[];
  listAccounts(providerId: 'codex'): SavedAccountProfile[];
  listAccounts(providerId: AccountProviderId): ManagedAccount[];
  listAccounts(providerId: AccountProviderId): ManagedAccount[] {
    return providerId === 'claude-code' ? listClaudeAccounts() : listCodexAccounts();
  }

  getActiveAccount(providerId: 'claude-code'): AccountEntry | null;
  getActiveAccount(providerId: 'codex'): SavedAccountProfile | null;
  getActiveAccount(providerId: AccountProviderId): ManagedAccount | null;
  getActiveAccount(providerId: AccountProviderId): ManagedAccount | null {
    // Self-heal to the live login first, then return the (now-correct) saved profile.
    if (providerId === 'claude-code') {
      resolveActiveClaudeAccount();
      return getActiveClaudeAccount();
    }
    resolveActiveCodexAccount();
    return getActiveCodexAccount();
  }

  isMultiAccountEnabled(providerId: AccountProviderId): boolean {
    return this.listAccounts(providerId).length >= 2;
  }

  // ── Sync ───────────────────────────────────────────────────────────────

  /** Fold live logins into the registry; returns what was learned. */
  async sync(): Promise<SyncReport> {
    const report = await syncLiveAccountState({ reason: 'manual' });
    this.refresh();
    this._onAccountsUpdated.fire();
    return report;
  }

  // ── Mutations ──────────────────────────────────────────────────────────

  async addCurrentAccount(
    providerId: AccountProviderId,
    label?: string,
  ): Promise<AccountManagerResult> {
    // The codex path probes the CLI; the async variant keeps those probes
    // off the extension host's event loop.
    const result =
      providerId === 'claude-code'
        ? addCurrentClaudeAccount(label)
        : await prepareCodexAccountAsync(label ?? '');

    if (result.success) this.refresh();
    return result;
  }

  async finalizeCodexAccount(profileId: string): Promise<AccountManagerResult> {
    const result = await finalizeCodexAccountAsync(profileId);
    if (result.success) this.refresh();
    return result;
  }

  async signInAccount(providerId: AccountProviderId, label: string): Promise<AccountManagerResult> {
    const result = await spawnAccountLogin(providerId, label, { stdio: 'inherit' });
    if (result.success) this.refresh();
    return result;
  }

  /** Verified switch; remembers the undo token for the provider. */
  async switch(
    providerId: AccountProviderId,
    accountId: string,
    options: SwitchAccountOptions = {},
  ): Promise<SwitchAccountResult> {
    const result = await switchAccountAsync(providerId, accountId, options);
    if (result.success) {
      if (result.undoToken) this.undoTokens[providerId] = result.undoToken;
      this.refresh();
      await this.updateUndoContext();
    }
    return result;
  }

  async switchManagedAccount(
    providerId: AccountProviderId,
    accountId: string,
  ): Promise<SwitchAccountResult> {
    return this.switch(providerId, accountId);
  }

  async switchToAccount(
    providerId: AccountProviderId,
    accountId: string,
  ): Promise<SwitchAccountResult> {
    const result =
      providerId === 'claude-code'
        ? await switchToClaudeAccountAsync(accountId)
        : await switchToCodexAccountAsync(accountId);
    if (result.success) {
      if (result.undoToken) this.undoTokens[providerId] = result.undoToken;
      this.refresh();
      await this.updateUndoContext();
    }
    return result;
  }

  canUndo(providerId?: AccountProviderId): boolean {
    const providers: AccountProviderId[] = providerId ? [providerId] : ['claude-code', 'codex'];
    return providers.some((provider) => getLastSwitch(provider) !== null);
  }

  /** Provider whose last switch would be undone (the most recent record). */
  undoProvider(): AccountProviderId | null {
    const records = (['claude-code', 'codex'] as const)
      .map((provider) => ({ provider, record: getLastSwitch(provider) }))
      .filter((entry) => entry.record !== null)
      .sort((a, b) => Date.parse(b.record!.at) - Date.parse(a.record!.at));
    return records[0]?.provider ?? null;
  }

  async undo(providerId?: AccountProviderId): Promise<SwitchAccountResult | null> {
    const provider = providerId ?? this.undoProvider();
    if (!provider) return null;
    const result = await undoLastSwitch(provider, this.undoTokens[provider]);
    if (result.success) {
      this.undoTokens[provider] = result.undoToken;
      this.refresh();
    }
    await this.updateUndoContext();
    return result;
  }

  removeAccount(providerId: AccountProviderId, accountId: string): AccountManagerResult {
    const result =
      providerId === 'claude-code' ? removeClaudeAccount(accountId) : removeCodexAccount(accountId);
    if (result.success) {
      this.refresh();
      this._onAccountsUpdated.fire();
    }
    return result;
  }

  launchEnv(providerId: AccountProviderId, accountId: string): AccountLaunchEnv {
    return getAccountLaunchEnv(providerId, accountId);
  }

  async refreshInactive(): Promise<RefreshInactiveAccountsResult> {
    const result = await refreshInactiveAccounts();
    if (result.refreshed.length > 0) this._onAccountsUpdated.fire();
    return result;
  }

  // ── Change detection ───────────────────────────────────────────────────

  /** Re-check the active pointers and tell every account surface to re-render. */
  notifyUpdated(): void {
    this.refresh();
    this._onAccountsUpdated.fire();
  }

  refresh(): void {
    // Reconcile the saved active pointer with the live login before diffing ids,
    // so an external `claude /login` / `codex login` is detected as a change.
    resolveActiveClaudeAccount();
    resolveActiveCodexAccount();
    const currentIds: Record<AccountProviderId, string | null> = {
      'claude-code': getActiveClaudeAccount()?.uuid ?? readActiveClaudeAccount()?.uuid ?? null,
      codex: getActiveCodexAccount()?.id ?? null,
    };

    for (const providerId of ['claude-code', 'codex'] as const) {
      if (currentIds[providerId] !== this.lastKnownActiveIds[providerId]) {
        this.lastKnownActiveIds[providerId] = currentIds[providerId];
        this._onAccountChange.fire(providerId);
        log(
          `AccountService: active ${providerId} account changed to ${currentIds[providerId] ?? 'none'}`,
        );
      }
    }
  }

  private async updateUndoContext(): Promise<void> {
    try {
      await vscode.commands.executeCommand('setContext', UNDO_CONTEXT_KEY, this.canUndo());
    } catch {
      /* context keys are cosmetic */
    }
  }

  private startWatching(): void {
    try {
      // The shared watcher covers the registry, the live Claude home, and the
      // Codex home, and syncs external logins into the saved profiles before
      // reporting. Local mutations reach us through the same channel.
      this.subscription = onAccountsChanged(() => {
        this.refresh();
        this._onAccountsUpdated.fire();
        void this.updateUndoContext();
      });
    } catch (err) {
      log(`AccountService: could not watch account state: ${err}`);
    }
  }

  dispose(): void {
    this.subscription?.dispose();
    this._onAccountChange.dispose();
    this._onAccountsUpdated.dispose();
  }
}
