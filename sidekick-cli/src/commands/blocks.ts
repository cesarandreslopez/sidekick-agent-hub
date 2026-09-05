/**
 * `sidekick blocks` — Five-hour billing blocks computed from session logs.
 *
 * A block opens at the first usage event (aligned to the UTC hour), lasts
 * five hours, and a gap longer than five hours opens a new one. The active
 * block shows a burn rate and an end-of-block projection; when the status
 * line has persisted an official rate-limit sample, it is shown beside the
 * local estimate with its own label.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  BILLING_BLOCK_DURATION_MS,
  TOKEN_TOTAL_LABEL,
  collectUsageEvents,
  computeBillingBlocks,
  describeCostProvenance,
  findActiveBillingBlock,
  formatCost,
  formatQuotaAge,
  formatTokenCount,
  resolveQuota,
} from 'sidekick-shared';
import type {
  BillingBlock,
  ProviderId,
  QuotaFreshness,
  QuotaWindow,
  ResolvedQuota,
  SessionProviderBase,
} from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { toCsv, type CsvColumn } from '../csv';
import { parseTimeOption } from '../timeRange';

const RECENT_WINDOW_MS = 3 * 86_400_000;
/**
 * A block holding an event at time T started at most one block length before
 * T, so reading two block lengths before the window start reconstructs every
 * block that overlaps the window exactly as a full read would.
 */
const LOOKBACK_MS = 2 * BILLING_BLOCK_DURATION_MS;

export type BlocksMode = 'active' | 'recent' | 'since';

export interface OfficialRateLimits {
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  capturedAt?: string;
  ageMs?: number;
  freshness?: QuotaFreshness;
}

export interface BlocksReport {
  provider: ProviderId;
  now: string;
  mode: BlocksMode;
  windowStart: string;
  blocks: BillingBlock[];
  active: BillingBlock | null;
  /** Official five-hour sample from the status line, when one has been persisted. */
  official: OfficialRateLimits | null;
  sessions: number;
  cacheHits: number;
  cacheMisses: number;
  diagnostics: string[];
}

export interface BuildBlocksReportOptions {
  provider: SessionProviderBase;
  now: Date;
  mode: BlocksMode;
  windowStart: Date;
  workspacePath?: string;
  noCache?: boolean;
  /** Official rate-limit lookup; defaults to the shared resolver with the API disabled. */
  resolveOfficial?: () => Promise<ResolvedQuota | null>;
}

function officialFromQuota(quota: ResolvedQuota | null): OfficialRateLimits | null {
  if (!quota || !quota.available || quota.capturedSource !== 'statusline') return null;
  return {
    fiveHour: quota.fiveHour,
    sevenDay: quota.sevenDay,
    capturedAt: quota.capturedAt,
    ageMs: quota.ageMs,
    freshness: quota.freshness,
  };
}

async function defaultOfficial(providerId: ProviderId): Promise<ResolvedQuota | null> {
  if (providerId !== 'claude-code' && providerId !== 'codex') return null;
  try {
    return await resolveQuota({ providerId, allowApi: false, selfHeal: false });
  } catch {
    return null;
  }
}

/** Collect usage for the window, group it into blocks, and attach the official sample. */
export async function buildBlocksReport(options: BuildBlocksReportOptions): Promise<BlocksReport> {
  const { provider, now, mode, windowStart } = options;
  const collected = await collectUsageEvents({
    providers: [provider],
    since: new Date(windowStart.getTime() - LOOKBACK_MS),
    until: now,
    workspacePath: options.workspacePath,
    noCache: options.noCache,
  });
  const blocks = computeBillingBlocks(collected.events, { now }).filter(
    (block) => Date.parse(block.end) > windowStart.getTime(),
  );
  const active = findActiveBillingBlock(blocks);
  const official = officialFromQuota(
    await (options.resolveOfficial ?? (() => defaultOfficial(provider.id)))(),
  );
  return {
    provider: provider.id,
    now: now.toISOString(),
    mode,
    windowStart: windowStart.toISOString(),
    blocks: mode === 'active' ? (active ? [active] : []) : blocks,
    active,
    official,
    sessions: collected.sessions.length,
    cacheHits: collected.cacheHits,
    cacheMisses: collected.cacheMisses,
    diagnostics: collected.diagnostics.map((diagnostic) => diagnostic.message),
  };
}

function formatStart(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Hours and minutes only; seconds are noise at five-hour scale. */
export function formatBlockDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

function formatRemaining(block: BillingBlock): string {
  return block.isActive ? formatBlockDuration(block.remainingMs) : '—';
}

const CSV_COLUMNS: CsvColumn<BillingBlock>[] = [
  { header: 'start', value: (block) => block.start },
  { header: 'end', value: (block) => block.end },
  { header: 'status', value: (block) => (block.isActive ? 'active' : 'closed') },
  { header: 'calls', value: (block) => block.calls },
  { header: 'input', value: (block) => block.tokens.inputTokens },
  { header: 'output', value: (block) => block.tokens.outputTokens },
  { header: 'cache_write', value: (block) => block.tokens.cacheWriteTokens },
  { header: 'cache_read', value: (block) => block.tokens.cacheReadTokens },
  { header: 'total', value: (block) => block.tokens.total },
  { header: 'cost_usd', value: (block) => block.costUsd },
  { header: 'cost_provenance', value: (block) => block.costProvenance },
  { header: 'unpriced_calls', value: (block) => block.unpricedCalls },
  { header: 'burn_per_min', value: (block) => Math.round(block.burnRatePerMinute) },
  { header: 'projected_tokens', value: (block) => block.projectedTokens },
  { header: 'projected_cost_usd', value: (block) => block.projectedCostUsd },
  { header: 'remaining_minutes', value: (block) => Math.round(block.remainingMs / 60_000) },
];

export function formatBlocksCsv(report: BlocksReport): string {
  return toCsv(report.blocks, CSV_COLUMNS);
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

function windowLabel(report: BlocksReport): string {
  if (report.mode === 'active') return 'active block';
  if (report.mode === 'recent') return 'last 3 days';
  return `since ${new Date(report.windowStart).toLocaleString()}`;
}

/** Render the block table with the official sample and a provenance footer. */
export function formatBlocksTable(report: BlocksReport): string {
  const lines: string[] = [];
  lines.push(
    chalk.bold(`Billing blocks`) +
      chalk.dim(
        ` · ${PROVIDER_LABELS[report.provider] ?? report.provider} · ${windowLabel(report)}`,
      ),
  );
  lines.push(chalk.dim('─'.repeat(100)));

  if (report.blocks.length === 0) {
    lines.push(
      chalk.dim(
        report.mode === 'active'
          ? '  No active billing block (no usage event in the last five hours).'
          : '  No usage events in this window.',
      ),
    );
    return lines.join('\n') + '\n';
  }

  const header =
    '  ' +
    'Start'.padEnd(16) +
    'Status'.padEnd(8) +
    'Elapsed'.padStart(9) +
    TOKEN_TOTAL_LABEL.padStart(21) +
    'Cost'.padStart(10) +
    'Burn/min'.padStart(10) +
    'Projected'.padStart(11) +
    'Proj. cost'.padStart(12) +
    'Remaining'.padStart(11);
  lines.push(chalk.dim(header));

  for (const block of report.blocks) {
    const status = (block.isActive ? chalk.green : chalk.dim)(
      (block.isActive ? 'active' : 'closed').padEnd(8),
    );
    const tokens = formatTokenCount(block.tokens.total);
    const unpriced = block.costProvenance === 'unpriced';
    const projected = block.isActive ? formatTokenCount(block.projectedTokens) : '—';
    const projectedCost = block.isActive && !unpriced ? formatCost(block.projectedCostUsd) : '—';
    const cost = unpriced ? '—' : formatCost(block.costUsd);
    lines.push(
      '  ' +
        formatStart(block.start).padEnd(16) +
        status +
        formatBlockDuration(block.elapsedMs).padStart(9) +
        tokens.padStart(21) +
        cost.padStart(10) +
        formatTokenCount(Math.round(block.burnRatePerMinute)).padStart(10) +
        projected.padStart(11) +
        projectedCost.padStart(12) +
        formatRemaining(block).padStart(11),
    );
  }

  const reference = report.active ?? report.blocks[report.blocks.length - 1];
  const provenance = describeCostProvenance(reference);
  lines.push('');
  lines.push(
    chalk.dim(
      `  Local estimate from session logs${provenance ? ` · cost ${provenance}` : ''}` +
        (report.sessions > 0
          ? ` · ${report.sessions} session${report.sessions === 1 ? '' : 's'}`
          : ''),
    ),
  );
  if (report.official) {
    const { fiveHour, sevenDay } = report.official;
    const resets = fiveHour.resetsAt
      ? ` · resets in ${formatBlockDuration(Math.max(0, Date.parse(fiveHour.resetsAt) - Date.parse(report.now)))}`
      : '';
    const age =
      report.official.ageMs !== undefined
        ? ` (sample ${formatQuotaAge(report.official.ageMs)})`
        : '';
    lines.push(
      chalk.cyan(
        `  Official (status line): 5h ${fiveHour.utilization.toFixed(0)}% used${resets} · 7d ${sevenDay.utilization.toFixed(0)}%${age}`,
      ),
    );
  } else if (report.provider === 'claude-code') {
    lines.push(
      chalk.dim(
        '  Install the status line (Sidekick: Install Statusline) to see the official five-hour window beside this estimate.',
      ),
    );
  }
  for (const diagnostic of report.diagnostics) {
    lines.push(chalk.yellow(`  ⚠ ${diagnostic}`));
  }
  return lines.join('\n') + '\n';
}

export async function blocksAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const localOpts = cmd.opts();
  const jsonOutput = !!globalOpts.json;
  const now = new Date();

  let mode: BlocksMode = 'recent';
  let windowStart = new Date(now.getTime() - RECENT_WINDOW_MS);
  if (localOpts.since) {
    mode = 'since';
    try {
      windowStart = parseTimeOption(String(localOpts.since), now);
    } catch (error) {
      process.stderr.write(
        chalk.red(error instanceof Error ? error.message : String(error)) + '\n',
      );
      process.exitCode = 1;
      return;
    }
  } else if (localOpts.active) {
    mode = 'active';
    windowStart = new Date(now.getTime() - BILLING_BLOCK_DURATION_MS);
  }

  const provider = resolveProvider(globalOpts);
  try {
    const report = await buildBlocksReport({
      provider,
      now,
      mode,
      windowStart,
      workspacePath: globalOpts.project ? String(globalOpts.project) : undefined,
      noCache: localOpts.cache === false,
    });

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (localOpts.csv) {
      process.stdout.write(formatBlocksCsv(report));
    } else {
      process.stdout.write(formatBlocksTable(report));
    }
  } catch (error) {
    process.stderr.write(chalk.red(error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  } finally {
    provider.dispose();
  }
}
