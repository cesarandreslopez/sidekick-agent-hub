/**
 * Reader for persisted tasks.
 */

import type { PersistedTask, TaskPersistenceStore } from '../types/taskPersistence';
import { getProjectDataPath } from '../paths';
import { readJsonStore } from './helpers';

export interface ReadTasksOptions {
  status?: 'pending' | 'completed' | 'all';
}

export async function readTasks(slug: string, opts?: ReadTasksOptions): Promise<PersistedTask[]> {
  const filePath = getProjectDataPath(slug, 'tasks');
  const store = await readJsonStore<TaskPersistenceStore>(filePath);
  if (!store) return [];

  let tasks = Object.values(store.tasks);

  const status = opts?.status ?? 'all';
  if (status !== 'all') {
    tasks = tasks.filter(t => t.status === status);
  }

  // Sort by updatedAt descending
  tasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return tasks;
}
