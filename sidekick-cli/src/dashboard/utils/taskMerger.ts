/**
 * Shared utility for merging live tasks with persisted tasks.
 * Used by both TasksPanel and KanbanPanel.
 */

import type { TaskItem } from '../DashboardState';
import { normalizeTaskStatus } from 'sidekick-shared';
import type { PersistedTask } from 'sidekick-shared';

/**
 * Merge persisted tasks (from disk) with live tasks (from active sessions).
 * Live tasks override persisted ones with the same taskId.
 * Deleted persisted tasks are excluded.
 */
export function mergeTasks(live: TaskItem[], persisted: PersistedTask[]): TaskItem[] {
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
