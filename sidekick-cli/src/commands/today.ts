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
  readTasks,
  resolveProjectIdentity,
  summarizeTokens,
  formatTokenCount,
} from 'sidekick-shared';
import type { DailyData, PersistedTask } from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { formatCountdown } from './peakHoursRender';
import { openTasksFirst, taskReference } from './tasks';

export interface TodayBrief {
  date: string;
  yesterday: DailyData | null;
  /** Exact token total for yesterday (the text shows it compact). */
  yesterdayTotalTokens: number | null;
  /** `id` and `taskId` are the same value; `ref` is what `tasks done` accepts. */
  openTasks: Array<{ id: string; taskId: string; ref: string; subject: string; status: string }>;
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
  const countdown = formatCountdown(state.minutesUntilChange);
  return state.isPeak
    ? `Peak window: active (${state.peakHoursDescription}; limits may drain faster${countdown ? `; off-peak in ${countdown}` : ''})`
    : `Peak window: off-peak (peak is ${state.peakHoursDescription}${countdown ? `; next peak in ${countdown}` : ''})`;
}

/**
 * The status-line string (`acct:work · 5h 42% resets 14:00`) read as a
 * sentence for the brief: `Quota (work): 5h 42% resets 14:00`, or
 * `Quota: unavailable (no saved account)`.
 */
export function readableQuotaLine(statusline: string): string {
  const segments = statusline.split(' · ');
  const account = segments[0]?.startsWith('acct:') ? segments.shift()!.slice(5) : '';
  const rest = segments.join(' · ');
  if (!rest || rest.startsWith('quota unavailable')) {
    return account && account !== 'none'
      ? `Quota (${account}): unavailable`
      : 'Quota: unavailable (no saved account)';
  }
  return account && account !== 'none' ? `Quota (${account}): ${rest}` : `Quota: ${rest}`;
}

/** Open tasks for the brief: In Progress first, then Pending, newest first in each. */
export function openTasksForBrief(tasks: readonly PersistedTask[]): PersistedTask[] {
  return openTasksFirst(
    tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress'),
  );
}

export async function todayAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const workspacePath = (globalOpts.project as string | undefined) || process.cwd();
  const project = resolveProjectIdentity(workspacePath);
  const provider = resolveProvider(globalOpts);
  try {
    // Tasks are read whole: compact context keeps only Pending ones, which
    // would hide every In Progress task from the brief.
    const [history, context, tasks] = await Promise.all([
      readHistory(),
      composeContext(project, 'compact', provider),
      readTasks(project),
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
    const openTasks = openTasksForBrief(tasks);
    const yesterday = history?.daily?.[yesterdayKey] ?? null;
    const brief: TodayBrief = {
      date: localDateKey(new Date()),
      yesterday,
      yesterdayTotalTokens: yesterday ? summarizeTokens(yesterday.tokens).total : null,
      openTasks: openTasks.slice(0, 8).map((task) => ({
        id: task.taskId,
        taskId: task.taskId,
        ref: taskReference(task),
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
    const lines = [
      `Sidekick Today — ${brief.date}`,
      readableQuotaLine(brief.quota),
      brief.peakHours,
      '',
    ];
    if (brief.yesterday) {
      const tokens = brief.yesterdayTotalTokens ?? 0;
      const sessions = brief.yesterday.sessionCount;
      // Compact here, like every other token count; --json carries the exact total.
      lines.push(
        `Yesterday: ${sessions} session${sessions === 1 ? '' : 's'} · ${formatTokenCount(tokens)} tokens · ${formatCost(brief.yesterday.totalCost)}`,
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
