/**
 * `sidekick quota` — Show subscription quota / rate-limit utilization (one-shot).
 */

import type { Command } from 'commander';
import chalk, { type ChalkInstance } from 'chalk';
import {
  formatQuotaAge,
  describeQuotaFailure,
  resolveActiveClaudeAccount,
  getOpenCodeDataDir,
  CodexProvider,
  OpenCodeDatabase,
  resolveActiveCodexAccount,
  resolveQuota,
  fetchPeakHoursStatus,
} from 'sidekick-shared';
import type { PeakHoursState, ResolvedActiveAccount, ResolvedQuota } from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { formatPeakHoursLine } from './peakHoursRender';

const ZAI_ROUTING_PROVIDER_IDS = ['zai', 'zai-coding-plan'] as const;

export function getUtilizationColor(percent: number): ChalkInstance {
  if (percent < 60) return chalk.green;
  if (percent < 80) return chalk.yellow;
  return chalk.red;
}

export function makeChalkBar(percent: number, width: number): string {
  const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round((clamped / 100) * width);
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

const QUOTA_BAR_WIDTH = 30;
const QUOTA_LABEL_WIDTH = 9;
const QUOTA_NOW_WIDTH = 4;
const QUOTA_PROJECTED_WIDTH = 9;
const MISSING_VALUE = '—';

interface QuotaTableRow {
  label: string;
  utilization: number;
  projected?: number;
  resetsAt?: string;
}

interface QuotaMetaRow {
  label: string;
  value: string;
  color?: (value: string) => string;
}

function compactResetTime(isoString?: string): string {
  if (!isoString) return MISSING_VALUE;
  const value = formatTimeUntil(isoString);
  return value.startsWith('in ') ? value.slice(3) : value || MISSING_VALUE;
}

function formatColoredPercent(percent: number, width: number): string {
  const rounded = Math.round(percent);
  return getUtilizationColor(rounded)(`${rounded}%`.padStart(width));
}

function formatProjection(percent?: number): string {
  if (percent == null || !Number.isFinite(percent)) {
    return chalk.dim(MISSING_VALUE.padStart(QUOTA_PROJECTED_WIDTH));
  }
  return formatColoredPercent(percent, QUOTA_PROJECTED_WIDTH);
}

function formatAccountIdentity(label?: string, detail?: string): string | null {
  const primary = label?.trim();
  const secondary = detail?.trim();
  if (!primary && !secondary) return null;
  if (!primary) return secondary ?? null;
  if (!secondary || primary === secondary) return primary;
  return `${primary} (${secondary})`;
}

const API_LABELS: Record<ResolvedQuota['runtimeProvider'], string> = {
  claude: 'Anthropic usage API',
  codex: 'Codex usage API',
  zai: 'z.ai quota API',
};

function capturedSourceLabel(source: ResolvedQuota['capturedSource']): string {
  switch (source) {
    case 'statusline':
      return 'status-line sample';
    case 'api':
      return 'API sample';
    case 'session':
      return 'session sample';
    default:
      return 'snapshot';
  }
}

/**
 * One "Source" row for every provider, driven by the shared resolver's
 * `resolution` so the three legs and `--all` describe their numbers the same way.
 */
function sourceMetaRow(quota: ResolvedQuota): QuotaMetaRow | null {
  switch (quota.resolution) {
    case 'api':
      return { label: 'Source', value: API_LABELS[quota.runtimeProvider] };
    case 'session':
      return { label: 'Source', value: 'local session logs' };
    case 'snapshot-fresh':
    case 'snapshot-aging':
    case 'snapshot-stale':
      return {
        label: 'Source',
        value: `cached ${capturedSourceLabel(quota.capturedSource)} from ${formatSnapshotTime(quota.capturedAt)} (${formatQuotaAge(quota.ageMs)})`,
        // A snapshot under five minutes old is as good as live; only older ones get the warning colour.
        color: quota.freshness === 'fresh' ? undefined : chalk.yellow,
      };
    default:
      return null;
  }
}

function resetCreditMetaRows(resetCredits: ResolvedQuota<'codex'>['resetCredits']): QuotaMetaRow[] {
  if (!resetCredits) return [];

  const availableCredits = resetCredits.credits.filter(
    (credit) => credit.status.toLowerCase() === 'available',
  );
  const rows: QuotaMetaRow[] = [
    {
      label: 'Reset Credits',
      value: `${resetCredits.availableCount} available`,
      color: chalk.cyan,
    },
  ];

  for (const credit of availableCredits) {
    rows.push({
      label: 'Expires',
      value: credit.title ? `${credit.expiresAt} - ${credit.title}` : credit.expiresAt,
    });
  }

  return rows;
}

function printQuotaTable(
  title: string,
  rows: QuotaTableRow[],
  metaRows: QuotaMetaRow[] = [],
): void {
  const labelWidth = Math.max(
    QUOTA_LABEL_WIDTH,
    ...rows.map((row) => row.label.length),
    ...metaRows.map((row) => row.label.length),
  );
  const headerLeftWidth = 2 + labelWidth + 1 + QUOTA_BAR_WIDTH;
  const tableWidth =
    headerLeftWidth + 1 + QUOTA_NOW_WIDTH + 1 + QUOTA_PROJECTED_WIDTH + 1 + 'resets'.length;

  process.stdout.write(
    `${chalk.bold(title.padEnd(headerLeftWidth))} ${chalk.dim('now'.padStart(QUOTA_NOW_WIDTH))} ${chalk.dim('projected'.padStart(QUOTA_PROJECTED_WIDTH))} ${chalk.dim('resets')}\n`,
  );
  process.stdout.write(chalk.dim('─'.repeat(Math.max(60, tableWidth)) + '\n'));

  for (const row of rows) {
    const pct = Math.round(row.utilization);
    process.stdout.write(
      `  ${chalk.dim(row.label.padEnd(labelWidth))} ${makeChalkBar(pct, QUOTA_BAR_WIDTH)} ${formatColoredPercent(pct, QUOTA_NOW_WIDTH)} ${formatProjection(row.projected)} ${chalk.dim(compactResetTime(row.resetsAt))}\n`,
    );
  }

  for (const row of metaRows) {
    const color = row.color ?? chalk.dim;
    process.stdout.write(`  ${chalk.dim(row.label.padEnd(labelWidth))} ${color(row.value)}\n`);
  }
}

export async function quotaAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const localOpts = cmd.opts();
  const jsonOutput: boolean = !!globalOpts.json;

  if (localOpts.all) {
    await allQuotaAction(globalOpts, localOpts, jsonOutput);
    return;
  }

  // Local --provider overrides the global one
  const providerOpts = localOpts.provider ? { provider: localOpts.provider } : globalOpts;

  // z.ai is an inference-routing target, not a session provider. Short-circuit
  // before resolveProvider() so the user doesn't need --provider opencode.
  if (providerOpts.provider === 'zai') {
    await zaiQuotaAction(globalOpts, localOpts, jsonOutput);
    return;
  }

  const provider = resolveProvider(providerOpts);

  if (provider.id === 'opencode') {
    // Try z.ai anyway — OpenCode is the only session source that carries
    // z.ai-routed turns today. If z.ai routing is active, show its quota;
    // otherwise emit the legacy "no rate-limit data" message.
    if (await detectZaiRouting()) {
      provider.dispose();
      await zaiQuotaAction(globalOpts, localOpts, jsonOutput);
      return;
    }
    provider.dispose();
    const msg = 'OpenCode does not provide rate-limit data.';
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ available: false, error: msg }, null, 2) + '\n');
    } else {
      process.stderr.write(chalk.yellow(msg) + '\n');
    }
    process.exitCode = 1;
    return;
  }

  if (provider.id === 'codex') {
    await codexQuotaAction(provider as CodexProvider, globalOpts, localOpts, jsonOutput);
    return;
  }

  // claude-code: shared resolver (fresh snapshot → API → older snapshot)
  provider.dispose();
  await claudeQuotaAction(localOpts, jsonOutput);
}

type ClaudeQuota = ResolvedQuota<'claude-code'>;

/** `--refresh` skips a fresh local sample and asks the provider API first. */
function preferFresh(localOpts: Record<string, unknown>): boolean {
  return !localOpts.refresh;
}

async function claudeQuotaAction(
  localOpts: Record<string, unknown>,
  jsonOutput: boolean,
): Promise<void> {
  const { quota, peak } = await fetchClaudeQuotaPayload(localOpts);

  if (!quota.available) {
    process.exitCode = 1;
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ...quota, peak }, null, 2) + '\n');
      return;
    }
    printClaudeQuotaError(quota);
    return;
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ ...quota, peak }, null, 2) + '\n');
    return;
  }

  printClaudeQuota(quota, peak);
}

function printClaudeQuotaError(quota: ClaudeQuota): void {
  const descriptor = describeQuotaFailure(quota);
  let msg: string;
  let color = chalk.red;

  if (descriptor) {
    msg = [descriptor.title, descriptor.message, descriptor.detail].filter(Boolean).join(' ');
    color =
      descriptor.severity === 'warning'
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
}

function printClaudeQuota(quota: ClaudeQuota, peak: PeakHoursState): void {
  // Live-first identity: reflects the currently logged-in Claude account even
  // after a native `claude /login`, not the stale saved registry pointer.
  const active = resolveActiveClaudeAccount();
  const account = formatAccountIdentity(active.email, active.label);
  if (account) {
    process.stdout.write(chalk.dim(`Account: ${account}\n`));
  }

  const peakLine = formatPeakHoursLine(peak);
  const metaRows: QuotaMetaRow[] = [];
  const source = sourceMetaRow(quota);
  if (source) metaRows.push(source);
  if (peakLine) metaRows.push({ label: 'Peak', value: peakLine, color: (value) => value });
  printQuotaTable(
    'Subscription Quota',
    [
      {
        label: '5-Hour',
        utilization: quota.fiveHour.utilization,
        projected: quota.projectedFiveHour,
        resetsAt: quota.fiveHour.resetsAt,
      },
      {
        label: '7-Day',
        utilization: quota.sevenDay.utilization,
        projected: quota.projectedSevenDay,
        resetsAt: quota.sevenDay.resetsAt,
      },
    ],
    metaRows,
  );
}

async function fetchClaudeQuotaPayload(
  localOpts: Record<string, unknown>,
): Promise<{ quota: ClaudeQuota; peak: PeakHoursState }> {
  const [quota, peak] = await Promise.all([
    resolveQuota({ providerId: 'claude-code', preferFresh: preferFresh(localOpts) }),
    fetchPeakHoursStatus(),
  ]);
  return { quota, peak };
}

async function codexQuotaAction(
  provider: CodexProvider,
  globalOpts: Record<string, unknown>,
  localOpts: Record<string, unknown>,
  jsonOutput: boolean,
): Promise<void> {
  // Resolve the live Codex account once: this self-heals the saved pointer to the
  // current login (so the fetched snapshot keys correctly) and yields the display
  // identity reused by printCodexQuota, avoiding a redundant second resolve.
  const resolvedAccount = resolveActiveCodexAccount();
  const quota = await fetchCodexQuotaPayload(provider, globalOpts, localOpts);

  if (!quota.available) {
    process.exitCode = 1;
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(quota, null, 2) + '\n');
    } else {
      process.stderr.write(
        chalk.yellow(quota.error ?? 'Codex rate-limit data is unavailable.') + '\n',
      );
    }
    return;
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(quota, null, 2) + '\n');
    return;
  }

  printCodexQuota(quota, resolvedAccount);
}

async function fetchCodexQuotaPayload(
  provider: CodexProvider,
  globalOpts: Record<string, unknown>,
  localOpts: Record<string, unknown>,
): Promise<ResolvedQuota<'codex'>> {
  const workspacePath = (globalOpts.project as string) || process.cwd();
  try {
    // Callers already self-healed the active pointer (resolveActiveCodexAccount),
    // so the resolver's own account lookup only needs to read it.
    return await resolveQuota({
      providerId: 'codex',
      workspacePath,
      codexProvider: provider,
      preferFresh: preferFresh(localOpts),
      selfHeal: false,
    });
  } finally {
    provider.dispose();
  }
}

function printCodexQuota(quota: ResolvedQuota<'codex'>, resolved: ResolvedActiveAccount): void {
  const fiveLabel = quota.fiveHourLabel ?? '5-Hour';
  const sevenLabel = quota.sevenDayLabel ?? '7-Day';
  // Live-first identity (resolved once by the caller): reflects the currently
  // logged-in Codex account even after a native `codex login`, not the stale pointer.
  const account = formatAccountIdentity(resolved.label ?? resolved.email, resolved.email);

  if (account) {
    process.stdout.write(chalk.dim(`Account: ${account}\n`));
  }

  const rows: QuotaTableRow[] = [];
  if (quota.fiveHour.resetsAt || quota.fiveHour.utilization > 0) {
    rows.push({
      label: fiveLabel,
      utilization: quota.fiveHour.utilization,
      projected: quota.projectedFiveHour,
      resetsAt: quota.fiveHour.resetsAt,
    });
  }
  if (quota.sevenDay.resetsAt || quota.sevenDay.utilization > 0) {
    rows.push({
      label: sevenLabel,
      utilization: quota.sevenDay.utilization,
      projected: quota.projectedSevenDay,
      resetsAt: quota.sevenDay.resetsAt,
    });
  }

  const metaRows: QuotaMetaRow[] = [];
  const source = sourceMetaRow(quota);
  if (source) metaRows.push(source);
  metaRows.push(...resetCreditMetaRows(quota.resetCredits));

  printQuotaTable('Rate Limits', rows, metaRows);
}

// ── z.ai (GLM Coding Plan) ──

/**
 * Heuristic: does the local OpenCode install currently route at z.ai?
 * Used to auto-pick z.ai for `sidekick quota` when no explicit provider is set.
 */
async function detectZaiRouting(): Promise<boolean> {
  try {
    const db = new OpenCodeDatabase(getOpenCodeDataDir());
    if (!db.isAvailable() || !db.open()) return false;
    const rows = db.getAssistantMessagesByProviderId(
      [...ZAI_ROUTING_PROVIDER_IDS],
      Date.now() - 7 * 86_400_000,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function fetchZaiQuotaPayload(localOpts: Record<string, unknown>): Promise<{
  quota: ResolvedQuota<'zai'>;
  detected: boolean;
}> {
  const [quota, detected] = await Promise.all([
    resolveQuota({ providerId: 'zai', preferFresh: preferFresh(localOpts) }),
    detectZaiRouting(),
  ]);
  return { quota, detected };
}

async function zaiQuotaAction(
  _globalOpts: Record<string, unknown>,
  localOpts: Record<string, unknown>,
  jsonOutput: boolean,
): Promise<void> {
  const { quota } = await fetchZaiQuotaPayload(localOpts);

  if (!quota.available) {
    process.exitCode = 1;
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(quota, null, 2) + '\n');
    } else {
      process.stderr.write(chalk.yellow(quota.error ?? 'z.ai quota data is unavailable.') + '\n');
    }
    return;
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(quota, null, 2) + '\n');
    return;
  }

  printZaiQuota(quota);
}

function printZaiQuota(quota: ResolvedQuota<'zai'>): void {
  const tier = quota.planType ?? 'auto';
  const title = 'z.ai Coding Plan' + (tier !== 'auto' ? ` (plan: ${tier})` : '');
  const source = sourceMetaRow(quota);

  printQuotaTable(
    title,
    [
      {
        label: quota.fiveHourLabel ?? '5-Hour',
        utilization: quota.fiveHour.utilization,
        projected: quota.projectedFiveHour,
        resetsAt: quota.fiveHour.resetsAt,
      },
      {
        label: quota.sevenDayLabel ?? 'Weekly',
        utilization: quota.sevenDay.utilization,
        projected: quota.projectedSevenDay,
        resetsAt: quota.sevenDay.resetsAt,
      },
    ],
    source ? [source] : [],
  );
}

async function allQuotaAction(
  globalOpts: Record<string, unknown>,
  localOpts: Record<string, unknown>,
  jsonOutput: boolean,
): Promise<void> {
  const codexProvider = new CodexProvider();
  // Self-heal the live Codex account once up front (before the fetch keys its
  // snapshot) and reuse the resolved identity when printing below.
  const resolvedCodex = resolveActiveCodexAccount();
  // All three legs go through the same resolver with the same precedence, so
  // `--all` and the single-provider views can never disagree on a number.
  const [{ quota: claude, peak }, codex, zai] = await Promise.all([
    fetchClaudeQuotaPayload(localOpts),
    fetchCodexQuotaPayload(codexProvider, globalOpts, localOpts),
    fetchZaiQuotaPayload(localOpts),
  ]);
  if (!claude.available || !codex.available || (zai.detected && !zai.quota.available)) {
    process.exitCode = 1;
  }

  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify(
        {
          claude: { ...claude, peak },
          codex,
          zai: zai.quota,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  // Render all providers from the already-fetched payloads. A failure in one
  // provider must not suppress the others, so each side degrades independently
  // (no process.exit, no re-fetch).
  process.stdout.write(chalk.bold('Claude\n'));
  if (claude.available) {
    printClaudeQuota(claude, peak);
  } else {
    printClaudeQuotaError(claude);
  }

  process.stdout.write('\n' + chalk.bold('Codex\n'));
  if (codex.available) {
    printCodexQuota(codex, resolvedCodex);
  } else {
    process.stderr.write(
      chalk.yellow(codex.error ?? 'Codex rate-limit data is unavailable.') + '\n',
    );
  }

  // Only show z.ai when API quota is available or z.ai traffic was detected.
  if (zai.detected || zai.quota.available) {
    process.stdout.write('\n' + chalk.bold('z.ai\n'));
    if (zai.quota.available) {
      printZaiQuota(zai.quota);
    } else {
      process.stderr.write(
        chalk.yellow(zai.quota.error ?? 'z.ai quota data is unavailable.') + '\n',
      );
    }
  }
}
