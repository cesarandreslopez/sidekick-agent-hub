import * as crypto from 'crypto';
import { getProjectDataPath, resolveProjectIdentity } from '../paths';
import { migrateLegacyProjectStores } from '../projectMigration';
import {
  TASK_PERSISTENCE_SCHEMA_VERSION,
  type PersistedTask,
  type TaskPersistenceStore,
} from '../types/taskPersistence';
import { updateJsonStoreAtomic } from './atomic';

function emptyTaskStore(): TaskPersistenceStore {
  return {
    schemaVersion: TASK_PERSISTENCE_SCHEMA_VERSION,
    tasks: {},
    lastSessionId: 'cli',
    sessionCount: 0,
    lastSaved: new Date().toISOString(),
  };
}

export async function addTask(
  cwd: string,
  subject: string,
  options: { description?: string; tags?: string[] } = {},
): Promise<PersistedTask> {
  const project = resolveProjectIdentity(cwd);
  migrateLegacyProjectStores(project);
  const filePath = getProjectDataPath(project.canonicalSlug, 'tasks');
  const now = new Date().toISOString();
  const task: PersistedTask = {
    taskId: crypto.randomUUID(),
    subject: subject.trim(),
    description: options.description,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    toolCallCount: 0,
    blockedBy: [],
    blocks: [],
    sessionOrigin: 'cli',
    carriedOver: false,
    sessionAge: 0,
    tags: options.tags,
  };
  await updateJsonStoreAtomic(filePath, emptyTaskStore, (store) => ({
    ...store,
    schemaVersion: TASK_PERSISTENCE_SCHEMA_VERSION,
    tasks: { ...store.tasks, [task.taskId]: task },
    lastSessionId: store.lastSessionId || 'cli',
    lastSaved: now,
  }));
  return task;
}

/** The reference a session task is filed under when its short id collides (`<origin8>:<id>`). */
function namespacedTaskRef(task: PersistedTask): string {
  return `${(task.sessionOrigin ?? '').slice(0, 8)}:${task.taskId}`;
}

/**
 * The single store entry a reference names, by precedence: an exact store key,
 * an exact `<origin8>:<taskId>`, an exact task id, then a unique task-id
 * prefix. Session tasks keep their agent's short ids (`5`, `plan-0`), so the
 * same task id can appear many times; a reference that still names several
 * entries is reported with the candidates instead of guessing.
 */
function resolveTaskEntry(store: TaskPersistenceStore, ref: string): [string, PersistedTask] {
  const tasks = store.tasks ?? {};
  if (Object.hasOwn(tasks, ref)) return [ref, tasks[ref]];
  const entries = Object.entries(tasks);
  const stages: Array<(task: PersistedTask) => boolean> = [
    (task) => namespacedTaskRef(task) === ref,
    (task) => task.taskId === ref,
    (task) => task.taskId.startsWith(ref),
  ];
  for (const stage of stages) {
    const matches = entries.filter(([, task]) => stage(task));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const shown = matches
        .slice(0, 8)
        .map(([, task]) => `  ${namespacedTaskRef(task)}  ${task.subject}`);
      if (matches.length > shown.length) shown.push(`  … ${matches.length - shown.length} more`);
      throw new Error(
        [`Task ID "${ref}" matches ${matches.length} tasks. Use one of:`, ...shown].join('\n'),
      );
    }
  }
  throw new Error(`Task not found: ${ref}`);
}

export async function completeTask(cwd: string, taskIdOrPrefix: string): Promise<PersistedTask> {
  const project = resolveProjectIdentity(cwd);
  migrateLegacyProjectStores(project);
  const filePath = getProjectDataPath(project.canonicalSlug, 'tasks');
  const ref = taskIdOrPrefix.trim();
  if (!ref) throw new Error('A task ID is required');
  let completed: PersistedTask | undefined;
  await updateJsonStoreAtomic(filePath, emptyTaskStore, (store) => {
    const [key, task] = resolveTaskEntry(store, ref);
    const now = new Date().toISOString();
    completed = { ...task, status: 'completed', updatedAt: now };
    // Written back under the key it was found at: completing a namespaced
    // entry must not overwrite the bare-id entry another session owns.
    return {
      ...store,
      tasks: { ...store.tasks, [key]: completed },
      lastSaved: now,
    };
  });
  return completed!;
}
