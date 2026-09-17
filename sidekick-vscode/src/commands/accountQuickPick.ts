/**
 * Pure builders for the account quick pick and the post-switch summary, so
 * the labels and the toast text are unit-testable without VS Code.
 */

import type {
  AccountHealth,
  AccountProviderId,
  AccountView,
  SwitchAccountResult,
} from 'sidekick-shared';

export const PROVIDER_LABELS: Record<AccountProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelative(target: number, now: number = Date.now()): string {
  const delta = target - now;
  const abs = Math.abs(delta);
  if (abs < MINUTE) return 'now';
  const unit =
    abs >= DAY
      ? `${Math.round(abs / DAY)}d`
      : abs >= HOUR
        ? `${Math.round(abs / HOUR)}h`
        : `${Math.max(1, Math.round(abs / MINUTE))}m`;
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** One-line health text, e.g. "fresh · expires in 6d". */
export function describeHealth(health: AccountHealth, now: number = Date.now()): string {
  switch (health.state) {
    case 'fresh':
      return health.refreshExpiresAt !== undefined
        ? `fresh · expires ${formatRelative(health.refreshExpiresAt, now)}`
        : 'fresh';
    case 'expiring':
      return health.refreshExpiresAt !== undefined && health.refreshExpiresAt > now
        ? `expiring · refresh ok until ${formatRelative(health.refreshExpiresAt, now)}`
        : `expiring · ${health.reason ?? 'refresh on next use'}`;
    case 'expired':
      return 'expired · sign in again';
    case 'missing':
      return 'no saved credentials · sign in';
    default:
      return health.reason ? `unknown · ${health.reason}` : 'unknown';
  }
}

export function accountDisplayName(view: AccountView): string {
  return view.label ?? view.email ?? view.id;
}

export function healthIcon(view: AccountView): string {
  if (view.health.state === 'expired' || view.health.state === 'missing') return '$(error)';
  if (view.health.state === 'expiring') return '$(warning)';
  if (view.isActive) return '$(pass-filled)';
  return '$(account)';
}

export type AccountQuickPickAction =
  | { kind: 'account'; view: AccountView }
  | { kind: 'add' }
  | { kind: 'terminal' }
  | { kind: 'undo' }
  | { kind: 'signInAgain' }
  | { kind: 'openView' };

export interface AccountQuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  /** -1 for separators (vscode.QuickPickItemKind.Separator). */
  kind?: -1;
  action?: AccountQuickPickAction;
  alwaysShow?: boolean;
}

export interface BuildQuickPickOptions {
  canUndo: boolean;
  now?: number;
}

export function buildAccountQuickPickItems(
  views: AccountView[],
  options: BuildQuickPickOptions,
): AccountQuickPickItem[] {
  const now = options.now ?? Date.now();
  const items: AccountQuickPickItem[] = [];
  for (const provider of ['claude-code', 'codex'] as const) {
    const list = views.filter((view) => view.providerId === provider);
    if (list.length === 0) continue;
    items.push({ label: PROVIDER_LABELS[provider], kind: -1 });
    for (const view of list) {
      const name = accountDisplayName(view);
      const parts = [
        view.email && view.email !== name ? view.email : undefined,
        view.planType,
        view.isActive ? '(current)' : undefined,
      ].filter(Boolean);
      items.push({
        label: `${healthIcon(view)} ${name}`,
        description: parts.join(' · ') || undefined,
        detail:
          view.health.state === 'expired' || view.health.state === 'missing'
            ? 'Expired — select to sign in again'
            : describeHealth(view.health, now),
        action: { kind: 'account', view },
      });
    }
  }
  items.push({ label: 'Actions', kind: -1 });
  items.push({
    label: '$(add) Add account…',
    detail: 'Sign in to another account in an isolated profile; the current login is untouched.',
    action: { kind: 'add' },
    alwaysShow: true,
  });
  if (views.length > 0) {
    items.push({
      label: '$(terminal) Open terminal as account…',
      detail: 'Run claude or codex as a saved account without switching the live login.',
      action: { kind: 'terminal' },
      alwaysShow: true,
    });
    items.push({
      label: '$(sign-in) Sign in again…',
      detail: 'Refresh the credentials of a saved account.',
      action: { kind: 'signInAgain' },
      alwaysShow: true,
    });
  }
  if (options.canUndo) {
    items.push({
      label: '$(discard) Undo last switch',
      action: { kind: 'undo' },
      alwaysShow: true,
    });
  }
  items.push({
    label: '$(list-tree) Open Accounts view',
    action: { kind: 'openView' },
    alwaysShow: true,
  });
  return items;
}

export interface SwitchSummary {
  message: string;
  severity: 'info' | 'warning' | 'error';
  actions: string[];
  details: string[];
}

export function buildSwitchSummary(
  result: SwitchAccountResult,
  targetName: string,
  options: { extensionHostRunning?: boolean } = {},
): SwitchSummary {
  const who =
    result.email && result.email !== targetName ? `${targetName} (${result.email})` : targetName;
  const details = [
    ...result.warnings.map((warning) => `warning: ${warning}`),
    ...result.hints.map((hint) => `hint: ${hint}`),
    ...result.runningConsumers.map(
      (consumer) => `running: ${consumer.kind} pid ${consumer.pids.join(', ')}`,
    ),
  ];
  if (!result.success) {
    return {
      message: result.error ?? `Could not switch to ${who}.`,
      severity: 'error',
      actions: [
        ...(result.needsLogin ? ['Sign In Again'] : []),
        ...(details.length ? ['Details'] : []),
      ],
      details,
    };
  }
  if (result.alreadyActive) {
    return {
      message: `${who} is already the active ${PROVIDER_LABELS[result.provider]} account.`,
      severity: 'info',
      actions: [],
      details,
    };
  }
  const warningCount = result.warnings.length;
  const suffix = warningCount
    ? ` — ${warningCount} warning${warningCount === 1 ? '' : 's'}: ${result.warnings[0]}`
    : '';
  const actions = [
    ...(result.undoToken ? ['Undo'] : []),
    ...(details.length ? ['Details'] : []),
    ...(options.extensionHostRunning ? ['Reload Window'] : []),
  ];
  return {
    message: `Switched to ${who}${result.verified ? ' ✓' : ' (not verified)'}${suffix}`,
    severity: warningCount ? 'warning' : 'info',
    actions,
    details,
  };
}
