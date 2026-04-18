/**
 * Shared rendering helper for Claude peak-hours state across
 * `sidekick peak`, `sidekick status`, and `sidekick quota`.
 */

import chalk from 'chalk';
import type { PeakHoursState } from 'sidekick-shared';

export function formatCountdown(minutes: number | null): string {
  if (typeof minutes !== 'number' || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Render peak-hours state as a compact block. Used standalone by
 * `sidekick peak` and `sidekick status`.
 */
export function printPeakHoursBlock(state: PeakHoursState): void {
  process.stdout.write(chalk.bold('Claude Peak Hours\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

  if (state.unavailable) {
    process.stdout.write(chalk.dim('  Peak-hours status unavailable (promoclock.co unreachable).\n'));
    return;
  }

  const color = state.isPeak ? chalk.hex('#E59C4F') : chalk.green;
  const dot = '\u25cf';
  process.stdout.write(`  ${color(dot)} ${color(state.label || (state.isPeak ? 'Peak' : 'Off-Peak'))}\n`);

  const countdown = formatCountdown(state.minutesUntilChange);
  if (countdown) {
    const label = state.isPeak ? 'Off-peak in' : 'Next peak in';
    process.stdout.write(chalk.dim(`  ${label} ${countdown}\n`));
  }
  if (state.peakHoursDescription) {
    process.stdout.write(chalk.dim(`  ${state.peakHoursDescription}\n`));
  }
  if (state.note) {
    process.stdout.write(chalk.dim(`  ${state.note}\n`));
  }
  process.stdout.write(chalk.dim('  Source: promoclock.co (third-party, unaffiliated with Anthropic)\n'));
}

/**
 * Render a single-line peak-hours summary suitable for inlining alongside
 * quota output. Returns an empty string if the state is unavailable.
 */
export function formatPeakHoursLine(state: PeakHoursState): string {
  if (state.unavailable) return '';

  const countdown = formatCountdown(state.minutesUntilChange);
  if (state.isPeak) {
    const suffix = countdown ? ` ${chalk.dim('(off-peak in ' + countdown + ')')}` : '';
    return `${chalk.hex('#E59C4F')('\u25cf')} ${chalk.hex('#E59C4F')(state.label || 'Peak Hours — Faster Drain')}${suffix}`;
  }
  const suffix = countdown ? ` ${chalk.dim('(peak in ' + countdown + ')')}` : '';
  return `${chalk.green('\u25cf')} ${chalk.green(state.label || 'Off-Peak — Normal Speed')}${suffix}`;
}
