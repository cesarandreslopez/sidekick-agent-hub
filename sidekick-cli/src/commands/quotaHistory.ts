/**
 * `sidekick quota history` — render a 13-week quota-utilization heatmap for the current workspace.
 *
 * Reads the per-workspace JSONL history written by `appendQuotaHistorySample` (sidekick-shared)
 * and renders a GitHub-contributions-style grid in the terminal. Output mirrors the same
 * payload shape the VS Code dashboard consumes, so `--json` is suitable for downstream tooling.
 */

import type { Command } from 'commander';
import chalk, { type ChalkInstance } from 'chalk';
import {
  formatLocalDateKey,
  getWorkspaceIdFromPath,
  parseLocalDateKey,
  readQuotaHistoryDailyBuckets,
  type QuotaHistoryDailyBucket,
  type QuotaHistoryRuntimeProvider,
} from 'sidekick-shared';
import { toCsv, type CsvColumn } from '../csv';

const MS_PER_DAY = 86_400_000;

interface QuotaHistoryDailyCell {
  date: string;
  utilization: number;
  unavailable: boolean;
  samples: number;
}

interface QuotaHistoryPayload {
  workspaceId: string;
  weeks: number;
  /** Which limit each cell's utilization refers to. */
  window: QuotaHistoryWindow;
  providers: {
    claude?: { cells: QuotaHistoryDailyCell[] };
    codex?: { cells: QuotaHistoryDailyCell[] };
    zai?: { cells: QuotaHistoryDailyCell[] };
  };
  generatedAt: string;
}

const BUCKET_GLYPHS = ['·', '░', '▒', '▓', '█'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function bucketForUtilization(util: number): number {
  if (util <= 0) return 0;
  if (util < 25) return 1;
  if (util < 50) return 2;
  if (util < 75) return 3;
  return 4;
}

export function colorForBucket(bucket: number): ChalkInstance {
  switch (bucket) {
    case 0:
      return chalk.dim;
    case 1:
      return chalk.green;
    case 2:
      return chalk.yellow;
    case 3:
      return chalk.hex('#ff8800');
    case 4:
      return chalk.red.bold;
    default:
      return chalk.white;
  }
}

/** Which rate-limit window a heatmap cell shows. */
export type QuotaHistoryWindow = '5h' | '7d' | 'max';

export function parseWindow(value: unknown): QuotaHistoryWindow {
  if (typeof value !== 'string') return '5h';
  const lower = value.toLowerCase();
  if (lower === '7d' || lower === 'weekly' || lower === 'seven-day') return '7d';
  if (lower === 'max' || lower === 'both') return 'max';
  return '5h';
}

export function windowLabel(window: QuotaHistoryWindow): string {
  switch (window) {
    case '7d':
      return '7-day window';
    case 'max':
      return 'higher of 5h / 7d';
    default:
      return '5-hour window';
  }
}

/**
 * Collapse a day's samples to one cell for the chosen window. The two windows
 * are kept separate by default so a maxed-out week and a maxed-out five-hour
 * block no longer look the same; `max` restores the old combined view.
 */
export function bucketsToCells(
  buckets: QuotaHistoryDailyBucket[],
  window: QuotaHistoryWindow = '5h',
): QuotaHistoryDailyCell[] {
  return buckets.map((b) => ({
    date: b.date,
    utilization:
      window === '7d'
        ? b.maxUtilizationSevenDay
        : window === 'max'
          ? Math.max(b.maxUtilizationFiveHour, b.maxUtilizationSevenDay)
          : b.maxUtilizationFiveHour,
    unavailable: b.anyUnavailable,
    samples: b.samples,
  }));
}

const BUCKET_CSV_COLUMNS: CsvColumn<{ provider: string; bucket: QuotaHistoryDailyBucket }>[] = [
  { header: 'date', value: (row) => row.bucket.date },
  { header: 'provider', value: (row) => row.provider },
  { header: 'samples', value: (row) => row.bucket.samples },
  { header: 'max_5h', value: (row) => row.bucket.maxUtilizationFiveHour },
  { header: 'avg_5h', value: (row) => row.bucket.avgUtilizationFiveHour },
  { header: 'max_7d', value: (row) => row.bucket.maxUtilizationSevenDay },
  { header: 'avg_7d', value: (row) => row.bucket.avgUtilizationSevenDay },
  { header: 'unavailable', value: (row) => row.bucket.anyUnavailable },
];

export function renderProviderHeatmap(
  label: string,
  cells: QuotaHistoryDailyCell[],
  weeks: number,
): string {
  // Pad the start so we always render exactly weeks*7 cells with day-of-week aligned to the first sample.
  const cols = weeks;
  const rows = 7;
  const totalCells = cols * rows;
  let firstDayOfWeek = 0;
  if (cells.length > 0) {
    // Dates are local calendar days, so the weekday must be read in local time too.
    firstDayOfWeek = parseLocalDateKey(cells[0].date)?.getDay() ?? 0;
  }
  const padded: (QuotaHistoryDailyCell | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i += 1) padded.push(null);
  for (const cell of cells) padded.push(cell);
  while (padded.length < totalCells) padded.push(null);
  // Remove complete columns so the weekday row of the first retained cell
  // stays aligned. Removing individual leading cells destroys row parity.
  while (padded.length > totalCells) padded.splice(0, rows);

  // Column-major: padded[i] sits at column = floor(i/7), row = i % 7.
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const dayLabel = chalk.dim(DAY_LABELS[row].padEnd(4));
    const glyphs: string[] = [];
    for (let col = 0; col < cols; col += 1) {
      const cell = padded[col * rows + row];
      if (!cell) {
        glyphs.push(chalk.dim(' '));
        continue;
      }
      if (cell.unavailable && cell.samples > 0) {
        glyphs.push(chalk.red('×'));
        continue;
      }
      const bucket = bucketForUtilization(cell.utilization);
      glyphs.push(colorForBucket(bucket)(BUCKET_GLYPHS[bucket]));
    }
    lines.push(`${dayLabel}${glyphs.join('')}`);
  }

  // Stats footer
  let peak = 0;
  let sum = 0;
  let sampledDays = 0;
  let unavailableDays = 0;
  let totalSamples = 0;
  for (const cell of cells) {
    if (cell.samples === 0) continue;
    sampledDays += 1;
    totalSamples += cell.samples;
    if (cell.utilization > peak) peak = cell.utilization;
    sum += cell.utilization;
    if (cell.unavailable) unavailableDays += 1;
  }
  const avg = sampledDays > 0 ? Math.round(sum / sampledDays) : 0;
  const peakColor = colorForBucket(bucketForUtilization(peak));
  const avgColor = colorForBucket(bucketForUtilization(avg));

  const header =
    chalk.bold(label) + chalk.dim(`  ·  ${weeks} weeks  ·  ${sampledDays} day(s) with samples`);
  const footer = [
    `Peak ${peakColor(`${peak}%`)}`,
    `Avg ${avgColor(`${avg}%`)}`,
    unavailableDays > 0 ? chalk.red(`Unavailable ${unavailableDays} day(s)`) : null,
    chalk.dim(`Samples ${totalSamples.toLocaleString()}`),
  ]
    .filter(Boolean)
    .join('  ·  ');

  return [header, ...lines, footer].join('\n');
}

function legend(): string {
  const swatches = BUCKET_GLYPHS.map((g, i) => colorForBucket(i)(g)).join('');
  return chalk.dim('Less ') + swatches + chalk.dim(' More');
}

function parseProviderFilter(value: unknown): QuotaHistoryRuntimeProvider | 'auto' {
  if (typeof value !== 'string') return 'auto';
  const lower = value.toLowerCase();
  if (lower === 'claude' || lower === 'claude-code') return 'claude';
  if (lower === 'codex') return 'codex';
  if (lower === 'zai' || lower === 'z.ai') return 'zai';
  return 'auto';
}

function clampWeeks(value: unknown): number {
  const parsed =
    typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : 13;
  if (!Number.isFinite(parsed)) return 13;
  return Math.max(1, Math.min(26, parsed));
}

export async function quotaHistoryAction(
  _localOpts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = cmd.parent?.parent?.opts() ?? cmd.parent?.opts() ?? {};
  const localOpts = cmd.opts();
  const jsonOutput: boolean = !!globalOpts.json;
  const csvOutput: boolean = !!localOpts.csv;
  const window = parseWindow(localOpts.window);

  const weeks = clampWeeks(localOpts.weeks);
  const providerFilter = parseProviderFilter(localOpts.provider ?? globalOpts.provider);
  const workspacePath =
    typeof localOpts.workspace === 'string' && localOpts.workspace
      ? localOpts.workspace
      : process.cwd();
  const workspaceId = getWorkspaceIdFromPath(workspacePath);

  const toMs = Date.now();
  // -1 because readQuotaHistoryDailyBuckets emits inclusive endpoints (start..end ⇒ end-start+1 buckets).
  const fromMs = toMs - (weeks * 7 - 1) * MS_PER_DAY;
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  const wanted: QuotaHistoryRuntimeProvider[] =
    providerFilter === 'auto' ? ['claude', 'codex', 'zai'] : [providerFilter];

  const providerCells: Partial<Record<QuotaHistoryRuntimeProvider, QuotaHistoryDailyCell[]>> = {};
  const csvRows: Array<{ provider: string; bucket: QuotaHistoryDailyBucket }> = [];
  const bucketsByProvider = await Promise.all(
    wanted.map(async (provider) => ({
      provider,
      buckets: await readQuotaHistoryDailyBuckets({ workspaceId, provider, from, to }),
    })),
  );
  for (const { provider, buckets } of bucketsByProvider) {
    providerCells[provider] = bucketsToCells(buckets, window);
    for (const bucket of buckets) csvRows.push({ provider, bucket });
  }

  if (csvOutput) {
    process.stdout.write(toCsv(csvRows, BUCKET_CSV_COLUMNS));
    return;
  }

  const payload: QuotaHistoryPayload = {
    workspaceId,
    weeks,
    window,
    providers: {
      ...(providerCells.claude ? { claude: { cells: providerCells.claude } } : {}),
      ...(providerCells.codex ? { codex: { cells: providerCells.codex } } : {}),
      ...(providerCells.zai ? { zai: { cells: providerCells.zai } } : {}),
    },
    generatedAt: new Date().toISOString(),
  };

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  const sections: string[] = [];
  const claudeHasData = (payload.providers.claude?.cells ?? []).some((c) => c.samples > 0);
  const codexHasData = (payload.providers.codex?.cells ?? []).some((c) => c.samples > 0);
  const zaiHasData = (payload.providers.zai?.cells ?? []).some((c) => c.samples > 0);

  if (providerFilter === 'auto' && !claudeHasData && !codexHasData && !zaiHasData) {
    process.stdout.write(
      chalk.yellow(`No quota history yet for workspace ${chalk.bold(workspaceId)}.`) +
        '\n' +
        chalk.dim(
          `Run a Claude Max, Codex, or z.ai/OpenCode session in this workspace, or override with --workspace <path>.`,
        ) +
        '\n',
    );
    return;
  }

  if (payload.providers.claude && (providerFilter !== 'auto' || claudeHasData)) {
    sections.push(renderProviderHeatmap('Claude', payload.providers.claude.cells, weeks));
  }
  if (payload.providers.codex && (providerFilter !== 'auto' || codexHasData)) {
    sections.push(renderProviderHeatmap('Codex', payload.providers.codex.cells, weeks));
  }
  if (payload.providers.zai && (providerFilter !== 'auto' || zaiHasData)) {
    sections.push(renderProviderHeatmap('z.ai', payload.providers.zai.cells, weeks));
  }

  const header = chalk.dim(
    `workspace ${workspaceId}  ·  ${formatLocalDateKey(fromMs)} → ${formatLocalDateKey(toMs)}  ·  ${windowLabel(window)}`,
  );
  process.stdout.write(`${header}\n${legend()}\n\n${sections.join('\n\n')}\n`);
}
