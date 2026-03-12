/**
 * VS Code wrapper around sidekick-shared account management.
 *
 * Provides EventEmitter for account changes and file watching
 * to detect external switches (CLI, another VS Code window, `claude login`).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  addCurrentAccount,
  switchToAccount,
  removeAccount,
  listAccounts,
  getActiveAccount,
  isMultiAccountEnabled,
  readActiveClaudeAccount,
  getAccountsDir,
} from 'sidekick-shared';
import type { AccountEntry, AccountManagerResult } from 'sidekick-shared';
import { log } from './Logger';

export class AccountService implements vscode.Disposable {
  private readonly _onAccountChange = new vscode.EventEmitter<AccountEntry | null>();
  readonly onAccountChange = this._onAccountChange.event;

  private registryWatcher: fs.FSWatcher | null = null;
  private credentialsWatcher: fs.FSWatcher | null = null;
  private lastKnownUuid: string | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.lastKnownUuid = getActiveAccount()?.uuid ?? null;
    this.startWatching();
  }

  addCurrentAccount(label?: string): AccountManagerResult {
    const result = addCurrentAccount(label);
    if (result.success) {
      this.refresh();
    }
    return result;
  }

  switchToAccount(uuid: string): AccountManagerResult {
    const result = switchToAccount(uuid);
    if (result.success) {
      this.refresh();
    }
    return result;
  }

  removeAccount(uuid: string): AccountManagerResult {
    const result = removeAccount(uuid);
    if (result.success) {
      this.refresh();
    }
    return result;
  }

  listAccounts(): AccountEntry[] {
    return listAccounts();
  }

  getActiveAccount(): AccountEntry | null {
    return getActiveAccount();
  }

  isMultiAccountEnabled(): boolean {
    return isMultiAccountEnabled();
  }

  refresh(): void {
    const current = getActiveAccount();
    const currentUuid = current?.uuid ?? readActiveClaudeAccount()?.uuid ?? null;
    if (currentUuid !== this.lastKnownUuid) {
      this.lastKnownUuid = currentUuid;
      this._onAccountChange.fire(current);
      log(`AccountService: active account changed to ${current?.email ?? 'none'}`);
    }
  }

  private startWatching(): void {
    // Watch accounts.json for external changes
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

    // Watch ~/.claude/ for `claude login` with new account (Linux/Windows only).
    // On macOS, Claude Code stores credentials in the system Keychain, so file
    // watchers cannot detect external credential changes. Users must manually
    // save new accounts via "Save Current Claude Account" after `claude login`.
    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      if (fs.existsSync(claudeDir)) {
        this.credentialsWatcher = fs.watch(claudeDir, (_event, filename) => {
          if (filename === '.credentials.json' || filename === '.claude.json') {
            // Debounce slightly — both files may change in quick succession
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
    this.disposables.forEach(d => d.dispose());
  }
}
