/**
 * @fileoverview Cross-session task persistence service.
 *
 * Persists Kanban board tasks to disk so incomplete tasks carry forward
 * across Claude Code sessions. Follows the HistoricalDataService pattern:
 * dirty tracking, debounced saves, synchronous dispose.
 *
 * Storage location: ~/.config/sidekick/tasks/{projectSlug}.json
 *
 * @module services/TaskPersistenceService
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { TaskState } from '../types/claudeSession';
import type {
  PersistedTask,
  TaskPersistenceStore,
} from '../types/taskPersistence';
import { TASK_PERSISTENCE_SCHEMA_VERSION } from '../types/taskPersistence';
import { log, logError } from './Logger';

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
export class TaskPersistenceService implements vscode.Disposable {
  /** In-memory data store */
  private store: TaskPersistenceStore;

  /** Path to the JSON file on disk */
  private dataFilePath: string;

  /** Whether data has unsaved changes */
  private isDirty: boolean = false;

  /** Debounce timer for saves */
  private saveTimer: NodeJS.Timeout | null = null;

  /** Save debounce delay (5 seconds) */
  private readonly SAVE_DEBOUNCE_MS = 5000;

  /**
   * Creates a new TaskPersistenceService.
   *
   * @param projectSlug - Encoded workspace path used as filename
   */
  constructor(private readonly projectSlug: string) {
    this.store = createEmptyStore();
    this.dataFilePath = this.getDataFilePath();
  }

  /**
   * Gets the path to the data file based on platform.
   */
  private getDataFilePath(): string {
    let configDir: string;

    if (process.platform === 'win32') {
      configDir = path.join(process.env.APPDATA || os.homedir(), 'sidekick', 'tasks');
    } else {
      configDir = path.join(os.homedir(), '.config', 'sidekick', 'tasks');
    }

    return path.join(configDir, `${this.projectSlug}.json`);
  }

  /**
   * Initializes the service by loading existing data or creating new store.
   */
  async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`Created task persistence directory: ${dir}`);
      }

      if (fs.existsSync(this.dataFilePath)) {
        const content = await fs.promises.readFile(this.dataFilePath, 'utf-8');
        const loaded = JSON.parse(content) as TaskPersistenceStore;

        if (loaded.schemaVersion !== TASK_PERSISTENCE_SCHEMA_VERSION) {
          log(`Task persistence schema version mismatch: ${loaded.schemaVersion} vs ${TASK_PERSISTENCE_SCHEMA_VERSION}`);
        }

        this.store = loaded;
        log(`Loaded persisted tasks: ${Object.keys(this.store.tasks).length} tasks from ${this.store.sessionCount} sessions`);
      } else {
        this.store = createEmptyStore();
        log('Initialized new task persistence store');
      }
    } catch (error) {
      logError('Failed to load persisted tasks, starting with empty store', error);
      this.store = createEmptyStore();
    }
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
      };

      this.store.tasks[taskId] = persisted;
    }

    this.store.lastSessionId = sessionId;
    this.store.sessionCount++;
    this.isDirty = true;
    this.scheduleSave();

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
      this.isDirty = true;
      this.scheduleSave();
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
      this.isDirty = true;
      this.scheduleSave();
      log(`Archived all ${count} tasks`);
    }
  }

  /**
   * Schedules a debounced save to disk.
   */
  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.save();
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * Saves data to disk immediately.
   */
  private async save(): Promise<void> {
    if (!this.isDirty) {
      return;
    }

    try {
      this.store.lastSaved = new Date().toISOString();
      const content = JSON.stringify(this.store, null, 2);
      await fs.promises.writeFile(this.dataFilePath, content, 'utf-8');
      this.isDirty = false;
      log('Task persistence data saved to disk');
    } catch (error) {
      logError('Failed to save task persistence data', error);
    }
  }

  /**
   * Disposes of the service, saving any pending data synchronously.
   */
  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.isDirty) {
      try {
        this.store.lastSaved = new Date().toISOString();
        const content = JSON.stringify(this.store, null, 2);
        fs.writeFileSync(this.dataFilePath, content, 'utf-8');
        log('Task persistence data saved on dispose');
      } catch (error) {
        logError('Failed to save task persistence data on dispose', error);
      }
    }
  }
}
