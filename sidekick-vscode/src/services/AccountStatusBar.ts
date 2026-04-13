/**
 * Status bar item showing the active managed account for the active provider.
 */

import * as vscode from 'vscode';
import type { AccountProviderId } from 'sidekick-shared';
import { AccountService } from './AccountService';
import { AuthService } from './AuthService';

export class AccountStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly accountService: AccountService,
    private readonly authService: AuthService,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      98,
    );
    this.statusBarItem.command = 'sidekick.switchAccount';

    this.disposables.push(
      this.accountService.onAccountChange(() => this.updateDisplay()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('sidekick.inferenceProvider') || event.affectsConfiguration('sidekick.authMode')) {
          this.updateDisplay();
        }
      }),
    );

    this.updateDisplay();
  }

  refresh(): void {
    this.updateDisplay();
  }

  private getActiveManagedProvider(): AccountProviderId | null {
    const providerId = this.authService.getProviderId();
    if (providerId === 'codex') return 'codex';
    if (providerId === 'claude-max') return 'claude-code';
    return null;
  }

  private updateDisplay(): void {
    const providerId = this.getActiveManagedProvider();
    if (!providerId) {
      this.statusBarItem.hide();
      return;
    }

    const accounts = this.accountService.listAccounts(providerId);
    if (accounts.length < 2) {
      this.statusBarItem.hide();
      return;
    }

    const active = this.accountService.getActiveAccount(providerId);
    if (!active) {
      this.statusBarItem.hide();
      return;
    }

    const displayName = providerId === 'codex'
      ? (active.label ?? active.email ?? ('id' in active ? active.id : 'codex'))
      : (active.label ?? this.abbreviateEmail(active.email ?? 'unknown'));

    this.statusBarItem.text = `$(account) ${displayName}`;

    const tooltipLines = [
      `Provider: ${providerId === 'codex' ? 'Codex' : 'Claude Max'}`,
      `Account: ${providerId === 'codex'
        ? (active.label ?? ('id' in active ? active.id : 'codex'))
        : (active.email ?? 'unknown')}`,
    ];
    if (active.email && providerId === 'codex') {
      tooltipLines.push(`Identity: ${active.email}`);
    }
    if (active.label && providerId === 'claude-code') {
      tooltipLines.push(`Label: ${active.label}`);
    }
    tooltipLines.push(`${accounts.length} accounts managed`, '', 'Click to switch account');
    this.statusBarItem.tooltip = tooltipLines.join('\n');

    this.statusBarItem.show();
  }

  private abbreviateEmail(email: string): string {
    const atIdx = email.indexOf('@');
    if (atIdx <= 0) return email;
    const local = email.slice(0, atIdx);
    const domain = email.slice(atIdx + 1);
    const shortLocal = local.length > 12 ? local.slice(0, 12) + '...' : local;
    return `${shortLocal}@${domain}`;
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
