/**
 * `sidekick quota` — Show subscription quota / rate-limit utilization (one-shot).
 */

import type { Command } from 'commander';
import chalk, { type ChalkInstance } from 'chalk';
import {
  describeQuotaFailure,
  getActiveAccount,
  CodexProvider,
  getActiveCodexAccount,
  resolveCodexQuota,
  fetchPeakHoursStatus,
} from 'sidekick-shared';
import type { PeakHoursState } from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { QuotaService } from '../dashboard/QuotaService';
import { formatPeakHoursLine } from './peakHoursRender';

export function getUtilizationColor(percent: number): ChalkInstance {
  if (percent < 60) return chalk.green;
  if (percent < 80) return chalk.yellow;
  return chalk.red;
}

export function makeChalkBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = getUtilizationColor(percent);
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

export function formatTimeUntil(isoString: string): string {
  if (!isoString) return '';
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'now';

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return 'in ' + (parts.join(' ') || '0m');
}

function formatSnapshotTime(isoString?: string): string {
  if (!isoString) return 'unknown time';
  return new Date(isoString).toLocaleString();
}

export async function quotaAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const localOpts = cmd.opts();
  const jsonOutput: boolean = !!globalOpts.json;
  // Local --provider overrides the global one
  const providerOpts = localOpts.provider ? { provider: localOpts.provider } : globalOpts;
  const provider = resolveProvider(providerOpts);

  if (provider.id === 'opencode') {
    provider.dispose();
    const msg = 'OpenCode does not provide rate-limit data.';
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ available: false, error: msg }, null, 2) + '\n');
    } else {
      process.stderr.write(chalk.yellow(msg) + '\n');
    }
    return;
  }

  if (provider.id === 'codex') {
    await codexQuotaAction(provider as CodexProvider, globalOpts, localOpts, jsonOutput);
    return;
  }

  // claude-code: existing OAuth quota flow
  provider.dispose();
  await claudeQuotaAction(jsonOutput);
}

async function claudeQuotaAction(jsonOutput: boolean): Promise<void> {
  const service = new QuotaService();
  const [quota, peak] = await Promise.all([
    service.fetchOnce(),
    fetchPeakHoursStatus(),
  ]);

  if (!quota.available) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ...quota, peak }, null, 2) + '\n');
      return;
    }

    const descriptor = describeQuotaFailure(quota);
    let msg: string;
    let color = chalk.red;

    if (descriptor) {
      msg = [descriptor.title, descriptor.message, descriptor.detail].filter(Boolean).join(' ');
      color = descriptor.severity === 'warning'
        ? chalk.yellow
        : descriptor.severity === 'info'
          ? chalk.cyan
          : chalk.red;
    } else {
      switch (quota.error) {
        case 'no-credentials':
          msg = 'No Claude Code credentials found. Sign in with `claude` first.';
          break;
        case 'auth-failed':
          msg = 'Authentication failed. Try signing in to Claude Code again.';
          break;
        case 'network-error':
          msg = 'Could not reach the Anthropic API. Check your connection.';
          break;
        default:
          msg = quota.error ?? 'Unknown error fetching quota.';
      }
    }
    process.stderr.write(color(msg) + '\n');
    process.exit(1);
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ ...quota, peak }, null, 2) + '\n');
    return;
  }

  const barWidth = 30;
  const fivePct = Math.round(quota.fiveHour.utilization);
  const sevenPct = Math.round(quota.sevenDay.utilization);
  const fiveReset = formatTimeUntil(quota.fiveHour.resetsAt);
  const sevenReset = formatTimeUntil(quota.sevenDay.resetsAt);

  const fiveProj = quota.projectedFiveHour != null
    ? ` ${chalk.dim('\u2192')} ${getUtilizationColor(quota.projectedFiveHour)(String(Math.round(quota.projectedFiveHour)).padStart(3) + '%')}`
    : '';
  const sevenProj = quota.projectedSevenDay != null
    ? ` ${chalk.dim('\u2192')} ${getUtilizationColor(quota.projectedSevenDay)(String(Math.round(quota.projectedSevenDay)).padStart(3) + '%')}`
    : '';

  const active = getActiveAccount();
  if (active) {
    process.stdout.write(chalk.dim(`Account: ${active.email}${active.label ? ` (${active.label})` : ''}\n`));
  }
  process.stdout.write(chalk.bold('Subscription Quota\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  process.stdout.write(`  ${chalk.dim('5-Hour')}   ${makeChalkBar(fivePct, barWidth)} ${String(fivePct).padStart(3)}%${fiveProj}   ${chalk.dim('resets ' + fiveReset)}\n`);
  process.stdout.write(`  ${chalk.dim('7-Day')}    ${makeChalkBar(sevenPct, barWidth)} ${String(sevenPct).padStart(3)}%${sevenProj}   ${chalk.dim('resets ' + sevenReset)}\n`);

  printPeakHoursSummary(peak);
}

function printPeakHoursSummary(peak: PeakHoursState): void {
  const line = formatPeakHoursLine(peak);
  if (!line) return;
  process.stdout.write(`  ${chalk.dim('Peak')}     ${line}\n`);
}

async function codexQuotaAction(
  provider: CodexProvider,
  globalOpts: Record<string, unknown>,
  localOpts: Record<string, unknown>,
  jsonOutput: boolean,
): Promise<void> {
  const workspacePath = (globalOpts.project as string) || process.cwd();
  const activeAccount = getActiveCodexAccount();
  let quota: Awaited<ReturnType<typeof resolveCodexQuota>>;
  try {
    quota = await resolveCodexQuota({
      workspacePath,
      provider,
      activeAccount,
      source: localOpts.refresh ? 'api' : 'local',
    });
  } finally {
    provider.dispose();
  }

  if (!quota.available) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(quota, null, 2) + '\n');
    } else {
      process.stderr.write(chalk.yellow(quota.error ?? 'Codex rate-limit data is unavailable.') + '\n');
    }
    return;
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(quota, null, 2) + '\n');
    return;
  }

  const barWidth = 30;
  const fivePct = Math.round(quota.fiveHour.utilization);
  const sevenPct = Math.round(quota.sevenDay.utilization);
  const fiveReset = quota.fiveHour.resetsAt ? formatTimeUntil(quota.fiveHour.resetsAt) : '';
  const sevenReset = quota.sevenDay.resetsAt ? formatTimeUntil(quota.sevenDay.resetsAt) : '';
  const fiveLabel = quota.fiveHourLabel ?? '5-Hour';
  const sevenLabel = quota.sevenDayLabel ?? '7-Day';

  if (activeAccount) {
    process.stdout.write(chalk.dim(`Account: ${activeAccount.label ?? activeAccount.id}${activeAccount.email ? ` (${activeAccount.email})` : ''}\n`));
  }
  if (quota.stale) {
    process.stdout.write(chalk.yellow(`Using cached rate-limit snapshot from ${formatSnapshotTime(quota.capturedAt)}.\n`));
  }
  process.stdout.write(chalk.bold('Rate Limits\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  if (quota.fiveHour.resetsAt || quota.fiveHour.utilization > 0) {
    process.stdout.write(`  ${chalk.dim(fiveLabel.padEnd(9))} ${makeChalkBar(fivePct, barWidth)} ${String(fivePct).padStart(3)}%   ${fiveReset ? chalk.dim('resets ' + fiveReset) : ''}\n`);
  }
  if (quota.sevenDay.resetsAt || quota.sevenDay.utilization > 0) {
    process.stdout.write(`  ${chalk.dim(sevenLabel.padEnd(9))} ${makeChalkBar(sevenPct, barWidth)} ${String(sevenPct).padStart(3)}%   ${sevenReset ? chalk.dim('resets ' + sevenReset) : ''}\n`);
  }
}
