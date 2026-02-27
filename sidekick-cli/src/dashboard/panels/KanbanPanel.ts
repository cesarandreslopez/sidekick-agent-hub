/**
 * Kanban panel — task board with 3 status columns.
 * Shows Pending, Active, and Completed groups with task cards in the detail pane.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab } from './types';
import type { DashboardMetrics, TaskItem } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import { normalizeTaskStatus } from 'sidekick-shared';
import type { PersistedTask } from 'sidekick-shared';
import { wordWrap, detailWidth } from '../formatters';

const STATUS_ICON: Record<string, string> = {
  pending: '{yellow-fg}\u25CB{/yellow-fg}',
  in_progress: '{green-fg}\u2192{/green-fg}',
  completed: '{cyan-fg}\u2713{/cyan-fg}',
};

interface ColumnData {
  status: string;
  tasks: TaskItem[];
}

export class KanbanPanel implements SidePanel {
  readonly id = 'kanban';
  readonly title = 'Kanban';
  readonly shortcutKey = 3;

  readonly detailTabs: DetailTab[] = [
    { label: 'Board', render: (item, m) => this.renderBoard(item, m) },
  ];

  getItems(metrics: DashboardMetrics, staticData: StaticData): PanelItem[] {
    const tasks = this.mergeTasks(metrics.tasks, staticData.tasks);

    const pending = tasks.filter(t => t.status === 'pending');
    const active = tasks.filter(t => t.status === 'in_progress');
    const completed = tasks.filter(t => t.status === 'completed');

    return [
      {
        id: 'col-pending',
        label: `{yellow-fg}\u25CB{/yellow-fg} Pending (${pending.length})`,
        sortKey: 0,
        data: { status: 'pending', tasks: pending } as ColumnData,
      },
      {
        id: 'col-active',
        label: `{green-fg}\u2192{/green-fg} Active (${active.length})`,
        sortKey: 1,
        data: { status: 'in_progress', tasks: active } as ColumnData,
      },
      {
        id: 'col-completed',
        label: `{cyan-fg}\u2713{/cyan-fg} Completed (${completed.length})`,
        sortKey: 2,
        data: { status: 'completed', tasks: completed } as ColumnData,
      },
    ];
  }

  getActions(): PanelAction[] {
    return [];
  }

  getSearchableText(item: PanelItem): string {
    const col = item.data as ColumnData;
    return col.tasks.map(t => t.subject).join(' ');
  }

  private mergeTasks(live: TaskItem[], persisted: PersistedTask[]): TaskItem[] {
    const map = new Map<string, TaskItem>();

    for (const p of persisted) {
      if (p.status === 'deleted') continue;
      map.set(p.taskId, {
        taskId: p.taskId,
        subject: p.subject,
        status: normalizeTaskStatus(p.status),
        blockedBy: p.blockedBy || [],
        blocks: p.blocks || [],
        subagentType: p.subagentType,
        isGoalGate: p.isGoalGate,
        toolCallCount: p.toolCallCount,
        activeForm: p.activeForm,
        sessionOrigin: p.sessionOrigin,
        createdAt: p.createdAt,
      });
    }

    for (const t of live) {
      map.set(t.taskId, t);
    }

    return Array.from(map.values());
  }

  // ── Detail renderer ──

  private renderBoard(item: PanelItem, metrics: DashboardMetrics): string {
    const col = item.data as ColumnData;
    const lines: string[] = [];

    const statusLabel = col.status === 'in_progress' ? 'Active' : col.status.charAt(0).toUpperCase() + col.status.slice(1);
    lines.push(`{bold}${statusLabel}{/bold} (${col.tasks.length} tasks)`);
    lines.push('');

    if (col.tasks.length === 0) {
      lines.push('{grey-fg}(no tasks in this column){/grey-fg}');
      return lines.join('\n');
    }

    for (const t of col.tasks) {
      const icon = STATUS_ICON[t.status] || ' ';
      lines.push(`${icon} {bold}#${t.taskId}: ${wordWrap(t.subject, detailWidth() - 6)}{/bold}`);

      const details: string[] = [];
      if (t.subagentType) details.push(`{magenta-fg}\u229B ${t.subagentType}{/magenta-fg}`);
      if (t.isGoalGate) details.push('{red-fg}\u2691 goal gate{/red-fg}');
      if (t.toolCallCount > 0) details.push(`${t.toolCallCount} tool calls`);
      if (t.activeForm && t.status === 'in_progress') details.push(`{green-fg}${t.activeForm}{/green-fg}`);

      if (details.length > 0) {
        lines.push(`    ${details.join('  ')}`);
      }

      // Dependencies
      if (t.blockedBy.length > 0) {
        const blockerSubjects = t.blockedBy.map(id => {
          const blocker = metrics.tasks.find(o => o.taskId === id);
          return blocker ? `#${id} ${blocker.subject}` : `#${id}`;
        });
        lines.push(`    {yellow-fg}\u25CB blocked by: ${wordWrap(blockerSubjects.join(', '), detailWidth() - 20)}{/yellow-fg}`);
      }
      if (t.blocks.length > 0) {
        lines.push(`    {cyan-fg}\u25B6 blocks: ${t.blocks.map(id => '#' + id).join(', ')}{/cyan-fg}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }
}
