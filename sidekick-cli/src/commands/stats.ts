/**
 * `sidekick stats` — Show historical stats summary (tokens, costs, tool usage, etc.).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  readHistory,
  formatCost,
  getTopFailingTools,
  mergeFailingToolWindows,
  FAILING_TOOL_TREND_ARROWS,
  summarizeTokens,
  TOKEN_TOTAL_LABEL,
} from 'sidekick-shared';
import type { FailingToolTrendRow } from 'sidekick-shared';
import type { DailyData, HistoricalDataStore, TopFailingTool } from 'sidekick-shared';
import { toCsv, type CsvColumn } from '../csv';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function printStatsSummary(
  history: HistoricalDataStore,
  topFailingTools: TopFailingTool[],
  failingTools30: TopFailingTool[] = [],
): void {
  const at = history.allTime;

  process.stdout.write(chalk.bold('All-Time Stats\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

  const totalTokens = summarizeTokens(at.tokens).total;
  process.stdout.write(
    `  ${chalk.dim('Sessions:')}       ${chalk.bold(formatNumber(at.sessionCount))}\n`,
  );
  process.stdout.write(
    `  ${chalk.dim('Messages:')}       ${chalk.bold(formatNumber(at.messageCount))}\n`,
  );
  process.stdout.write(
    `  ${chalk.dim(`${TOKEN_TOTAL_LABEL}:`)} ${chalk.bold(formatNumber(totalTokens))}\n`,
  );
  process.stdout.write(
    `  ${chalk.dim('  Input:')}         ${formatNumber(at.tokens.inputTokens)}\n`,
  );
  process.stdout.write(
    `  ${chalk.dim('  Output:')}        ${formatNumber(at.tokens.outputTokens)}\n`,
  );
  process.stdout.write(
    `  ${chalk.dim('  Cache write:')}   ${formatNumber(at.tokens.cacheWriteTokens)}\n`,
  );
  process.stdout.write(
    `  ${chalk.dim('  Cache read:')}    ${formatNumber(at.tokens.cacheReadTokens)}\n`,
  );
  process.stdout.write(
    `  ${chalk.dim('Total cost:')}     ${chalk.green(formatCost(at.totalCost))}\n`,
  );
  process.stdout.write(`  ${chalk.dim('Period:')}         ${at.firstDate} — ${at.lastDate}\n`);
  const recordedSessions = history.sessions ?? [];
  const changedLines = recordedSessions.reduce(
    (sum, session) => sum + session.additions + session.deletions,
    0,
  );
  const changedLineCost = recordedSessions.reduce((sum, session) => sum + session.totalCost, 0);
  if (changedLines > 0) {
    process.stdout.write(
      `  ${chalk.dim('Code impact:')}    ${formatCost(changedLineCost / changedLines)} per changed line (${formatNumber(changedLines)} lines)\n`,
    );
  }
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
      process.stdout.write(
        `  ${chalk.cyan(m.model.padEnd(30))} ${formatNumber(m.calls).padStart(8)} calls${costStr}\n`,
      );
    }
    if (unpricedModels.length > 0) {
      const label =
        unpricedModels.length === 1
          ? '1 model unpriced'
          : `${unpricedModels.length} models unpriced`;
      process.stdout.write(
        chalk.dim(`  ⚠ ${label}: ${unpricedModels.join(', ')} — no pricing catalog entry.\n`),
      );
    }
    process.stdout.write('\n');
  }

  // Tool usage
  if (at.toolUsage && at.toolUsage.length > 0) {
    process.stdout.write(chalk.bold('Tool Usage\n'));
    process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

    const sorted = [...at.toolUsage].sort((a, b) => b.calls - a.calls);
    for (const t of sorted) {
      const failStr = t.failureCount > 0 ? chalk.red(` (${t.failureCount} failed)`) : '';
      process.stdout.write(
        `  ${chalk.yellow(t.tool.padEnd(30))} ${formatNumber(t.calls).padStart(8)} calls${failStr}\n`,
      );
    }
    process.stdout.write('\n');
  }

  const failingRows = mergeFailingToolWindows(topFailingTools, failingTools30);
  if (failingRows.length > 0) {
    process.stdout.write(formatFailingToolsBlock(failingRows));
  }

  // Recent daily breakdown (last 7 days)
  const days = Object.values(history.daily || {});
  if (days.length > 0) {
    days.sort((a, b) => b.date.localeCompare(a.date));
    const recent = days.slice(0, 7);

    process.stdout.write(chalk.bold('Recent Activity (last 7 days)\n'));
    process.stdout.write(chalk.dim('─'.repeat(70) + '\n'));
    process.stdout.write(
      chalk.dim(
        '  Date'.padEnd(16) +
          'Sessions'.padStart(10) +
          'Messages'.padStart(10) +
          'Tokens'.padStart(12) +
          'Cost'.padStart(10),
      ) + '\n',
    );

    for (const day of recent) {
      const tokens = summarizeTokens(day.tokens).total;
      process.stdout.write(
        `  ${day.date.padEnd(14)}` +
          `${String(day.sessionCount).padStart(10)}` +
          `${String(day.messageCount).padStart(10)}` +
          `${formatNumber(tokens).padStart(12)}` +
          `${formatCost(day.totalCost).padStart(10)}\n`,
      );
    }
    process.stdout.write('\n');
  }
}

const DAILY_CSV_COLUMNS: CsvColumn<DailyData>[] = [
  { header: 'date', value: (day) => day.date },
  { header: 'sessions', value: (day) => day.sessionCount },
  { header: 'messages', value: (day) => day.messageCount },
  { header: 'input_tokens', value: (day) => day.tokens.inputTokens },
  { header: 'output_tokens', value: (day) => day.tokens.outputTokens },
  { header: 'cache_write_tokens', value: (day) => day.tokens.cacheWriteTokens },
  { header: 'cache_read_tokens', value: (day) => day.tokens.cacheReadTokens },
  { header: 'total_tokens', value: (day) => summarizeTokens(day.tokens).total },
  { header: 'cost_usd', value: (day) => day.totalCost },
  {
    header: 'unpriced_models',
    value: (day) =>
      day.modelUsage
        .filter((model) => model.priced === false)
        .map((model) => model.model)
        .join(';'),
  },
];

/** Every recorded day, oldest first, as CSV. */
export function formatDailyCsv(history: HistoricalDataStore): string {
  const days = Object.values(history.daily ?? {}).sort((a, b) => a.date.localeCompare(b.date));
  return toCsv(days, DAILY_CSV_COLUMNS);
}

/**
 * The failing-tools block: last 7 days beside last 30, with a trend arrow
 * comparing the week to the 30-day weekly average (shared rule with the VS
 * Code Health tab). Categories come from the 30-day window.
 */
export function formatFailingToolsBlock(rows: FailingToolTrendRow[]): string {
  const lines = [
    chalk.bold('Top Failing Tools (last 7 days / last 30 days)'),
    chalk.dim('─'.repeat(50)),
    `  ${'Tool'.padEnd(30)} ${'7d'.padStart(5)} ${'30d'.padStart(5)}  Trend`,
  ];
  for (const row of rows.slice(0, 10)) {
    const categories = Object.entries(row.categories)
      .sort((left, right) => right[1] - left[1])
      .map(([category, count]) => `${category}:${count}`)
      .join(', ');
    const arrow = FAILING_TOOL_TREND_ARROWS[row.trend];
    const trend =
      row.trend === 'up'
        ? chalk.red(arrow)
        : row.trend === 'down'
          ? chalk.green(arrow)
          : chalk.dim(arrow);
    lines.push(
      `  ${chalk.red(row.tool.padEnd(30))} ${String(row.last7).padStart(5)} ${String(row.last30).padStart(5)}  ${trend} ${chalk.dim(categories)}`,
    );
  }
  return lines.join('\n') + '\n\n';
}

export async function statsAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;
  const csvOutput: boolean = !!cmd.opts().csv;

  try {
    const [history, topFailingTools, failingTools30] = await Promise.all([
      readHistory(),
      getTopFailingTools(7),
      getTopFailingTools(30),
    ]);

    if (!history) {
      if (jsonOutput) {
        process.stdout.write(JSON.stringify(null) + '\n');
      } else if (csvOutput) {
        process.stdout.write(toCsv([], DAILY_CSV_COLUMNS));
      } else {
        process.stdout.write(chalk.dim('No historical data found.\n'));
        process.stdout.write(chalk.dim('Run some sessions with Sidekick to accumulate stats.\n'));
        process.stdout.write(
          chalk.dim('Run "sidekick daily" for usage computed straight from session logs.\n'),
        );
      }
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(history, null, 2) + '\n');
    } else if (csvOutput) {
      process.stdout.write(formatDailyCsv(history));
    } else {
      printStatsSummary(history, topFailingTools, failingTools30);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
    return;
  }
}
