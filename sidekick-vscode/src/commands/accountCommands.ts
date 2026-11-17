/**
 * Account commands: tree-view actions, the curated quick pick, sign-in flows,
 * terminal-as-account, undo, and the legacy command ids kept as aliases.
 * Account management is provider-agnostic; only Sidekick's own inference
 * client cares which provider switched (handled by the caller).
 */

import * as vscode from 'vscode';
import { describeAccountConsumer } from 'sidekick-shared';
import type { AccountProviderId, AccountView, SwitchAccountResult } from 'sidekick-shared';
import type { AccountService } from '../services/AccountService';
import type { AccountLoginRunner } from '../services/AccountLoginRunner';
import type { AccountTreeElement } from '../providers/AccountTreeProvider';
import { log, showLog } from '../services/Logger';
import {
  PROVIDER_LABELS,
  accountDisplayName,
  buildAccountQuickPickItems,
  buildSwitchSummary,
  describeHealth,
  healthIcon,
  type AccountQuickPickItem,
} from './accountQuickPick';

export interface AccountCommandDeps {
  accountService: AccountService;
  loginRunner: AccountLoginRunner;
  /** Sidekick's inference provider id, for the "inference uses X" hint. */
  getInferenceProviderId: () => string | null;
}

const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

function viewFromElement(element: unknown): AccountView | null {
  const candidate = element as AccountTreeElement | AccountView | undefined;
  if (!candidate || typeof candidate !== 'object') return null;
  if ('kind' in candidate) return candidate.kind === 'account' ? candidate.view : null;
  return 'providerId' in candidate && 'health' in candidate ? candidate : null;
}

export function registerAccountCommands(
  context: vscode.ExtensionContext,
  deps: AccountCommandDeps,
): void {
  const { accountService, loginRunner } = deps;

  /**
   * Asks which account to act on. `reason` says why there is no `view`: the
   * user dismissed the picker (say nothing), no account is saved at all, or
   * accounts exist but none fits this command (e.g. no other one to switch to).
   */
  const pickAccount = async (
    placeHolder: string,
    filter: (view: AccountView) => boolean = () => true,
  ): Promise<{ view?: AccountView; reason?: 'cancelled' | 'none' | 'filtered' }> => {
    const all = accountService.listAccountsWithHealth();
    const views = all.filter(filter);
    if (views.length === 0) return { reason: all.length === 0 ? 'none' : 'filtered' };
    const items = views.map((view) => ({
      label: `${healthIcon(view)} ${accountDisplayName(view)}`,
      description: `${PROVIDER_LABELS[view.providerId]}${view.email && view.email !== accountDisplayName(view) ? ` · ${view.email}` : ''}${view.isActive ? ' (current)' : ''}`,
      detail: describeHealth(view.health),
      view,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder,
      matchOnDescription: true,
    });
    return picked ? { view: picked.view } : { reason: 'cancelled' };
  };

  const extensionHostRunning = (providerId: AccountProviderId): boolean =>
    providerId === 'claude-code' &&
    Boolean(vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID)?.isActive);

  const logDetails = (title: string, details: string[]): void => {
    log(`[accounts] ${title}`);
    for (const line of details) log(`[accounts]   ${line}`);
  };

  const announceSwitch = async (result: SwitchAccountResult, targetName: string): Promise<void> => {
    if (extensionHostRunning(result.provider) && result.success && !result.alreadyActive) {
      result = {
        ...result,
        runningConsumers: [
          ...result.runningConsumers,
          describeAccountConsumer('vscode-extension-host'),
        ],
      };
    }
    const summary = buildSwitchSummary(result, targetName, {
      extensionHostRunning: extensionHostRunning(result.provider),
    });
    const inference = deps.getInferenceProviderId();
    const managed =
      inference === 'codex' ? 'codex' : inference === 'claude-max' ? 'claude-code' : null;
    if (result.success && !result.alreadyActive && managed !== result.provider) {
      summary.details.push(
        `Sidekick inference uses ${inference ?? 'auto'}; change it with "Sidekick: Switch Inference Provider".`,
      );
    }
    logDetails(summary.message, summary.details);
    const show =
      summary.severity === 'error'
        ? vscode.window.showErrorMessage
        : summary.severity === 'warning'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    const action = await show(summary.message, ...summary.actions);
    if (action === 'Undo') {
      const undone = await accountService.undo(result.provider);
      if (undone) await announceSwitch(undone, nameForId(undone.provider, undone.accountId));
    } else if (action === 'Details') {
      showLog();
    } else if (action === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else if (action === 'Sign In Again') {
      await signInAgain(result.provider, result.accountId);
    }
  };

  const nameForId = (providerId: AccountProviderId, accountId: string): string => {
    const view = accountService.listAccountsWithHealth(providerId).find((v) => v.id === accountId);
    return view ? accountDisplayName(view) : accountId;
  };

  const switchTo = async (view: AccountView): Promise<void> => {
    if (view.health.state === 'expired' || view.health.state === 'missing') {
      await signInAgain(view.providerId, view.id);
      return;
    }
    const result = await accountService.switch(view.providerId, view.id);
    await announceSwitch(result, accountDisplayName(view));
  };

  const signInAgain = async (providerId: AccountProviderId, accountId: string): Promise<void> => {
    const view = accountService.listAccountsWithHealth(providerId).find((v) => v.id === accountId);
    if (!view) return;
    const run = await loginRunner.run(providerId, view.label ?? '', {
      existingAccountId: view.id,
      activate: view.isActive || view.health.isLive,
    });
    await reportLogin(
      run.outcome,
      run.error,
      accountDisplayName(view),
      providerId,
      run.result?.profileId ?? view.id,
      false,
    );
  };

  const reportLogin = async (
    outcome: 'saved' | 'cancelled' | 'timeout' | 'failed',
    error: string | undefined,
    label: string,
    providerId: AccountProviderId,
    accountId: string | undefined,
    offerSwitch: boolean,
  ): Promise<void> => {
    accountService.refresh();
    switch (outcome) {
      case 'saved': {
        const saved =
          (accountId &&
            accountService.listAccountsWithHealth(providerId).find((v) => v.id === accountId)) ??
          accountService.listAccountsWithHealth(providerId).find((v) => v.health.isLive) ??
          null;
        const name = saved ? accountDisplayName(saved) : label || 'account';
        if (offerSwitch && saved && !saved.isActive) {
          const action = await vscode.window.showInformationMessage(
            `Account "${name}" saved.`,
            'Switch Now',
          );
          if (action === 'Switch Now') await switchTo(saved);
        } else {
          vscode.window.showInformationMessage(`Account "${name}" saved.`);
        }
        return;
      }
      case 'cancelled':
        vscode.window.showInformationMessage('Sign-in cancelled — nothing was saved.');
        return;
      case 'timeout':
        vscode.window.showErrorMessage(
          `Sign-in timed out before authentication completed. Nothing was saved; run "Sidekick: ${
            offerSwitch ? 'Add Account…' : 'Sign In Again to Account…'
          }" to try again.`,
        );
        return;
      default:
        vscode.window.showErrorMessage(`Sign-in failed: ${error ?? 'unknown error'}`);
    }
  };

  const addAccount = async (preferred?: AccountProviderId): Promise<void> => {
    let providerId = preferred;
    if (!providerId) {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: '$(sparkle) Claude Code',
            description: 'claude auth login in an isolated profile',
            providerId: 'claude-code' as const,
          },
          {
            label: '$(terminal) Codex',
            description: 'codex login in an isolated profile',
            providerId: 'codex' as const,
          },
        ],
        { placeHolder: 'Which provider do you want to add an account for?' },
      );
      if (!pick) return;
      providerId = pick.providerId;
    }
    const label = await vscode.window.showInputBox({
      prompt: `Label for the new ${PROVIDER_LABELS[providerId]} account`,
      placeHolder: 'Work, Personal, Client — leave empty to use the signed-in email',
      ignoreFocusOut: true,
    });
    if (label === undefined) return;
    // The sign-in's own progress notification says where to finish it.
    const run = await loginRunner.run(providerId, label.trim(), { activate: false });
    await reportLogin(
      run.outcome,
      run.error,
      label.trim(),
      providerId,
      run.result?.profileId,
      true,
    );
  };

  const openTerminalAs = async (view: AccountView): Promise<void> => {
    const launch = accountService.launchEnv(view.providerId, view.id);
    if (launch.error) {
      const action = await vscode.window.showErrorMessage(launch.error, 'Sign In Again');
      if (action) await signInAgain(view.providerId, view.id);
      return;
    }
    if (launch.warnings.length > 0) vscode.window.showWarningMessage(launch.warnings.join(' '));
    const env: Record<string, string | null> = { ...launch.env };
    for (const name of launch.envUnset) env[name] = null;
    const terminal = vscode.window.createTerminal({
      name: `${launch.command} · ${accountDisplayName(view)}`,
      env,
      message: `${launch.command} in this terminal uses ${accountDisplayName(view)}${view.email && view.email !== accountDisplayName(view) ? ` (${view.email})` : ''}.`,
    });
    terminal.show();
  };

  const removeAccount = async (view: AccountView): Promise<void> => {
    const confirm = await vscode.window.showWarningMessage(
      `Remove ${PROVIDER_LABELS[view.providerId]} account "${accountDisplayName(view)}"? This deletes its saved credentials.`,
      { modal: true },
      'Remove',
    );
    if (confirm !== 'Remove') return;
    const result = accountService.removeAccount(view.providerId, view.id);
    if (result.success) {
      vscode.window.showInformationMessage(`Removed ${accountDisplayName(view)}.`);
    } else {
      vscode.window.showErrorMessage(`Failed to remove account: ${result.error}`);
    }
  };

  const undo = async (): Promise<void> => {
    const result = await accountService.undo();
    if (!result) {
      vscode.window.showInformationMessage('There is no account switch to undo.');
      return;
    }
    await announceSwitch(result, nameForId(result.provider, result.accountId));
  };

  const refresh = async (): Promise<void> => {
    const report = await accountService.sync();
    const registered = [report.claude.registered, report.codex.registered]
      .filter((entry): entry is { id: string; email?: string } => Boolean(entry))
      .map((entry) => entry.email ?? entry.id);
    const warnings = [...report.claude.warnings, ...report.codex.warnings];
    if (registered.length) {
      vscode.window.showInformationMessage(`Registered ${registered.join(', ')}.`);
    } else if (warnings.length) {
      vscode.window.showWarningMessage(warnings[0]);
    }
  };

  const pick = async (): Promise<void> => {
    const views = accountService.listAccountsWithHealth();
    const items = buildAccountQuickPickItems(views, { canUndo: accountService.canUndo() });
    const picked = await vscode.window.showQuickPick(
      items.map((item) =>
        item.kind === -1
          ? { label: item.label, kind: vscode.QuickPickItemKind.Separator }
          : {
              label: item.label,
              description: item.description,
              detail: item.detail,
              alwaysShow: item.alwaysShow,
              item,
            },
      ),
      {
        placeHolder: views.length ? 'Switch account' : 'No accounts saved yet',
        matchOnDescription: true,
      },
    );
    const item = (picked as { item?: AccountQuickPickItem } | undefined)?.item;
    if (!item?.action) return;
    switch (item.action.kind) {
      case 'account':
        // An expired or missing login gets the sign-in its row promises, even
        // when it is the active account.
        if (
          item.action.view.health.state === 'expired' ||
          item.action.view.health.state === 'missing'
        ) {
          await switchTo(item.action.view);
        } else if (item.action.view.isActive) {
          vscode.window.showInformationMessage(
            `${accountDisplayName(item.action.view)} is already the active account.`,
          );
        } else {
          await switchTo(item.action.view);
        }
        return;
      case 'add':
        await addAccount();
        return;
      case 'terminal': {
        const { view } = await pickAccount('Open a terminal as which account?');
        if (view) await openTerminalAs(view);
        return;
      }
      case 'signInAgain': {
        const { view } = await pickAccount('Sign in again to which account?');
        if (view) await signInAgain(view.providerId, view.id);
        return;
      }
      case 'undo':
        await undo();
        return;
      case 'openView':
        await vscode.commands.executeCommand('sidekick.accounts.focus');
        return;
    }
  };

  const withView =
    (
      placeHolder: string,
      handler: (view: AccountView) => Promise<void>,
      filter?: (view: AccountView) => boolean,
      filteredMessage = 'No saved account fits this action.',
    ) =>
    async (element?: unknown): Promise<void> => {
      const fromView = viewFromElement(element);
      if (fromView) {
        await handler(fromView);
        return;
      }
      const { view, reason } = await pickAccount(placeHolder, filter);
      if (view) {
        await handler(view);
        return;
      }
      // Escape in the picker is not "no accounts": say nothing.
      if (reason === 'cancelled') return;
      const action = await vscode.window.showInformationMessage(
        reason === 'none' ? 'No accounts saved yet.' : filteredMessage,
        'Add Account…',
      );
      if (action) await addAccount();
    };

  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.accounts.pick', pick),
    vscode.commands.registerCommand('sidekick.accounts.add', () => addAccount()),
    vscode.commands.registerCommand(
      'sidekick.accounts.switch',
      withView(
        'Switch to which account?',
        switchTo,
        (view) => !view.isActive,
        'No other saved account to switch to.',
      ),
    ),
    vscode.commands.registerCommand(
      'sidekick.accounts.signInAgain',
      withView('Sign in again to which account?', (view) => signInAgain(view.providerId, view.id)),
    ),
    vscode.commands.registerCommand(
      'sidekick.accounts.openTerminal',
      withView('Open a terminal as which account?', openTerminalAs),
    ),
    vscode.commands.registerCommand(
      'sidekick.accounts.remove',
      withView('Remove which account?', removeAccount),
    ),
    vscode.commands.registerCommand('sidekick.accounts.undo', undo),
    vscode.commands.registerCommand('sidekick.accounts.refresh', refresh),
    vscode.commands.registerCommand('sidekick.accounts.showDetails', () => showLog()),
    vscode.commands.registerCommand('sidekick.accounts.registerCurrent', refresh),
    // Legacy ids kept for keybindings and docs.
    vscode.commands.registerCommand('sidekick.switchAccount', pick),
    vscode.commands.registerCommand('sidekick.switchAnyAccount', pick),
    vscode.commands.registerCommand('sidekick.signInAccount', () => addAccount()),
    vscode.commands.registerCommand('sidekick.addAccount', refresh),
    vscode.commands.registerCommand(
      'sidekick.removeAccount',
      withView('Remove which account?', removeAccount),
    ),
  );
}
