/**
 * `sidekick daily|weekly|monthly|sessions` — Usage reports computed from
 * session logs, provider-neutral.
 *
 * Rows are bucketed by the time of each usage event (local calendar day
 * unless `--utc`), so a session that crosses midnight lands in both days.
 * Unlike `sidekick stats`, nothing here depends on the history store the
 * VS Code extension writes; the shared usage collector reads (and caches)
 * the session logs directly.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  TOKEN_TOTAL_LABEL,
  bucketUsage,
  collectUsageEvents,
  createSessionProviders,
  describeCostProvenance,
  formatCost,
  formatTokenCount,
  getAllDetectedProviders,
  summarizeUsageRows,
} from 'sidekick-shared';
import type {
  ProviderId,
  SessionProviderBase,
  UsageBucketRow,
  UsageGranularity,
  UsageGroupDimension,
  UsageTotals,
} from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { toCsv, type CsvColumn } from '../csv';
import { parseTimeOption } from '../timeRange';

const DAY_MS = 86_400_000;

export interface UsageReport {
  granularity: UsageGranularity;
  since: string;
  until: string;
  utc: boolean;
  groupBy: UsageGroupDimension[];
  providers: ProviderId[];
  rows: UsageBucketRow[];
  /** Per-model sub-rows keyed by the parent row's key, provider, and project. */
  breakdown: Record<string, UsageBucketRow[]>;
  totals: UsageTotals;
  sessions: number;
  cacheHits: number;
  cacheMisses: number;
  diagnostics: string[];
}

export interface BuildUsageReportOptions {
  providers: SessionProviderBase[];
  granularity: UsageGranularity;
  since: Date;
  until: Date;
  utc?: boolean;
  /** Add per-model sub-rows under every row. */
  breakdown?: boolean;
  /** Group rows by project as well as provider. */
  byProject?: boolean;
  workspacePath?: string;
  noCache?: boolean;
}

/** Key that ties a breakdown sub-row to its parent row. */
export function rowGroupKey(row: Pick<UsageBucketRow, 'key' | 'provider' | 'project'>): string {
  return [row.key, row.provider ?? '', row.project ?? ''].join('|');
}

/** Default window per granularity: 30 days, 12 weeks, 12 calendar months, 30 days. */
export function defaultWindowStart(granularity: UsageGranularity, now: Date): Date {
  switch (granularity) {
    case 'week':
      return new Date(now.getTime() - 12 * 7 * DAY_MS);
    case 'month':
      return new Date(now.getFullYear(), now.getMonth() - 11, 1);
    case 'day':
    case 'session':
    default:
      return new Date(now.getTime() - 30 * DAY_MS);
  }
}

export async function buildUsageReport(options: BuildUsageReportOptions): Promise<UsageReport> {
  const groupBy: UsageGroupDimension[] = [
    'provider',
    ...(options.byProject ? ['project' as const] : []),
  ];
  const collected = await collectUsageEvents({
    providers: options.providers,
    since: options.since,
    until: options.until,
    workspacePath: options.workspacePath,
    noCache: options.noCache,
  });
  const bucketOptions = { granularity: options.granularity, utc: options.utc ?? false };
  const rows = bucketUsage(collected.events, { ...bucketOptions, groupBy });

  const breakdown: Record<string, UsageBucketRow[]> = {};
  if (options.breakdown) {
    for (const row of bucketUsage(collected.events, {
      ...bucketOptions,
      groupBy: [...groupBy, 'model'],
    })) {
      const key = rowGroupKey(row);
      (breakdown[key] ??= []).push(row);
    }
    for (const list of Object.values(breakdown)) {
      list.sort((a, b) => b.totalTokens - a.totalTokens);
    }
  }

  return {
    granularity: options.granularity,
    since: options.since.toISOString(),
    until: options.until.toISOString(),
    utc: options.utc ?? false,
    groupBy,
    providers: options.providers.map((provider) => provider.id),
    rows,
    breakdown,
    totals: summarizeUsageRows(rows, collected.events),
    sessions: collected.sessions.length,
    cacheHits: collected.cacheHits,
    cacheMisses: collected.cacheMisses,
    diagnostics: collected.diagnostics.map((diagnostic) => diagnostic.message),
  };
}

const KEY_LABELS: Record<UsageGranularity, string> = {
  day: 'Date',
  week: 'Week of',
  month: 'Month',
  session: 'Started',
};

const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

function shortProject(project: string | null): string {
  if (!project) return '—';
  const parts = project.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : project;
}

function costCell(row: Pick<UsageBucketRow, 'costUsd' | 'costProvenance'>): string {
  return row.costProvenance === 'unpriced' ? '—' : formatCost(row.costUsd);
}

function windowLabel(report: UsageReport): string {
  const from = report.utc ? report.since.slice(0, 10) : new Date(report.since).toLocaleDateString();
  const to = report.utc ? report.until.slice(0, 10) : new Date(report.until).toLocaleDateString();
  return `${from} → ${to}`;
}

const TITLES: Record<UsageGranularity, string> = {
  day: 'Daily usage',
  week: 'Weekly usage',
  month: 'Monthly usage',
  session: 'Sessions',
};

function formatStarted(ms: number, utc: boolean): string {
  const date = new Date(ms);
  return utc
    ? date.toISOString().slice(0, 16).replace('T', ' ')
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function tokenColumns(row: Pick<UsageBucketRow, 'tokens' | 'totalTokens'>): string {
  return (
    formatTokenCount(row.tokens.inputTokens).padStart(9) +
    formatTokenCount(row.tokens.outputTokens).padStart(9) +
    formatTokenCount(row.tokens.cacheWriteTokens).padStart(9) +
    formatTokenCount(row.tokens.cacheReadTokens).padStart(9) +
    formatTokenCount(row.totalTokens).padStart(21)
  );
}

/** Render the report as a terminal table with totals and a provenance footer. */
export function formatUsageTable(report: UsageReport): string {
  const lines: string[] = [];
  const providers = report.providers.map((id) => PROVIDER_LABELS[id] ?? id).join(', ');
  lines.push(
    chalk.bold(TITLES[report.granularity]) + chalk.dim(` · ${windowLabel(report)} · ${providers}`),
  );
  lines.push(chalk.dim('─'.repeat(110)));

  if (report.rows.length === 0) {
    lines.push(chalk.dim('  No usage events in this window.'));
    return lines.join('\n') + '\n';
  }

  const byProject = report.groupBy.includes('project');
  const isSession = report.granularity === 'session';
  const keyWidth = isSession ? 17 : 12;

  if (isSession) {
    lines.push(
      chalk.dim(
        '  ' +
          KEY_LABELS.session.padEnd(keyWidth) +
          'Provider'.padEnd(10) +
          'Session'.padEnd(10) +
          'Project'.padEnd(28) +
          'Calls'.padStart(7) +
          TOKEN_TOTAL_LABEL.padStart(21) +
          'Cost'.padStart(10) +
          '  Models',
      ),
    );
    for (const row of report.rows) {
      lines.push(
        '  ' +
          formatStarted(row.firstTimestamp, report.utc).padEnd(keyWidth) +
          (PROVIDER_LABELS[row.provider ?? 'claude-code'] ?? row.provider ?? '').padEnd(10) +
          (row.sessionId ?? '').slice(0, 8).padEnd(10) +
          shortProject(row.project).slice(0, 27).padEnd(28) +
          String(row.calls).padStart(7) +
          formatTokenCount(row.totalTokens).padStart(21) +
          costCell(row).padStart(10) +
          '  ' +
          chalk.dim(row.models.join(', ')),
      );
    }
  } else {
    lines.push(
      chalk.dim(
        '  ' +
          KEY_LABELS[report.granularity].padEnd(keyWidth) +
          'Provider'.padEnd(10) +
          (byProject ? 'Project'.padEnd(28) : '') +
          'Sessions'.padStart(9) +
          'Calls'.padStart(7) +
          'Input'.padStart(9) +
          'Output'.padStart(9) +
          'Cache W'.padStart(9) +
          'Cache R'.padStart(9) +
          TOKEN_TOTAL_LABEL.padStart(21) +
          'Cost'.padStart(10),
      ),
    );
    for (const row of report.rows) {
      lines.push(
        '  ' +
          row.key.padEnd(keyWidth) +
          (PROVIDER_LABELS[row.provider ?? 'claude-code'] ?? row.provider ?? '').padEnd(10) +
          (byProject ? shortProject(row.project).slice(0, 27).padEnd(28) : '') +
          String(row.sessions).padStart(9) +
          String(row.calls).padStart(7) +
          tokenColumns(row) +
          costCell(row).padStart(10),
      );
      for (const sub of report.breakdown[rowGroupKey(row)] ?? []) {
        lines.push(
          chalk.dim(
            '  ' +
              `  └ ${sub.model ?? 'unknown'}`
                .slice(0, keyWidth + 10 + (byProject ? 28 : 0) - 1)
                .padEnd(keyWidth + 10 + (byProject ? 28 : 0)) +
              ''.padStart(9) +
              String(sub.calls).padStart(7) +
              tokenColumns(sub) +
              costCell(sub).padStart(10),
          ),
        );
      }
    }
  }

  const totals = report.totals;
  lines.push(chalk.dim('─'.repeat(110)));
  lines.push(
    chalk.bold(
      '  ' +
        'Total'.padEnd(keyWidth) +
        ''.padEnd(10) +
        (byProject && !isSession ? ''.padEnd(28) : '') +
        (isSession
          ? ''.padEnd(10 + 28) +
            String(totals.calls).padStart(7) +
            formatTokenCount(totals.totalTokens).padStart(21)
          : String(totals.sessions).padStart(9) +
            String(totals.calls).padStart(7) +
            tokenColumns(totals)) +
        costCell(totals).padStart(10),
    ),
  );

  const provenance = describeCostProvenance(totals);
  lines.push('');
  lines.push(
    chalk.dim(
      `  Bucketed by usage-event time (${report.utc ? 'UTC' : 'local'} calendar)` +
        (provenance ? ` · cost ${provenance}` : '') +
        ` · ${report.sessions} session${report.sessions === 1 ? '' : 's'} read`,
    ),
  );
  for (const diagnostic of report.diagnostics) {
    lines.push(chalk.yellow(`  ⚠ ${diagnostic}`));
  }
  return lines.join('\n') + '\n';
}

function csvColumns(report: UsageReport): CsvColumn<UsageBucketRow>[] {
  return [
    { header: report.granularity === 'session' ? 'session_id' : 'period', value: (row) => row.key },
    { header: 'provider', value: (row) => row.provider },
    { header: 'project', value: (row) => row.project },
    { header: 'model', value: (row) => row.model },
    { header: 'sessions', value: (row) => row.sessions },
    { header: 'calls', value: (row) => row.calls },
    { header: 'input', value: (row) => row.tokens.inputTokens },
    { header: 'output', value: (row) => row.tokens.outputTokens },
    { header: 'cache_write', value: (row) => row.tokens.cacheWriteTokens },
    { header: 'cache_read', value: (row) => row.tokens.cacheReadTokens },
    { header: 'total', value: (row) => row.totalTokens },
    { header: 'cost_usd', value: (row) => row.costUsd },
    { header: 'cost_provenance', value: (row) => row.costProvenance },
    { header: 'unpriced_calls', value: (row) => row.unpricedCalls },
    { header: 'first_event', value: (row) => new Date(row.firstTimestamp).toISOString() },
    { header: 'last_event', value: (row) => new Date(row.lastTimestamp).toISOString() },
    { header: 'models', value: (row) => row.models.join(';') },
  ];
}

/** Rows (and breakdown sub-rows, when present) as CSV. */
export function formatUsageCsv(report: UsageReport): string {
  const rows: UsageBucketRow[] = [];
  for (const row of report.rows) {
    rows.push(row);
    rows.push(...(report.breakdown[rowGroupKey(row)] ?? []));
  }
  return toCsv(rows, csvColumns(report));
}

/** Providers to read: `--provider` when given, otherwise every provider with session data. */
export function selectProviders(globalOpts: { provider?: string }): SessionProviderBase[] {
  if (globalOpts.provider && globalOpts.provider !== 'auto') {
    return [resolveProvider(globalOpts)];
  }
  const detected = getAllDetectedProviders();
  if (detected.length === 0) return [resolveProvider(globalOpts)];
  return createSessionProviders({ providerIds: detected }).providers;
}

export async function usageReportAction(
  granularity: UsageGranularity,
  _opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const localOpts = cmd.opts();
  const jsonOutput = !!globalOpts.json;
  const now = new Date();

  let since: Date;
  let until = now;
  try {
    since = localOpts.since
      ? parseTimeOption(String(localOpts.since), now)
      : defaultWindowStart(granularity, now);
    if (localOpts.until) until = parseTimeOption(String(localOpts.until), now);
  } catch (error) {
    process.stderr.write(chalk.red(error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
    return;
  }

  const providers = selectProviders(globalOpts);
  try {
    const report = await buildUsageReport({
      providers,
      granularity,
      since,
      until,
      utc: !!localOpts.utc,
      breakdown: !!localOpts.breakdown,
      byProject: !!localOpts.byProject,
      workspacePath: globalOpts.project ? String(globalOpts.project) : undefined,
      noCache: localOpts.cache === false,
    });

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (localOpts.csv) {
      process.stdout.write(formatUsageCsv(report));
    } else {
      process.stdout.write(formatUsageTable(report));
    }
  } catch (error) {
    process.stderr.write(chalk.red(error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  } finally {
    for (const provider of providers) provider.dispose();
  }
}

export const dailyAction = (opts: Record<string, unknown>, cmd: Command): Promise<void> =>
  usageReportAction('day', opts, cmd);
export const weeklyAction = (opts: Record<string, unknown>, cmd: Command): Promise<void> =>
  usageReportAction('week', opts, cmd);
export const monthlyAction = (opts: Record<string, unknown>, cmd: Command): Promise<void> =>
  usageReportAction('month', opts, cmd);
export const sessionsAction = (opts: Record<string, unknown>, cmd: Command): Promise<void> =>
  usageReportAction('session', opts, cmd);
