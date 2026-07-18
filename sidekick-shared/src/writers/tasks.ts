import * as crypto from 'crypto';
import { getProjectDataPath, resolveProjectIdentity } from '../paths';
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

export async function completeTask(cwd: string, taskIdOrPrefix: string): Promise<PersistedTask> {
  const project = resolveProjectIdentity(cwd);
  const filePath = getProjectDataPath(project.canonicalSlug, 'tasks');
  let completed: PersistedTask | undefined;
  await updateJsonStoreAtomic(filePath, emptyTaskStore, (store) => {
    const matches = Object.values(store.tasks).filter(
      (task) => task.taskId === taskIdOrPrefix || task.taskId.startsWith(taskIdOrPrefix),
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0 ? `Task not found: ${taskIdOrPrefix}` : 'Task ID is ambiguous',
      );
    }
    const now = new Date().toISOString();
    completed = { ...matches[0], status: 'completed', updatedAt: now };
    return {
      ...store,
      tasks: { ...store.tasks, [completed!.taskId]: completed! },
      lastSaved: now,
    };
  });
  return completed!;
}
