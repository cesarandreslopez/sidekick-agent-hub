/**
 * `sidekick stats` — Show historical stats summary (tokens, costs, tool usage, etc.).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  SYNTHETIC_MODEL,
  readHistory,
  formatCost,
  getTopFailingTools,
  mergeFailingToolWindows,
  FAILING_TOOL_TREND_ARROWS,
  summarizeTokens,
  TOKEN_TOTAL_LABEL,
  formatTokenCount,
  formatLocalDateKey,
  addLocalDays,
} from 'sidekick-shared';
import type { FailingToolTrendRow } from 'sidekick-shared';
import type { DailyData, HistoricalDataStore, TopFailingTool } from 'sidekick-shared';
import { toCsv, type CsvColumn } from '../csv';
import { mergeModelUsage } from '../modelUsage';

/** Token counts use the shared compact format (12.3k, 4.5M), as everywhere else. */
function formatTokens(n: number): string {
  return formatTokenCount(n);
}

/** Counts of things (sessions, messages, calls, lines) stay exact. */
function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** `1 call`, `12,345 calls`. */
function calls(n: number): string {
  return `${formatCount(n)} call${n === 1 ? '' : 's'}`;
}

const NAME_WIDTH = 30;
const MODEL_MAX_WIDTH = 64;
const TOOL_ROWS = 15;

/** A model or tool name cut to its column, so the count column stays put. */
function fitName(name: string, width = NAME_WIDTH): string {
  return name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width);
}

/** The local `YYYY-MM-DD` keys of today and the six days before it. */
export function lastSevenDayKeys(now: Date = new Date()): Set<string> {
  const today = formatLocalDateKey(now);
  return new Set(Array.from({ length: 7 }, (_, index) => addLocalDays(today, -index)));
}

export function printStatsSummary(
  history: HistoricalDataStore,
  topFailingTools: TopFailingTool[],
  failingTools30: TopFailingTool[] = [],
  now: Date = new Date(),
): void {
  const at = history.allTime;

  process.stdout.write(chalk.bold('All-Time Stats\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

  const totalTokens = summarizeTokens(at.tokens).total;
  // The total inherits the models' pricing gaps: rows marked "—" or
  // "partial" below mean it under-counts.
  const pricedModels = mergeModelUsage(
    (at.modelUsage ?? []).filter((usage) => usage.model !== SYNTHETIC_MODEL),
  );
  const unpricedCount = pricedModels.filter((m) => m.priced === false).length;
  const costIsPartial = unpricedCount > 0 || pricedModels.some((m) => m.partiallyPriced);
  const recordedSessions = history.sessions ?? [];
  const changedLines = recordedSessions.reduce(
    (sum, session) => sum + session.additions + session.deletions,
    0,
  );
  const changedLineCost = recordedSessions.reduce((sum, session) => sum + session.totalCost, 0);

  const summary: Array<[string, string]> = [
    ['Sessions:', chalk.bold(formatCount(at.sessionCount))],
    ['Messages:', chalk.bold(formatCount(at.messageCount))],
    [`${TOKEN_TOTAL_LABEL}:`, chalk.bold(formatTokens(totalTokens))],
    ['  Input:', formatTokens(at.tokens.inputTokens)],
    ['  Output:', formatTokens(at.tokens.outputTokens)],
    ['  Cache write:', formatTokens(at.tokens.cacheWriteTokens)],
    ['  Cache read:', formatTokens(at.tokens.cacheReadTokens)],
    [
      'Total cost:',
      chalk.green(formatCost(at.totalCost)) +
        (costIsPartial
          ? chalk.yellow(
              unpricedCount > 0
                ? ` (partial — ${unpricedCount} model${unpricedCount === 1 ? '' : 's'} unpriced)`
                : ' (partial)',
            )
          : ''),
    ],
    ['Period:', `${at.firstDate} — ${at.lastDate}`],
  ];
  if (changedLines > 0) {
    summary.push([
      'Code impact:',
      `${formatCost(changedLineCost / changedLines)} per changed line (${formatCount(changedLines)} lines)`,
    ]);
  }
  // One value column, however long the longest label is.
  const labelWidth = Math.max(...summary.map(([label]) => label.length)) + 1;
  for (const [label, value] of summary) {
    process.stdout.write(`  ${chalk.dim(label.padEnd(labelWidth))}${value}\n`);
  }
  process.stdout.write('\n');

  // Model usage
  if (at.modelUsage && at.modelUsage.length > 0) {
    process.stdout.write(chalk.bold('Model Usage\n'));
    process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

    // One row per model, whatever spelling (dated, prefixed, Bedrock) recorded it.
    // Claude Code's `<synthetic>` placeholders are never billed, so they are
    // neither a model nor an unpriced one.
    const sorted = mergeModelUsage(at.modelUsage.filter((usage) => usage.model !== SYNTHETIC_MODEL))
      .filter((m) => m.calls > 0)
      .sort((a, b) => b.calls - a.calls);
    // Model ids tell versions apart at the end (`…-high-reasoning-preview`), so
    // the column widens to the longest one instead of cutting it.
    const modelWidth = Math.min(
      MODEL_MAX_WIDTH,
      Math.max(NAME_WIDTH, ...sorted.map((m) => m.model.length)),
    );
    const unpricedModels: string[] = [];
    for (const m of sorted) {
      // Honest rendering: priced === false means no pricing was available
      // for this model at write time — show "—" instead of "$0".
      let costStr = '';
      if (m.priced === false) {
        costStr = chalk.yellow(' (—)');
        unpricedModels.push(m.model);
      } else if (m.partiallyPriced) {
        costStr = chalk.dim(` (${formatCost(m.cost)}, partial)`);
      } else if (m.cost > 0) {
        costStr = chalk.dim(` (${formatCost(m.cost)})`);
      }
      process.stdout.write(
        `  ${chalk.cyan(fitName(m.model, modelWidth))} ${calls(m.calls).padStart(14)}${costStr}\n`,
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
  const tools = [...(at.toolUsage ?? [])]
    .filter((t) => t.calls > 0)
    .sort((a, b) => b.calls - a.calls);
  if (tools.length > 0) {
    process.stdout.write(chalk.bold('Tool Usage\n'));
    process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));

    for (const t of tools.slice(0, TOOL_ROWS)) {
      const failStr =
        t.failureCount > 0 ? chalk.red(` (${formatCount(t.failureCount)} failed)`) : '';
      process.stdout.write(
        `  ${chalk.yellow(fitName(t.tool))} ${calls(t.calls).padStart(14)}${failStr}\n`,
      );
    }
    if (tools.length > TOOL_ROWS) {
      process.stdout.write(
        chalk.dim(`  … ${tools.length - TOOL_ROWS} more (sidekick --json stats has them all)\n`),
      );
    }
    process.stdout.write('\n');
  }

  const failingRows = mergeFailingToolWindows(topFailingTools, failingTools30);
  if (failingRows.length > 0) {
    process.stdout.write(formatFailingToolsBlock(failingRows));
  }

  // Recent daily breakdown: the last seven calendar days, not the last seven
  // days that happen to have data.
  if (Object.keys(history.daily || {}).length > 0) {
    const window = lastSevenDayKeys(now);
    const recent = Object.values(history.daily || {})
      .filter((day) => window.has(day.date))
      .sort((a, b) => b.date.localeCompare(a.date));

    process.stdout.write(chalk.bold('Recent Activity (last 7 days)\n'));
    process.stdout.write(chalk.dim('─'.repeat(70) + '\n'));
    if (recent.length === 0) {
      process.stdout.write(chalk.dim('  No activity in the last 7 days.\n\n'));
      return;
    }
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
          `${formatCount(day.sessionCount).padStart(10)}` +
          `${formatCount(day.messageCount).padStart(10)}` +
          `${formatTokens(tokens).padStart(12)}` +
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
      `  ${chalk.red(fitName(row.tool))} ${formatCount(row.last7).padStart(5)} ${formatCount(row.last30).padStart(5)}  ${trend} ${chalk.dim(categories)}`,
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
        process.stdout.write(chalk.dim('Run some sessions with Sidekick to accumulate stats,\n'));
        process.stdout.write(
          chalk.dim('or run "sidekick import" to build history from existing session logs.\n'),
        );
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
