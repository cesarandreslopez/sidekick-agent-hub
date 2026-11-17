import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectDataPath, resolveProjectIdentity, setConfigDir } from '../paths';
import type { PersistedTask, TaskPersistenceStore } from '../types/taskPersistence';
import { addTask, completeTask } from './tasks';

let configDir: string;
let workspaceDir: string;

function sessionTask(taskId: string, sessionOrigin: string, subject: string): PersistedTask {
  return {
    taskId,
    subject,
    status: 'pending',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    toolCallCount: 0,
    blockedBy: [],
    blocks: [],
    sessionOrigin,
    carriedOver: false,
    sessionAge: 0,
  };
}

function storePath(): string {
  return getProjectDataPath(resolveProjectIdentity(workspaceDir).canonicalSlug, 'tasks');
}

function writeStore(tasks: Record<string, PersistedTask>): void {
  const store: TaskPersistenceStore = {
    schemaVersion: 1,
    tasks,
    lastSessionId: 'cccccccc-session',
    sessionCount: 3,
    lastSaved: '2026-11-01T10:00:00.000Z',
  } as TaskPersistenceStore;
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store));
}

function readStore(): TaskPersistenceStore {
  return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as TaskPersistenceStore;
}

describe('completeTask', () => {
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-tasks-config-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-tasks-workspace-'));
    setConfigDir(configDir);
  });

  afterEach(() => {
    setConfigDir(null);
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  // Session tasks keep their agent's short ids; a collision files the older
  // one under `<origin8>:<id>` while its taskId stays the bare id.
  const colliding = () => ({
    '5': sessionTask('5', 'cccccccc-session', 'current five'),
    'aaaaaaaa:5': sessionTask('5', 'aaaaaaaa-session', 'old five'),
    'bbbbbbbb:5': sessionTask('5', 'bbbbbbbb-session', 'older five'),
  });

  it('completes a namespaced entry under its own key, leaving the bare one alone', async () => {
    writeStore(colliding());
    const done = await completeTask(workspaceDir, 'aaaaaaaa:5');
    expect(done.subject).toBe('old five');
    const store = readStore();
    expect(store.tasks['aaaaaaaa:5'].status).toBe('completed');
    expect(store.tasks['5'].status).toBe('pending');
    expect(store.tasks['5'].subject).toBe('current five');
    expect(Object.keys(store.tasks)).toHaveLength(3);
  });

  it('prefers an exact store key over the other entries sharing the id', async () => {
    writeStore(colliding());
    const done = await completeTask(workspaceDir, '5');
    expect(done.subject).toBe('current five');
    expect(readStore().tasks['aaaaaaaa:5'].status).toBe('pending');
  });

  it('resolves the namespaced reference even when the entry is still under its bare key', async () => {
    writeStore({ '5': sessionTask('5', 'cccccccc-session', 'current five') });
    const done = await completeTask(workspaceDir, 'cccccccc:5');
    expect(done.subject).toBe('current five');
    expect(readStore().tasks['5'].status).toBe('completed');
  });

  it('lists the candidates when a reference still names several tasks', async () => {
    writeStore({
      'aaaaaaaa:7': sessionTask('7', 'aaaaaaaa-session', 'seven a'),
      'bbbbbbbb:7': sessionTask('7', 'bbbbbbbb-session', 'seven b'),
    });
    await expect(completeTask(workspaceDir, '7')).rejects.toThrow(
      /matches 2 tasks[\s\S]*aaaaaaaa:7 {2}seven a[\s\S]*bbbbbbbb:7 {2}seven b/,
    );
  });

  it('accepts a unique prefix of a CLI task id, and reports an unknown id', async () => {
    const task = await addTask(workspaceDir, 'from the cli');
    const done = await completeTask(workspaceDir, task.taskId.slice(0, 8));
    expect(done.taskId).toBe(task.taskId);
    expect(readStore().tasks[task.taskId].status).toBe('completed');
    await expect(completeTask(workspaceDir, 'nope')).rejects.toThrow('Task not found: nope');
  });
});
