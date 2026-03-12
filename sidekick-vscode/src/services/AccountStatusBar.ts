/**
 * Status bar item showing the active Claude Max account.
 *
 * Only visible when multi-account is enabled (>= 2 accounts).
 * Click opens the account switcher QuickPick.
 */

import * as vscode from 'vscode';
import { AccountService } from './AccountService';

export class AccountStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly accountService: AccountService) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      98 // Between StatusBarManager (100) and MonitorStatusBar (99)
    );
    this.statusBarItem.command = 'sidekick.switchAccount';

    this.disposables.push(
      this.accountService.onAccountChange(() => this.updateDisplay())
    );

    this.updateDisplay();
  }

  private updateDisplay(): void {
    const accounts = this.accountService.listAccounts();

    // Only show when 2+ accounts are managed
    if (accounts.length < 2) {
      this.statusBarItem.hide();
      return;
    }

    const active = this.accountService.getActiveAccount();
    if (!active) {
      this.statusBarItem.hide();
      return;
    }

    const displayName = active.label ?? this.abbreviateEmail(active.email);
    this.statusBarItem.text = `$(account) ${displayName}`;

    const tooltipLines = [
      `Account: ${active.email}`,
    ];
    if (active.label) {
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
    // Show first 12 chars of local part + domain
    const shortLocal = local.length > 12 ? local.slice(0, 12) + '...' : local;
    return `${shortLocal}@${domain}`;
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
