/**
 * @fileoverview Tree view of saved Claude Code and Codex accounts with their
 * credential health. Root level: one group per provider; children: accounts.
 *
 * @module providers/AccountTreeProvider
 */

import * as vscode from 'vscode';
import type { AccountProviderId, AccountView } from 'sidekick-shared';
import type { AccountService } from '../services/AccountService';
import { PROVIDER_LABELS, accountDisplayName, describeHealth } from '../commands/accountQuickPick';
import { log } from '../services/Logger';

export type AccountTreeElement = ProviderGroupItem | AccountItem;

export interface ProviderGroupItem {
  kind: 'group';
  providerId: AccountProviderId;
  accounts: AccountView[];
}

export interface AccountItem {
  kind: 'account';
  view: AccountView;
}

const HINT_MESSAGE =
  'Select the arrows icon on an account to switch. Expired accounts need Sign In Again.';

export class AccountTreeProvider
  implements vscode.TreeDataProvider<AccountTreeElement>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    AccountTreeElement | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _treeView: vscode.TreeView<AccountTreeElement> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly accountService: AccountService) {
    this.disposables.push(this.accountService.onAccountChange(() => this.refresh()));
    this.disposables.push(this.accountService.onAccountsUpdated(() => this.refresh()));
    log('AccountTreeProvider initialized');
  }

  setTreeView(treeView: vscode.TreeView<AccountTreeElement>): void {
    this._treeView = treeView;
    this.updateDecorations();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
    this.updateDecorations();
  }

  getTreeItem(element: AccountTreeElement): vscode.TreeItem {
    if (element.kind === 'group') {
      const active = element.accounts.find((view) => view.isActive);
      const item = new vscode.TreeItem(
        PROVIDER_LABELS[element.providerId],
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `${element.accounts.length} account${element.accounts.length === 1 ? '' : 's'}${active ? ` · ${accountDisplayName(active)} active` : ''}`;
      item.iconPath = new vscode.ThemeIcon('organization');
      item.contextValue = 'accountGroup';
      item.id = `group:${element.providerId}`;
      return item;
    }

    const { view } = element;
    const name = accountDisplayName(view);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    const descriptionParts = [
      view.isActive ? '(current)' : undefined,
      view.email && view.email !== name ? view.email : undefined,
      view.planType,
      describeHealth(view.health),
    ].filter(Boolean);
    item.description = descriptionParts.join(' · ');
    item.iconPath = this.iconFor(view);
    item.tooltip = this.buildTooltip(view);
    item.id = `${view.providerId}:${view.id}`;
    item.contextValue =
      view.health.state === 'expired' || view.health.state === 'missing'
        ? 'account.expired'
        : view.isActive
          ? 'account.active'
          : 'account.inactive';
    return item;
  }

  getChildren(element?: AccountTreeElement): AccountTreeElement[] {
    if (!element) {
      const views = this.accountService.listAccountsWithHealth();
      const groups: ProviderGroupItem[] = [];
      for (const providerId of ['claude-code', 'codex'] as const) {
        const accounts = views.filter((view) => view.providerId === providerId);
        if (accounts.length > 0) groups.push({ kind: 'group', providerId, accounts });
      }
      return groups;
    }
    if (element.kind === 'group') {
      return element.accounts.map((view) => ({ kind: 'account', view }));
    }
    return [];
  }

  private iconFor(view: AccountView): vscode.ThemeIcon {
    switch (view.health.state) {
      case 'expired':
      case 'missing':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      case 'expiring':
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
      case 'unknown':
        return new vscode.ThemeIcon('question');
      default:
        return view.isActive
          ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('account');
    }
  }

  private buildTooltip(view: AccountView): vscode.MarkdownString {
    const lines = [
      `**${accountDisplayName(view)}** — ${PROVIDER_LABELS[view.providerId]}${view.isActive ? ' (current)' : ''}`,
      '',
      view.email ? `Email: ${view.email}` : undefined,
      view.planType ? `Plan: ${view.planType}` : undefined,
      `Health: ${describeHealth(view.health)}`,
      view.health.accessExpiresAt
        ? `Access token expires: ${new Date(view.health.accessExpiresAt).toLocaleString()}`
        : undefined,
      view.health.refreshExpiresAt
        ? `Refresh token expires: ${new Date(view.health.refreshExpiresAt).toLocaleString()}${view.health.refreshExpiryEstimated ? ' (estimated)' : ''}`
        : undefined,
      view.health.lastRefreshAt
        ? `Last refreshed: ${new Date(view.health.lastRefreshAt).toLocaleString()}`
        : undefined,
      view.source === 'learned' ? '' : undefined,
      view.source === 'learned' ? '_Registered automatically from your live login._' : undefined,
    ].filter((line): line is string => line !== undefined);
    const md = new vscode.MarkdownString(lines.join('\n\n'));
    md.isTrusted = false;
    return md;
  }

  private updateDecorations(): void {
    if (!this._treeView) return;
    const views = this.accountService.listAccountsWithHealth();
    const expired = views.filter(
      (view) => view.health.state === 'expired' || view.health.state === 'missing',
    ).length;
    this._treeView.message = views.length > 0 ? HINT_MESSAGE : undefined;
    this._treeView.badge = expired
      ? { value: expired, tooltip: `${expired} expired account${expired === 1 ? '' : 's'}` }
      : undefined;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
