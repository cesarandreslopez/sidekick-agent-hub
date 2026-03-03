/**
 * @fileoverview Cross-session task persistence service.
 *
 * Persists Kanban board tasks to disk so incomplete tasks carry forward
 * across Claude Code sessions.
 *
 * Storage location: ~/.config/sidekick/tasks/{projectSlug}.json
 *
 * @module services/TaskPersistenceService
 */

import type { TaskState } from '../types/claudeSession';
import type {
  PersistedTask,
  TaskPersistenceStore,
} from '../types/taskPersistence';
import { TASK_PERSISTENCE_SCHEMA_VERSION } from '../types/taskPersistence';
import { PersistenceService, resolveSidekickDataPath } from './PersistenceService';
import { log } from './Logger';

/**
 * Creates an empty persistence store.
 */
function createEmptyStore(): TaskPersistenceStore {
  return {
    schemaVersion: TASK_PERSISTENCE_SCHEMA_VERSION,
    tasks: {},
    lastSessionId: '',
    sessionCount: 0,
    lastSaved: new Date().toISOString(),
  };
}

/**
 * Service for persisting tasks across Claude Code sessions.
 *
 * @example
 * ```typescript
 * const service = new TaskPersistenceService('my-project-slug');
 * await service.initialize();
 *
 * // On session end
 * service.saveSessionTasks(sessionId, taskState);
 *
 * // On next session start
 * const tasks = service.loadPersistedTasks();
 * ```
 */
export class TaskPersistenceService extends PersistenceService<TaskPersistenceStore> {
  constructor(projectSlug: string) {
    super(
      resolveSidekickDataPath('tasks', `${projectSlug}.json`),
      'Task persistence',
      TASK_PERSISTENCE_SCHEMA_VERSION,
      createEmptyStore,
    );
  }

  protected override onStoreLoaded(): void {
    log(`Loaded persisted tasks: ${Object.keys(this.store.tasks).length} tasks from ${this.store.sessionCount} sessions`);
  }

  /**
   * Persists tasks from the current session.
   *
   * Converts TrackedTask instances to PersistedTask records. Skips deleted
   * and subagent tasks. Handles task ID collisions across sessions by
   * namespacing old entries.
   *
   * @param sessionId - Current session identifier
   * @param taskState - Task state from SessionMonitor
   */
  saveSessionTasks(sessionId: string, taskState: TaskState): void {
    for (const [taskId, task] of taskState.tasks) {
      // Skip deleted tasks and subagent tasks (session-local)
      if (task.status === 'deleted' || task.isSubagent) {
        continue;
      }

      // Handle task ID collision: if existing task has different session origin
      const existing = this.store.tasks[taskId];
      if (existing && existing.sessionOrigin !== sessionId) {
        const namespacedKey = `${existing.sessionOrigin.slice(0, 8)}:${taskId}`;
        this.store.tasks[namespacedKey] = existing;
        delete this.store.tasks[taskId];
      }

      // Convert TrackedTask → PersistedTask
      const persisted: PersistedTask = {
        taskId,
        subject: task.subject || 'Untitled task',
        description: task.description,
        status: task.status,
        activeForm: task.activeForm,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
        toolCallCount: task.associatedToolCalls.length,
        blockedBy: [...task.blockedBy],
        blocks: [...task.blocks],
        sessionOrigin: sessionId,
        carriedOver: false,
        sessionAge: 0,
        isGoalGate: task.isGoalGate,
      };

      this.store.tasks[taskId] = persisted;
    }

    this.store.lastSessionId = sessionId;
    this.store.sessionCount++;
    this.markDirty();

    log(`Persisted ${taskState.tasks.size} tasks for session ${sessionId.slice(0, 8)}`);
  }

  /**
   * Loads persisted tasks for board display.
   *
   * Returns copies with carriedOver/sessionAge adjusted for the current session.
   * Tasks that were in_progress in a prior session are downgraded to pending
   * (they can't still be running).
   *
   * @returns Array of persisted tasks ready for display
   */
  loadPersistedTasks(): PersistedTask[] {
    const lastSessionId = this.store.lastSessionId;
    return Object.values(this.store.tasks).map(task => {
      const copy = { ...task };

      // Tasks from prior sessions are carried over
      if (task.sessionOrigin !== lastSessionId) {
        copy.carriedOver = true;
        copy.sessionAge = task.sessionAge + 1;
      } else {
        copy.carriedOver = true;
        copy.sessionAge = task.sessionAge;
      }

      // Can't still be running from a prior session
      if (copy.status === 'in_progress') {
        copy.status = 'pending';
      }

      // Criterion 3: auto-flag old pending tasks as goal gates
      if (copy.sessionAge >= 2 && copy.status === 'pending' && !copy.isGoalGate) {
        copy.isGoalGate = true;
      }

      return copy;
    });
  }

  /**
   * Removes completed tasks from the store.
   */
  clearCompleted(): void {
    const before = Object.keys(this.store.tasks).length;
    for (const [key, task] of Object.entries(this.store.tasks)) {
      if (task.status === 'completed') {
        delete this.store.tasks[key];
      }
    }
    const removed = before - Object.keys(this.store.tasks).length;
    if (removed > 0) {
      this.markDirty();
      log(`Cleared ${removed} completed tasks`);
    }
  }

  /**
   * Removes all tasks from the store.
   */
  archiveAll(): void {
    const count = Object.keys(this.store.tasks).length;
    this.store.tasks = {};
    if (count > 0) {
      this.markDirty();
      log(`Archived all ${count} tasks`);
    }
  }
}
