/**
 * `sidekick quota` — Show subscription quota utilization (one-shot).
 */

import type { Command } from 'commander';
import chalk, { type ChalkInstance } from 'chalk';
import { QuotaService } from '../dashboard/QuotaService';

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

function formatRetryAfter(ms: number): string {
  if (ms <= 0) return 'now';

  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

export async function quotaAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;

  const service = new QuotaService();
  const quota = await service.fetchOnce();

  if (!quota.available) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(quota, null, 2) + '\n');
      return;
    }

    let msg: string;
    switch (quota.failureKind) {
      case 'auth':
        msg = quota.error === 'No OAuth token available'
          ? 'No Claude Code credentials found. Sign in with `claude` first.'
          : 'Authentication failed. Try signing in to Claude Code again.';
        break;
      case 'network':
        msg = 'Could not reach the Anthropic API. Check your connection.';
        break;
      case 'rate_limit':
        msg = quota.retryAfterMs != null
          ? `Quota API rate limited. Retry in ${formatRetryAfter(quota.retryAfterMs)}.`
          : 'Quota API rate limited. Retry shortly.';
        break;
      case 'server':
        msg = quota.httpStatus != null
          ? `Anthropic quota API error (${quota.httpStatus}). Try again shortly.`
          : 'Anthropic quota API error. Try again shortly.';
        break;
      case 'unknown':
        msg = quota.httpStatus != null
          ? `Unexpected quota API response (${quota.httpStatus}).`
          : (quota.error ?? 'Unknown error fetching quota.');
        break;
      default:
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
    process.stderr.write(chalk.red(msg) + '\n');
    process.exit(1);
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(quota, null, 2) + '\n');
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

  process.stdout.write(chalk.bold('Subscription Quota\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  process.stdout.write(`  ${chalk.dim('5-Hour')}   ${makeChalkBar(fivePct, barWidth)} ${String(fivePct).padStart(3)}%${fiveProj}   ${chalk.dim('resets ' + fiveReset)}\n`);
  process.stdout.write(`  ${chalk.dim('7-Day')}    ${makeChalkBar(sevenPct, barWidth)} ${String(sevenPct).padStart(3)}%${sevenProj}   ${chalk.dim('resets ' + sevenReset)}\n`);
}
