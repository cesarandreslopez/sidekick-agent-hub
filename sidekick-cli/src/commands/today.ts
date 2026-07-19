import type { Command } from 'commander';
import {
  composeContext,
  formatCost,
  formatStatusline,
  getActiveAccountStatus,
  readHistory,
  readQuotaSnapshot,
  resolveProjectIdentity,
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

// Daily buckets in historical-data.json are keyed by UTC date (the writer
// derives keys from ISO timestamps), so lookups must use UTC dates too.
function utcDateKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function scheduledPeakHoursLine(now = new Date()): string {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  const active = weekday && hour >= 13 && hour < 19;
  return active
    ? 'Peak window: active (weekday 13:00–19:00 UTC; limits may drain faster)'
    : 'Peak window: off-peak (weekday peak is 13:00–19:00 UTC)';
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
    const yesterdayKey = utcDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
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
      date: utcDateKey(new Date()),
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
      const tokens = brief.yesterday.tokens.inputTokens + brief.yesterday.tokens.outputTokens;
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
