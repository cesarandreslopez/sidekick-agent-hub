/**
 * `sidekick stats` — Show historical stats summary (tokens, costs, tool usage, etc.).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { readHistory, formatCost } from 'sidekick-shared';
import type { HistoricalDataStore } from 'sidekick-shared';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function printStatsSummary(history: HistoricalDataStore): void {
  const at = history.allTime;

  process.stdout.write(chalk.bold('All-Time Stats\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

  const totalTokens = at.tokens.inputTokens + at.tokens.outputTokens;
  process.stdout.write(`  ${chalk.dim('Sessions:')}       ${chalk.bold(formatNumber(at.sessionCount))}\n`);
  process.stdout.write(`  ${chalk.dim('Messages:')}       ${chalk.bold(formatNumber(at.messageCount))}\n`);
  process.stdout.write(`  ${chalk.dim('Total tokens:')}   ${chalk.bold(formatNumber(totalTokens))}\n`);
  process.stdout.write(`  ${chalk.dim('  Input:')}         ${formatNumber(at.tokens.inputTokens)}\n`);
  process.stdout.write(`  ${chalk.dim('  Output:')}        ${formatNumber(at.tokens.outputTokens)}\n`);
  process.stdout.write(`  ${chalk.dim('  Cache write:')}   ${formatNumber(at.tokens.cacheWriteTokens)}\n`);
  process.stdout.write(`  ${chalk.dim('  Cache read:')}    ${formatNumber(at.tokens.cacheReadTokens)}\n`);
  process.stdout.write(`  ${chalk.dim('Total cost:')}     ${chalk.green(formatCost(at.totalCost))}\n`);
  process.stdout.write(`  ${chalk.dim('Period:')}         ${at.firstDate} — ${at.lastDate}\n`);
  process.stdout.write('\n');

  // Model usage
  if (at.modelUsage && at.modelUsage.length > 0) {
    process.stdout.write(chalk.bold('Model Usage\n'));
    process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

    const sorted = [...at.modelUsage].sort((a, b) => b.calls - a.calls);
    const unpricedModels: string[] = [];
    for (const m of sorted) {
      // Honest rendering: priced === false means no pricing was available
      // for this model at write time — show "—" instead of "$0".
      let costStr = '';
      if (m.priced === false) {
        costStr = chalk.yellow(' (—)');
        unpricedModels.push(m.model);
      } else if (m.cost > 0) {
        costStr = chalk.dim(` (${formatCost(m.cost)})`);
      }
      process.stdout.write(`  ${chalk.cyan(m.model.padEnd(30))} ${formatNumber(m.calls).padStart(8)} calls${costStr}\n`);
    }
    if (unpricedModels.length > 0) {
      const label = unpricedModels.length === 1
        ? '1 model unpriced'
        : `${unpricedModels.length} models unpriced`;
      process.stdout.write(chalk.dim(`  ⚠ ${label}: ${unpricedModels.join(', ')} — no pricing catalog entry.\n`));
    }
    process.stdout.write('\n');
  }

  // Tool usage
  if (at.toolUsage && at.toolUsage.length > 0) {
    process.stdout.write(chalk.bold('Tool Usage\n'));
    process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

    const sorted = [...at.toolUsage].sort((a, b) => b.calls - a.calls);
    for (const t of sorted) {
      const failStr = t.failureCount > 0
        ? chalk.red(` (${t.failureCount} failed)`)
        : '';
      process.stdout.write(`  ${chalk.yellow(t.tool.padEnd(30))} ${formatNumber(t.calls).padStart(8)} calls${failStr}\n`);
    }
    process.stdout.write('\n');
  }

  // Recent daily breakdown (last 7 days)
  const days = Object.values(history.daily || {});
  if (days.length > 0) {
    days.sort((a, b) => b.date.localeCompare(a.date));
    const recent = days.slice(0, 7);

    process.stdout.write(chalk.bold('Recent Activity (last 7 days)\n'));
    process.stdout.write(chalk.dim('─'.repeat(70) + '\n'));
    process.stdout.write(
      chalk.dim('  Date'.padEnd(16) +
        'Sessions'.padStart(10) +
        'Messages'.padStart(10) +
        'Tokens'.padStart(12) +
        'Cost'.padStart(10)) + '\n'
    );

    for (const day of recent) {
      const tokens = day.tokens.inputTokens + day.tokens.outputTokens;
      process.stdout.write(
        `  ${day.date.padEnd(14)}` +
        `${String(day.sessionCount).padStart(10)}` +
        `${String(day.messageCount).padStart(10)}` +
        `${formatNumber(tokens).padStart(12)}` +
        `${formatCost(day.totalCost).padStart(10)}\n`
      );
    }
    process.stdout.write('\n');
  }
}

export async function statsAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;

  try {
    const history = await readHistory();

    if (!history) {
      if (jsonOutput) {
        process.stdout.write(JSON.stringify(null) + '\n');
      } else {
        process.stdout.write(chalk.dim('No historical data found.\n'));
        process.stdout.write(chalk.dim('Run some sessions with Sidekick to accumulate stats.\n'));
      }
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(history, null, 2) + '\n');
    } else {
      printStatsSummary(history);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}
