/**
 * Shared utility for merging live tasks with persisted tasks.
 * Used by both TasksPanel and KanbanPanel.
 */

import type { TaskItem } from '../DashboardState';
import { normalizeTaskStatus } from 'sidekick-shared';
import type { PersistedTask } from 'sidekick-shared';
import { normalizeSessionId } from '../sessionScope';

/**
 * Merge persisted tasks (from disk) with live tasks (from the active session).
 *
 * Agents restart task ids at 1 in every session, so persisted tasks are keyed
 * by their session as well as their id: yesterday's #1 and today's #1 are
 * different tasks. A live task replaces the persisted copy of itself (the
 * same session, or a record that names no session) and is tagged with the
 * live session id so the session filter keeps it. Deleted persisted tasks are
 * excluded.
 */
export function mergeTasks(
  live: TaskItem[],
  persisted: PersistedTask[],
  liveSessionId?: string,
): TaskItem[] {
  const keyFor = (origin: string | undefined, taskId: string) =>
    origin ? `${normalizeSessionId(origin)}:${taskId}` : taskId;
  const map = new Map<string, TaskItem>();

  for (const p of persisted) {
    if (p.status === 'deleted') continue;
    map.set(keyFor(p.sessionOrigin, p.taskId), {
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
    const sessionKey = liveSessionId ? keyFor(liveSessionId, t.taskId) : null;
    const key =
      sessionKey && map.has(sessionKey)
        ? sessionKey
        : map.has(t.taskId)
          ? t.taskId
          : (sessionKey ?? t.taskId);
    const previous = map.get(key);
    map.set(key, {
      ...t,
      createdAt: t.createdAt ?? previous?.createdAt,
      sessionOrigin: t.sessionOrigin ?? previous?.sessionOrigin ?? liveSessionId,
    });
  }

  return Array.from(map.values());
}

/** A stable, unique list id for a merged task. */
export function taskItemId(task: TaskItem): string {
  return task.sessionOrigin ? `${normalizeSessionId(task.sessionOrigin)}:${task.taskId}` : task.taskId;
}
