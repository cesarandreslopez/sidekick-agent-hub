import * as fs from 'fs';
import {
  appendQuotaHistorySample,
  formatStatusline,
  getActiveAccountStatus,
  getWorkspaceIdFromPath,
  parseClaudeStatuslinePayload,
  quotaFromStatuslinePayload,
  quotaToStateFile,
  readQuotaSnapshot,
  writeQuotaSnapshot,
  writeStateFile,
} from 'sidekick-shared/statusline';
import type {
  ActiveAccountStatus,
  ClaudeStatuslinePayload,
  QuotaState,
  SidekickStateInput,
} from 'sidekick-shared/statusline';

/**
 * Read the JSON Claude Code pipes to a status-line command, if any.
 *
 * Only a pipe, file, or socket on stdin is read; a TTY or a character device
 * (`/dev/null`) is skipped so a manual `sidekick statusline` never blocks.
 * `SIDEKICK_STATUSLINE_STDIN=0` disables the read entirely.
 */
export function readStatuslineStdin(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeStatuslinePayload | null {
  if (env.SIDEKICK_STATUSLINE_STDIN === '0') return null;
  try {
    if (process.stdin.isTTY) return null;
    const stat = fs.fstatSync(0);
    if (!(stat.isFIFO() || stat.isFile() || stat.isSocket())) return null;
    return parseClaudeStatuslinePayload(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function sameWindows(left: QuotaState | null, right: QuotaState): boolean {
  if (!left) return false;
  return (
    left.fiveHour.utilization === right.fiveHour.utilization &&
    left.fiveHour.resetsAt === right.fiveHour.resetsAt &&
    left.sevenDay.utilization === right.sevenDay.utilization &&
    left.sevenDay.resetsAt === right.sevenDay.resetsAt
  );
}

/**
 * Persist the official rate limits so every other surface (dashboards,
 * `sidekick quota`, `sidekick today`, the MCP facts server) sees them without
 * a network call. Skipped when nothing changed since the last snapshot, which
 * is the common case between prompts.
 */
async function persistOfficialQuota(
  accountId: string,
  quota: QuotaState,
  previous: QuotaState | null,
  payload: ClaudeStatuslinePayload,
): Promise<void> {
  if (sameWindows(previous, quota)) return;
  try {
    writeQuotaSnapshot('claude-code', accountId, quota);
  } catch {
    // Best effort: the line still renders from the live payload.
  }
  try {
    const workspacePath = payload.workspace?.currentDir ?? payload.cwd ?? process.cwd();
    await appendQuotaHistorySample({
      timestamp: quota.capturedAt ?? new Date().toISOString(),
      runtimeProvider: 'claude',
      providerId: accountId,
      workspaceId: getWorkspaceIdFromPath(workspacePath),
      fiveHour: quota.fiveHour,
      sevenDay: quota.sevenDay,
      available: true,
      source: 'statusline',
      stale: false,
    });
  } catch {
    // History is a nice-to-have on this path.
  }
}

/**
 * Project the status-line inputs onto the public `state.json` shape.
 * Exported for tests; the billing block is left null on this path because
 * computing it would break the fast-path budget.
 */
export function buildStatuslineState(
  accounts: ActiveAccountStatus,
  claudeQuota: QuotaState | null,
  codexQuota: QuotaState | null,
  live: ClaudeStatuslinePayload | null,
): SidekickStateInput {
  const account = accounts.claude.present
    ? {
        providerId: 'claude-code' as const,
        id: accounts.claude.accountId ?? null,
        label: accounts.claude.label ?? null,
      }
    : accounts.codex.present
      ? {
          providerId: 'codex' as const,
          id: accounts.codex.accountId ?? null,
          label: accounts.codex.label ?? null,
        }
      : null;
  const context = live?.contextWindow
    ? {
        usedPercentage: live.contextWindow.usedPercentage ?? null,
        contextWindowSize: live.contextWindow.contextWindowSize ?? null,
        totalInputTokens: live.contextWindow.totalInputTokens ?? null,
        totalOutputTokens: live.contextWindow.totalOutputTokens ?? null,
      }
    : null;
  const session = live
    ? {
        sessionId: live.sessionId ?? null,
        cwd: live.workspace?.currentDir ?? live.cwd ?? null,
        model: live.model?.id ?? null,
        costUsd: live.cost?.totalCostUsd ?? null,
        durationMs: live.cost?.totalDurationMs ?? null,
        linesAdded: live.cost?.totalLinesAdded ?? null,
        linesRemoved: live.cost?.totalLinesRemoved ?? null,
        promptCacheHitRatio: live.promptCache?.hitRatio ?? null,
      }
    : null;
  return {
    writer: 'statusline',
    account,
    quota: { claude: quotaToStateFile(claudeQuota), codex: quotaToStateFile(codexQuota) },
    context,
    session,
    billingBlock: null,
  };
}

/**
 * Cache-only hot path used on every agent prompt.
 *
 * When Claude Code runs this as its status line it pipes a JSON document with
 * the official five-hour and seven-day rate limits, context usage, session
 * cost, and prompt-cache statistics. Those official limits replace the cached
 * snapshot for display and are written back to the snapshot and history
 * stores, so the status line doubles as a zero-network quota probe.
 */
export async function statuslineAction(): Promise<void> {
  const live = readStatuslineStdin();
  // No self-heal writes here: this runs on every prompt.
  const accounts = getActiveAccountStatus(undefined, { selfHeal: false });
  const claudeAccountId = accounts.claude.accountId;
  const cachedClaudeQuota = claudeAccountId
    ? readQuotaSnapshot('claude-code', claudeAccountId)
    : null;
  let claudeQuota = cachedClaudeQuota;
  const codexQuota = accounts.codex.accountId
    ? readQuotaSnapshot('codex', accounts.codex.accountId)
    : null;

  let persist: Promise<void> | null = null;
  if (live) {
    const official = quotaFromStatuslinePayload(live, { fallback: cachedClaudeQuota });
    if (official) {
      claudeQuota = official;
      if (claudeAccountId) {
        persist = persistOfficialQuota(claudeAccountId, official, cachedClaudeQuota, live);
      }
    }
  }

  process.stdout.write(`${formatStatusline({ accounts, claudeQuota, codexQuota, live })}\n`);
  // The public state file for external tools: one small read on every prompt,
  // one atomic write only when something changed.
  writeStateFile(buildStatuslineState(accounts, claudeQuota, codexQuota, live));
  if (persist) await persist;
}
