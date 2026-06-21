/**
 * `sidekick quota` — Show subscription quota / rate-limit utilization (one-shot).
 */

import type { Command } from 'commander';
import chalk, { type ChalkInstance } from 'chalk';
import {
  describeQuotaFailure,
  getActiveAccount,
  getOpenCodeDataDir,
  CodexProvider,
  OpenCodeDatabase,
  ZAI_PROVIDER_IDS,
  ZAI_TIER_BUDGETS,
  accumulateZaiUsage,
  getActiveCodexAccount,
  inferZaiQuotaState,
  makeUnavailableZaiQuotaState,
  parseZaiQuotaError,
  resolveCodexQuota,
  resolveZaiTier,
  rowsToZaiTurnsAndErrors,
  fetchPeakHoursStatus,
} from 'sidekick-shared';
import type { PeakHoursState } from 'sidekick-shared';
import type { ZaiTier } from 'sidekick-shared';
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

type ClaudeQuota = Awaited<ReturnType<QuotaService['fetchOnce']>>;

async function claudeQuotaAction(jsonOutput: boolean): Promise<void> {
  const { quota, peak } = await fetchClaudeQuotaPayload();

  if (!quota.available) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ...quota, peak }, null, 2) + '\n');
      return;
    }
    printClaudeQuotaError(quota);
    process.exit(1);
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
}

function printClaudeQuota(quota: ClaudeQuota, peak: PeakHoursState): void {
  const barWidth = 30;
  const fivePct = Math.round(quota.fiveHour.utilization);
  const sevenPct = Math.round(quota.sevenDay.utilization);
  const fiveReset = formatTimeUntil(quota.fiveHour.resetsAt);
  const sevenReset = formatTimeUntil(quota.sevenDay.resetsAt);

  const fiveProj = quota.projectedFiveHour != null
    ? ` ${chalk.dim('→')} ${getUtilizationColor(quota.projectedFiveHour)(String(Math.round(quota.projectedFiveHour)).padStart(3) + '%')}`
    : '';
  const sevenProj = quota.projectedSevenDay != null
    ? ` ${chalk.dim('→')} ${getUtilizationColor(quota.projectedSevenDay)(String(Math.round(quota.projectedSevenDay)).padStart(3) + '%')}`
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

async function fetchClaudeQuotaPayload(): Promise<{ quota: Awaited<ReturnType<QuotaService['fetchOnce']>>; peak: PeakHoursState }> {
  const service = new QuotaService();
  const [quota, peak] = await Promise.all([
    service.fetchOnce(),
    fetchPeakHoursStatus(),
  ]);
  return { quota, peak };
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
  const quota = await fetchCodexQuotaPayload(provider, globalOpts, localOpts);

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

  printCodexQuota(quota, getActiveCodexAccount());
}

async function fetchCodexQuotaPayload(
  provider: CodexProvider,
  globalOpts: Record<string, unknown>,
  localOpts: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof resolveCodexQuota>>> {
  const workspacePath = (globalOpts.project as string) || process.cwd();
  const activeAccount = getActiveCodexAccount();
  try {
    return await resolveCodexQuota({
      workspacePath,
      provider,
      activeAccount,
      source: localOpts.refresh ? 'api' : 'local',
    });
  } finally {
    provider.dispose();
  }
}

function printCodexQuota(
  quota: Awaited<ReturnType<typeof resolveCodexQuota>>,
  activeAccount: ReturnType<typeof getActiveCodexAccount> = getActiveCodexAccount(),
): void {
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

// ── z.ai (GLM Coding Plan) ──

function resolveZaiTierOption(localOpts: Record<string, unknown>): ZaiTier | 'auto' {
  const raw = localOpts.tier;
  if (raw === 'lite' || raw === 'pro' || raw === 'max') return raw;
  return 'auto';
}

/**
 * Heuristic: does the local OpenCode install currently route at z.ai?
 * Used to auto-pick z.ai for `sidekick quota` when no explicit provider is set.
 */
async function detectZaiRouting(): Promise<boolean> {
  try {
    const db = new OpenCodeDatabase(getOpenCodeDataDir());
    if (!db.isAvailable() || !db.open()) return false;
    const rows = db.getAssistantMessagesByProviderId(
      [...ZAI_PROVIDER_IDS],
      Date.now() - 7 * 86_400_000,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function fetchZaiQuotaPayload(localOpts: Record<string, unknown>): Promise<{
  quota: ReturnType<typeof makeUnavailableZaiQuotaState> | ReturnType<typeof inferZaiQuotaState>;
  detected: boolean;
}> {
  const sinceMs = Date.now() - 7 * 86_400_000;
  let rows: ReturnType<typeof rowsToZaiTurnsAndErrors>['turns'] = [];
  let detected = false;
  try {
    const db = new OpenCodeDatabase(getOpenCodeDataDir());
    if (db.isAvailable() && db.open()) {
      const rawRows = db.getAssistantMessagesByProviderId([...ZAI_PROVIDER_IDS], sinceMs);
      detected = rawRows.length > 0;
      const parsed = rowsToZaiTurnsAndErrors(rawRows);
      rows = parsed.turns;
    }
  } catch {
    // Fall through with empty rows → unavailable.
  }

  if (rows.length === 0) {
    return {
      quota: makeUnavailableZaiQuotaState('No z.ai usage observed in the last 7 days.'),
      detected,
    };
  }

  const accumulated = accumulateZaiUsage(rows, Date.now());
  const configuredTier = resolveZaiTierOption(localOpts);
  const tier = resolveZaiTier(configuredTier, accumulated);

  // Walk rows once more to trap any z.ai business errors captured in
  // message.error.code. Most recent authoritative reset wins.
  let authoritativeFiveHourResetAt: string | undefined;
  let authoritativeWeeklyResetAt: string | undefined;
  try {
    const db = new OpenCodeDatabase(getOpenCodeDataDir());
    if (db.isAvailable() && db.open()) {
      const rawRows = db.getAssistantMessagesByProviderId([...ZAI_PROVIDER_IDS], sinceMs);
      for (const row of rawRows) {
        const parsed = parseZaiQuotaError({
          code: row.errorCode ?? undefined,
          message: row.errorMessage ?? undefined,
        });
        if (!parsed?.resetsAt) continue;
        if (parsed.kind === 'exhausted') {
          authoritativeFiveHourResetAt = parsed.resetsAt;
          if (String(parsed.code) === '1310') authoritativeWeeklyResetAt = parsed.resetsAt;
        }
      }
    }
  } catch {
    // Optional refinement — ignore failures.
  }

  const quota = inferZaiQuotaState(accumulated, tier, {
    authoritativeFiveHourResetAt,
    authoritativeWeeklyResetAt,
  });
  return { quota, detected };
}

async function zaiQuotaAction(
  _globalOpts: Record<string, unknown>,
  localOpts: Record<string, unknown>,
  jsonOutput: boolean,
): Promise<void> {
  const { quota } = await fetchZaiQuotaPayload(localOpts);

  if (!quota.available) {
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

function printZaiQuota(quota: ReturnType<typeof inferZaiQuotaState>): void {
  const barWidth = 30;
  const fivePct = Math.round(quota.fiveHour.utilization);
  const sevenPct = Math.round(quota.sevenDay.utilization);
  const fiveReset = quota.fiveHour.resetsAt ? formatTimeUntil(quota.fiveHour.resetsAt) : '';
  const sevenReset = quota.sevenDay.resetsAt ? formatTimeUntil(quota.sevenDay.resetsAt) : '';
  const tier = (quota.planType ?? 'auto') as ZaiTier | 'auto';
  const tierBudget = tier === 'auto' ? null : ZAI_TIER_BUDGETS[tier];

  process.stdout.write(chalk.bold('z.ai Coding Plan') + chalk.dim(` (estimated, tier: ${tier})\n`));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  process.stdout.write(`  ${chalk.dim('5-Hour')}   ${makeChalkBar(fivePct, barWidth)} ${String(fivePct).padStart(3)}%   ${fiveReset ? chalk.dim('resets ' + fiveReset) : ''}\n`);
  process.stdout.write(`  ${chalk.dim('Weekly')}    ${makeChalkBar(sevenPct, barWidth)} ${String(sevenPct).padStart(3)}%   ${sevenReset ? chalk.dim('resets ' + sevenReset) : ''}\n`);
  if (tierBudget) {
    process.stdout.write(chalk.dim(`  budgets: ${tierBudget.fiveHour}/5h, ${tierBudget.weekly}/week (prompts)\n`));
  }
  process.stdout.write(chalk.dim('  z.ai exposes no quota API; utilization is derived from observed traffic.\n'));
}

async function allQuotaAction(
  globalOpts: Record<string, unknown>,
  localOpts: Record<string, unknown>,
  jsonOutput: boolean,
): Promise<void> {
  const codexProvider = new CodexProvider();
  const [{ quota: claude, peak }, codex, zai] = await Promise.all([
    fetchClaudeQuotaPayload(),
    fetchCodexQuotaPayload(codexProvider, globalOpts, localOpts),
    fetchZaiQuotaPayload(localOpts),
  ]);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({
      claude: { ...claude, peak },
      codex,
      zai: zai.quota,
    }, null, 2) + '\n');
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
    printCodexQuota(codex);
  } else {
    process.stderr.write(chalk.yellow(codex.error ?? 'Codex rate-limit data is unavailable.') + '\n');
  }

  // Only show z.ai when we actually have observed traffic — otherwise the
  // section is noise.
  if (zai.detected || zai.quota.available) {
    process.stdout.write('\n' + chalk.bold('z.ai\n'));
    if (zai.quota.available) {
      printZaiQuota(zai.quota);
    } else {
      process.stderr.write(chalk.yellow(zai.quota.error ?? 'z.ai quota data is unavailable.') + '\n');
    }
  }
}
