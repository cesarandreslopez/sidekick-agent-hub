/**
 * Status bar item showing the active account, coloured by credential health.
 * Always visible once any account is saved; click opens the account picker.
 */

import * as vscode from 'vscode';
import type { AccountProviderId, AccountView } from 'sidekick-shared';
import { AccountService } from './AccountService';
import { AuthService } from './AuthService';
import { PROVIDER_LABELS, accountDisplayName, describeHealth } from '../commands/accountQuickPick';

export class AccountStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly accountService: AccountService,
    private readonly authService: AuthService,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.statusBarItem.command = 'sidekick.accounts.pick';

    this.disposables.push(
      this.accountService.onAccountChange(() => this.updateDisplay()),
      this.accountService.onAccountsUpdated(() => this.updateDisplay()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('sidekick.inferenceProvider') ||
          event.affectsConfiguration('sidekick.authMode')
        ) {
          this.updateDisplay();
        }
      }),
    );

    this.updateDisplay();
  }

  refresh(): void {
    this.updateDisplay();
  }

  /** The provider Sidekick's own inference uses, when it is a managed one. */
  private preferredProvider(): AccountProviderId | null {
    const providerId = this.authService.getProviderId();
    if (providerId === 'codex') return 'codex';
    if (providerId === 'claude-max') return 'claude-code';
    return null;
  }

  /** The account to show: the inference provider's active account, else Claude, else Codex. */
  pickDisplayAccount(views: AccountView[]): AccountView | null {
    const preferred = this.preferredProvider();
    const order: AccountProviderId[] = preferred
      ? [preferred, ...(['claude-code', 'codex'] as const).filter((p) => p !== preferred)]
      : ['claude-code', 'codex'];
    for (const provider of order) {
      const active = views.find((view) => view.providerId === provider && view.isActive);
      if (active) return active;
    }
    return null;
  }

  private updateDisplay(): void {
    const views = this.accountService.listAccountsWithHealth();
    if (views.length === 0) {
      this.statusBarItem.hide();
      return;
    }
    const shown = this.pickDisplayAccount(views);
    if (!shown) {
      this.statusBarItem.text = '$(account) No active account';
      this.statusBarItem.tooltip = 'Sidekick: choose an account';
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
      return;
    }

    const name = this.abbreviate(accountDisplayName(shown));
    const state = shown.health.state;
    const icon =
      state === 'expired' || state === 'missing'
        ? '$(warning)'
        : state === 'expiring'
          ? '$(clock)'
          : '$(account)';
    this.statusBarItem.text = `${icon} ${name}`;
    this.statusBarItem.backgroundColor =
      state === 'expired' || state === 'missing'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown('**Sidekick accounts**\n\n');
    tooltip.appendMarkdown('| Provider | Active account | Health |\n| --- | --- | --- |\n');
    for (const provider of ['claude-code', 'codex'] as const) {
      const active = views.find((view) => view.providerId === provider && view.isActive);
      if (!active) continue;
      tooltip.appendMarkdown(
        `| ${PROVIDER_LABELS[provider]} | ${accountDisplayName(active)}${active.email && active.email !== accountDisplayName(active) ? ` (${active.email})` : ''} | ${describeHealth(active.health)} |\n`,
      );
    }
    tooltip.appendMarkdown(
      `\n${views.length} account${views.length === 1 ? '' : 's'} saved · click to switch`,
    );
    tooltip.isTrusted = false;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.show();
  }

  private abbreviate(name: string): string {
    const atIdx = name.indexOf('@');
    if (atIdx <= 0) return name.length > 24 ? `${name.slice(0, 21)}…` : name;
    const local = name.slice(0, atIdx);
    const domain = name.slice(atIdx + 1);
    const shortLocal = local.length > 12 ? local.slice(0, 12) + '…' : local;
    return `${shortLocal}@${domain}`;
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
