import type { Command } from 'commander';
import {
  composeContext,
  formatCost,
  formatLocalDateKey,
  formatStatusline,
  getActiveAccountStatus,
  getScheduledPeakHoursState,
  readHistory,
  readQuotaSnapshot,
  resolveProjectIdentity,
  summarizeTokens,
} from 'sidekick-shared';
import type { DailyData } from 'sidekick-shared';
import { resolveProvider } from '../cli';

export interface TodayBrief {
  date: string;
  yesterday: DailyData | null;
  openTasks: Array<{ id: string; subject: string; status: string }>;
  openTaskCount: number;
  newestDecision: { description: string; timestamp: string } | null;
  latestHandoff: string | null;
  quota: string;
  peakHours: string;
}

export function compactBriefText(value: string | null | undefined, limit = 160): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

// Daily buckets in historical-data.json are keyed by the local calendar day
// (the extension writes them with the same helper), so "yesterday" must be
// the local yesterday too.
function localDateKey(date: Date): string {
  return formatLocalDateKey(date);
}

/** Peak-window line from the shared schedule, so it always agrees with `sidekick peak`. */
export function scheduledPeakHoursLine(now = new Date()): string {
  const state = getScheduledPeakHoursState(now);
  return state.isPeak
    ? `Peak window: active (${state.peakHoursDescription}; limits may drain faster)`
    : `Peak window: off-peak (peak is ${state.peakHoursDescription})`;
}

export async function todayAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const workspacePath = (globalOpts.project as string | undefined) || process.cwd();
  const project = resolveProjectIdentity(workspacePath);
  const provider = resolveProvider(globalOpts);
  try {
    const [history, context] = await Promise.all([
      readHistory(),
      composeContext(project, 'compact', provider),
    ]);
    const yesterdayKey = localDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const accounts = getActiveAccountStatus();
    const claudeQuota = accounts.claude.accountId
      ? readQuotaSnapshot('claude-code', accounts.claude.accountId)
      : null;
    const codexQuota = accounts.codex.accountId
      ? readQuotaSnapshot('codex', accounts.codex.accountId)
      : null;
    const newestDecision = context.decisions.items[0];
    const openTasks = context.tasks.items.filter(
      (task) => task.status === 'pending' || task.status === 'in_progress',
    );
    const brief: TodayBrief = {
      date: localDateKey(new Date()),
      yesterday: history?.daily?.[yesterdayKey] ?? null,
      openTasks: openTasks.slice(0, 8).map((task) => ({
        id: task.taskId,
        subject: compactBriefText(task.subject, 100) ?? task.subject,
        status: task.status,
      })),
      openTaskCount: openTasks.length,
      newestDecision: newestDecision
        ? {
            description: compactBriefText(newestDecision.description) ?? newestDecision.description,
            timestamp: newestDecision.timestamp,
          }
        : null,
      latestHandoff: compactBriefText(context.handoff),
      quota: formatStatusline({ accounts, claudeQuota, codexQuota }),
      peakHours: scheduledPeakHoursLine(),
    };

    if (globalOpts.json) {
      process.stdout.write(`${JSON.stringify(brief, null, 2)}\n`);
      return;
    }
    const lines = [`Sidekick Today — ${brief.date}`, brief.quota, brief.peakHours, ''];
    if (brief.yesterday) {
      const tokens = summarizeTokens(brief.yesterday.tokens).total;
      lines.push(
        `Yesterday: ${brief.yesterday.sessionCount} sessions · ${tokens.toLocaleString()} tokens · ${formatCost(brief.yesterday.totalCost)}`,
      );
    } else {
      lines.push('Yesterday: no recorded activity');
    }
    lines.push('', `Open tasks (${brief.openTaskCount})`);
    lines.push(
      ...(brief.openTasks.length
        ? brief.openTasks.map(
            (task) => `  ${task.status === 'in_progress' ? '◑' : '○'} ${task.subject}`,
          )
        : ['  None']),
    );
    if (brief.openTaskCount > brief.openTasks.length) {
      lines.push(`  … ${brief.openTaskCount - brief.openTasks.length} more`);
    }
    lines.push('', `Newest decision: ${brief.newestDecision?.description ?? 'None'}`);
    lines.push(`Latest handoff: ${brief.latestHandoff ?? 'None'}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    provider.dispose();
  }
}
