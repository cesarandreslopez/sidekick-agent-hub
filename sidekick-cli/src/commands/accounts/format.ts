/**
 * Pure presentation helpers for `sidekick accounts`: health badges, list
 * rows, and switch summaries. No I/O so both the one-shot commands and the
 * Ink picker render identical text.
 */

import chalk from 'chalk';
import type {
  AccountHealth,
  AccountProviderId,
  AccountView,
  SwitchAccountResult,
} from 'sidekick-shared';

export const PROVIDER_NAMES: Record<AccountProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export const PROVIDER_ORDER: AccountProviderId[] = ['claude-code', 'codex'];

export type HealthColor = 'green' | 'yellow' | 'red' | 'gray';

export interface HealthBadge {
  /** One-word state shown in the badge column. */
  state: string;
  /** Short explanation shown after the badge. */
  detail: string;
  color: HealthColor;
  /** Bullet glyph: filled for known states, hollow for unknown. */
  glyph: string;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "in 6d", "in 3h", "in 12m", "now". */
export function formatRelative(target: number, now: number): string {
  const delta = target - now;
  const abs = Math.abs(delta);
  const unit =
    abs >= DAY
      ? `${Math.round(abs / DAY)}d`
      : abs >= HOUR
        ? `${Math.round(abs / HOUR)}h`
        : `${Math.max(1, Math.round(abs / MINUTE))}m`;
  if (abs < MINUTE) return 'now';
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function formatHealth(health: AccountHealth, now: number = Date.now()): HealthBadge {
  switch (health.state) {
    case 'fresh':
      return {
        state: 'fresh',
        color: 'green',
        glyph: '●',
        detail:
          health.refreshExpiresAt !== undefined
            ? `expires ${formatRelative(health.refreshExpiresAt, now)}`
            : health.accessExpiresAt !== undefined
              ? `token expires ${formatRelative(health.accessExpiresAt, now)}`
              : '',
      };
    case 'expiring':
      return {
        state: 'expiring',
        color: 'yellow',
        glyph: '●',
        detail:
          health.refreshExpiresAt !== undefined && health.refreshExpiresAt > now
            ? `refresh ok · expires ${formatRelative(health.refreshExpiresAt, now)}`
            : (health.reason ?? 'refresh on next use'),
      };
    case 'expired':
      return { state: 'expired', color: 'red', glyph: '●', detail: 'sign in again' };
    case 'missing':
      return {
        state: 'missing',
        color: 'red',
        glyph: '○',
        detail: 'no saved credentials · sign in',
      };
    default:
      return {
        state: 'unknown',
        color: 'gray',
        glyph: '○',
        detail: health.reason ?? 'not verified',
      };
  }
}

export function accountDisplayName(view: AccountView): string {
  return view.label ?? view.email ?? view.id;
}

export interface AccountRowParts {
  marker: string;
  name: string;
  email: string;
  plan: string;
  badge: HealthBadge;
}

export function accountRowParts(view: AccountView, now: number = Date.now()): AccountRowParts {
  return {
    marker: view.isActive ? '*' : ' ',
    name: accountDisplayName(view),
    email: view.email && view.email !== accountDisplayName(view) ? view.email : '',
    plan: view.planType ?? '',
    badge: formatHealth(view.health, now),
  };
}

export interface ColumnWidths {
  name: number;
  email: number;
  plan: number;
}

export function columnWidths(views: AccountView[], now: number = Date.now()): ColumnWidths {
  const parts = views.map((view) => accountRowParts(view, now));
  const width = (pick: (p: AccountRowParts) => string, min: number, max: number): number =>
    Math.min(max, Math.max(min, ...parts.map((p) => pick(p).length)));
  return {
    name: width((p) => p.name, 4, 28),
    email: width((p) => p.email, 0, 34),
    plan: width((p) => p.plan, 0, 22),
  };
}

function pad(value: string, width: number): string {
  if (width === 0) return '';
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value.padEnd(width);
}

/** One list row, coloured for a TTY. */
export function formatAccountRow(
  view: AccountView,
  widths: ColumnWidths,
  now: number = Date.now(),
): string {
  const p = accountRowParts(view, now);
  const marker = view.isActive ? chalk.green('* ') : '  ';
  const cells = [
    pad(p.name, widths.name),
    widths.email ? chalk.dim(pad(p.email, widths.email)) : '',
    widths.plan ? chalk.dim(pad(p.plan, widths.plan)) : '',
    chalk[p.badge.color](`${p.badge.glyph} ${p.badge.state.padEnd(8)}`),
    chalk.dim(p.badge.detail),
  ].filter((cell) => cell !== '');
  return `  ${marker}${cells.join('  ')}`;
}

export function groupByProvider(views: AccountView[]): Array<[AccountProviderId, AccountView[]]> {
  return PROVIDER_ORDER.map(
    (provider) =>
      [provider, views.filter((v) => v.providerId === provider)] as [
        AccountProviderId,
        AccountView[],
      ],
  ).filter(([, list]) => list.length > 0);
}

/** The whole list as printed by `sidekick accounts list`. */
export function formatAccountList(views: AccountView[], now: number = Date.now()): string {
  if (views.length === 0) return '';
  const lines: string[] = [];
  for (const [provider, list] of groupByProvider(views)) {
    // Widths per provider: a Codex email column must not pad Claude rows.
    const widths = columnWidths(list, now);
    lines.push(chalk.bold(PROVIDER_NAMES[provider]));
    for (const view of list) lines.push(formatAccountRow(view, widths, now));
    lines.push('');
  }
  return lines.join('\n').replace(/\n$/, '');
}

export const FIRST_RUN_GUIDANCE = [
  'Your current logins were registered automatically.',
  'Add another account:      sidekick accounts add',
  'Run two side by side:     sidekick accounts shell <name>',
  'Switch at any time:       sidekick accounts switch <name>  (or just `sidekick accounts`)',
].join('\n');

export const EMPTY_STATE_GUIDANCE = [
  'No accounts yet. Sign in to Claude Code (`claude`) or Codex (`codex login`) and sidekick registers the login automatically,',
  'or run `sidekick accounts add` to sign in to an account in an isolated profile.',
].join('\n');

/** True when every saved account was learned from a live login (nothing added deliberately yet). */
export function allLearned(views: AccountView[]): boolean {
  return views.length > 0 && views.every((view) => view.source === 'learned');
}

export interface SwitchSummary {
  headline: string;
  warnings: string[];
  hints: string[];
  ok: boolean;
}

export function summarizeSwitch(result: SwitchAccountResult, targetName: string): SwitchSummary {
  const provider = PROVIDER_NAMES[result.provider];
  const who =
    result.email && result.email !== targetName ? `${targetName} (${result.email})` : targetName;
  if (!result.success) {
    return {
      ok: false,
      headline: result.error ?? `Could not switch ${provider} to ${who}.`,
      warnings: result.warnings,
      hints: result.needsLogin
        ? [`Sign in again: sidekick accounts login ${JSON.stringify(targetName)}`, ...result.hints]
        : result.hints,
    };
  }
  if (result.alreadyActive) {
    return {
      ok: true,
      headline: `${who} is already the active ${provider} account.`,
      warnings: result.warnings,
      hints: [],
    };
  }
  const verified = result.verified
    ? '✓ verified'
    : '⚠ not verified (credentials written; run sidekick accounts doctor)';
  return {
    ok: true,
    headline: `Switched ${provider} → ${who}  ${verified}`,
    warnings: result.warnings,
    hints: [...result.hints, ...(result.undoToken ? ['Undo: sidekick accounts undo'] : [])],
  };
}

/** Render a switch summary for the terminal (stdout lines + stderr lines). */
export function renderSwitchSummary(summary: SwitchSummary): {
  stdout: string[];
  stderr: string[];
} {
  const stdout = [summary.ok ? chalk.green(summary.headline) : ''].filter(Boolean);
  const stderr = summary.ok ? [] : [chalk.red(summary.headline)];
  for (const warning of summary.warnings) stderr.push(chalk.yellow(`  ! ${warning}`));
  for (const hint of summary.hints) stdout.push(chalk.dim(hint));
  return { stdout, stderr };
}
