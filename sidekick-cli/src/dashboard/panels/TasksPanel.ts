/**
 * Tasks panel — consolidates TaskBoardPage logic.
 * Shows merged live + persisted tasks with status actions.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab } from './types';
import type { DashboardMetrics, TaskItem } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import { wordWrap, detailWidth } from '../formatters';
import { mergeTasks } from '../utils/taskMerger';

const STATUS_SORT: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

const STATUS_ICON: Record<string, string> = {
  in_progress: '{green-fg}\u2192{/green-fg}',
  pending: '{yellow-fg}\u25CB{/yellow-fg}',
  completed: '{cyan-fg}\u2713{/cyan-fg}',
};

export class TasksPanel implements SidePanel {
  readonly id = 'tasks';
  readonly title = 'Tasks';
  readonly shortcutKey = 2;
  readonly emptyStateHint = 'Tasks appear as your agent works.';

  readonly detailTabs: DetailTab[] = [
    { label: 'Detail', render: (item, m) => this.renderDetail(item, m) },
  ];

  getItems(metrics: DashboardMetrics, staticData: StaticData): PanelItem[] {
    const tasks = mergeTasks(metrics.tasks, staticData.tasks);
    return tasks.map(t => ({
      id: t.taskId,
      label: `${STATUS_ICON[t.status] || ' '} ${t.subject}`,
      sortKey: (STATUS_SORT[t.status] ?? 3) * 1000 + parseInt(t.taskId, 10),
      data: t,
    }));
  }

  getActions(): PanelAction[] {
    return [];
  }

  // ── Detail renderers ──

  private renderDetail(item: PanelItem, metrics: DashboardMetrics): string {
    const t = item.data as TaskItem;
    const lines = [
      `{bold}${wordWrap(`#${t.taskId}: ${t.subject}`, detailWidth())}{/bold}`,
      '',
      `{bold}Status:{/bold}      ${STATUS_ICON[t.status] || ''} ${t.status}`,
    ];

    if (t.subagentType) lines.push(`{bold}Subagent:{/bold}    ${t.subagentType}`);
    if (t.isGoalGate) lines.push(`{bold}Goal Gate:{/bold}   {red-fg}\u2691 yes{/red-fg}`);
    if (t.toolCallCount > 0) lines.push(`{bold}Tool Calls:{/bold}  ${t.toolCallCount}`);
    if (t.activeForm && t.status === 'in_progress') {
      lines.push(`{bold}Active:{/bold}      {green-fg}${t.activeForm}{/green-fg}`);
    }

    if (t.blockedBy.length > 0) {
      lines.push('', '{bold}Blocked By{/bold} (must complete first):');
      for (const id of t.blockedBy) {
        lines.push(`  {yellow-fg}\u25CB{/yellow-fg} #${id}`);
      }
    }
    if (t.blocks.length > 0) {
      lines.push('', '{bold}Blocks{/bold} (waiting on this):');
      for (const id of t.blocks) {
        lines.push(`  {cyan-fg}\u25B6{/cyan-fg} #${id}`);
      }
    }

    // Show related tasks from live task list
    const related = metrics.tasks.filter(
      other => other.taskId !== t.taskId &&
      (t.blockedBy.includes(other.taskId) || t.blocks.includes(other.taskId))
    );
    if (related.length > 0) {
      lines.push('', '{bold}Related Tasks{/bold}');
      for (const r of related) {
        lines.push(`  ${STATUS_ICON[r.status] || ' '} #${r.taskId}: ${wordWrap(r.subject, detailWidth() - 8)}`);
      }
    }

    return lines.join('\n');
  }

}
