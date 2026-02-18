/**
 * @fileoverview Tests for TaskPersistenceService.
 *
 * Tests persistence round-trip, carried-over marking, status downgrade,
 * clear/archive actions, subagent filtering, ID collisions, and error handling.
 *
 * @module TaskPersistenceService.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskPersistenceService } from './TaskPersistenceService';
import type { TaskState, TrackedTask, ToolCall } from '../types/claudeSession';
import type { TaskPersistenceStore } from '../types/taskPersistence';
import { TASK_PERSISTENCE_SCHEMA_VERSION } from '../types/taskPersistence';

// Mock vscode module
vi.mock('vscode', () => ({
  Disposable: { from: vi.fn() },
}));

// Mock Logger
vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

/** Creates a TrackedTask for testing */
function makeTask(overrides: Partial<TrackedTask> & { taskId: string }): TrackedTask {
  return {
    subject: `Task ${overrides.taskId}`,
    status: 'pending',
    createdAt: new Date('2026-02-18T10:00:00Z'),
    updatedAt: new Date('2026-02-18T10:05:00Z'),
    activeForm: undefined,
    blockedBy: [],
    blocks: [],
    associatedToolCalls: [],
    description: undefined,
    ...overrides,
  };
}

/** Creates a TaskState from an array of tasks */
function makeTaskState(tasks: TrackedTask[]): TaskState {
  const map = new Map<string, TrackedTask>();
  for (const task of tasks) {
    map.set(task.taskId, task);
  }
  return { tasks: map, activeTaskId: null };
}

/** Temp directory for test files */
let tmpDir: string;

/** Helper to create a service pointing at a temp dir */
function createService(slug = 'test-project'): TaskPersistenceService {
  const service = new TaskPersistenceService(slug);
  // Override the data file path to use our temp dir
  const dataFilePath = path.join(tmpDir, `${slug}.json`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).dataFilePath = dataFilePath;
  return service;
}

describe('TaskPersistenceService', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-task-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('creates empty store when no file exists', async () => {
      const service = createService();
      await service.initialize();

      const tasks = service.loadPersistedTasks();
      expect(tasks).toEqual([]);
    });

    it('loads existing store from disk', async () => {
      const store: TaskPersistenceStore = {
        schemaVersion: TASK_PERSISTENCE_SCHEMA_VERSION,
        tasks: {
          '1': {
            taskId: '1',
            subject: 'Test task',
            status: 'pending',
            createdAt: '2026-02-18T10:00:00.000Z',
            updatedAt: '2026-02-18T10:05:00.000Z',
            toolCallCount: 3,
            blockedBy: [],
            blocks: [],
            sessionOrigin: 'session-aaa',
            carriedOver: false,
            sessionAge: 0,
          },
        },
        lastSessionId: 'session-aaa',
        sessionCount: 1,
        lastSaved: '2026-02-18T10:06:00.000Z',
      };

      const filePath = path.join(tmpDir, 'test-project.json');
      fs.writeFileSync(filePath, JSON.stringify(store));

      const service = createService();
      await service.initialize();

      const tasks = service.loadPersistedTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].subject).toBe('Test task');
    });

    it('falls back to empty store on corrupt JSON', async () => {
      const filePath = path.join(tmpDir, 'test-project.json');
      fs.writeFileSync(filePath, 'not valid json{{{');

      const service = createService();
      await service.initialize();

      const tasks = service.loadPersistedTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe('saveSessionTasks', () => {
    it('persists tasks and can round-trip load them', async () => {
      const service = createService();
      await service.initialize();

      const taskState = makeTaskState([
        makeTask({ taskId: '1', subject: 'Fix bug', status: 'completed' }),
        makeTask({ taskId: '2', subject: 'Add feature', status: 'pending' }),
      ]);

      service.saveSessionTasks('session-111', taskState);
      service.dispose(); // triggers sync save

      // Reload from disk
      const service2 = createService();
      await service2.initialize();
      const tasks = service2.loadPersistedTasks();

      expect(tasks).toHaveLength(2);
      expect(tasks.find(t => t.taskId === '1')?.subject).toBe('Fix bug');
      expect(tasks.find(t => t.taskId === '2')?.subject).toBe('Add feature');
      service2.dispose();
    });

    it('skips deleted tasks', async () => {
      const service = createService();
      await service.initialize();

      const taskState = makeTaskState([
        makeTask({ taskId: '1', status: 'deleted' }),
        makeTask({ taskId: '2', status: 'pending' }),
      ]);

      service.saveSessionTasks('session-111', taskState);
      service.dispose();

      const service2 = createService();
      await service2.initialize();
      const tasks = service2.loadPersistedTasks();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].taskId).toBe('2');
      service2.dispose();
    });

    it('skips subagent tasks', async () => {
      const service = createService();
      await service.initialize();

      const taskState = makeTaskState([
        makeTask({ taskId: '1', isSubagent: true, subagentType: 'Explore' }),
        makeTask({ taskId: '2', status: 'pending' }),
      ]);

      service.saveSessionTasks('session-111', taskState);
      service.dispose();

      const service2 = createService();
      await service2.initialize();
      const tasks = service2.loadPersistedTasks();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].taskId).toBe('2');
      service2.dispose();
    });

    it('converts Date fields to ISO strings and toolCalls to count', async () => {
      const service = createService();
      await service.initialize();

      const task = makeTask({
        taskId: '1',
        createdAt: new Date('2026-01-15T08:00:00Z'),
        updatedAt: new Date('2026-01-15T09:30:00Z'),
        associatedToolCalls: [
          { name: 'Read', input: {}, timestamp: new Date() } as ToolCall,
          { name: 'Write', input: {}, timestamp: new Date() } as ToolCall,
          { name: 'Bash', input: {}, timestamp: new Date() } as ToolCall,
        ],
      });

      service.saveSessionTasks('session-111', makeTaskState([task]));
      service.dispose();

      const service2 = createService();
      await service2.initialize();
      const tasks = service2.loadPersistedTasks();

      expect(tasks[0].createdAt).toBe('2026-01-15T08:00:00.000Z');
      expect(tasks[0].updatedAt).toBe('2026-01-15T09:30:00.000Z');
      expect(tasks[0].toolCallCount).toBe(3);
      service2.dispose();
    });

    it('handles task ID collision by namespacing old entry', async () => {
      const service = createService();
      await service.initialize();

      // Session 1: task ID "1"
      service.saveSessionTasks(
        'session-aaaa1111-bbbb-cccc-dddd-eeeeeeee',
        makeTaskState([makeTask({ taskId: '1', subject: 'Old task' })])
      );

      // Session 2: same task ID "1"
      service.saveSessionTasks(
        'session-2222',
        makeTaskState([makeTask({ taskId: '1', subject: 'New task' })])
      );

      service.dispose();

      const service2 = createService();
      await service2.initialize();
      const tasks = service2.loadPersistedTasks();

      // Both tasks should exist
      expect(tasks).toHaveLength(2);
      const subjects = tasks.map(t => t.subject).sort();
      expect(subjects).toEqual(['New task', 'Old task']);

      // The new task should be under "1", old under namespaced key
      const rawStore = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'test-project.json'), 'utf-8')
      ) as TaskPersistenceStore;
      expect(rawStore.tasks['1'].subject).toBe('New task');
      expect(rawStore.tasks['session-:1'].subject).toBe('Old task');
      service2.dispose();
    });
  });

  describe('loadPersistedTasks', () => {
    it('sets carriedOver=true and increments sessionAge for prior session tasks', async () => {
      const store: TaskPersistenceStore = {
        schemaVersion: TASK_PERSISTENCE_SCHEMA_VERSION,
        tasks: {
          '1': {
            taskId: '1',
            subject: 'Prior task',
            status: 'pending',
            createdAt: '2026-02-18T10:00:00.000Z',
            updatedAt: '2026-02-18T10:05:00.000Z',
            toolCallCount: 0,
            blockedBy: [],
            blocks: [],
            sessionOrigin: 'session-old',
            carriedOver: false,
            sessionAge: 1,
          },
        },
        lastSessionId: 'session-current',
        sessionCount: 2,
        lastSaved: '2026-02-18T10:06:00.000Z',
      };

      fs.writeFileSync(
        path.join(tmpDir, 'test-project.json'),
        JSON.stringify(store)
      );

      const service = createService();
      await service.initialize();
      const tasks = service.loadPersistedTasks();

      expect(tasks[0].carriedOver).toBe(true);
      expect(tasks[0].sessionAge).toBe(2); // incremented from 1
      service.dispose();
    });

    it('downgrades in_progress tasks from prior sessions to pending', async () => {
      const store: TaskPersistenceStore = {
        schemaVersion: TASK_PERSISTENCE_SCHEMA_VERSION,
        tasks: {
          '1': {
            taskId: '1',
            subject: 'Was running',
            status: 'in_progress',
            createdAt: '2026-02-18T10:00:00.000Z',
            updatedAt: '2026-02-18T10:05:00.000Z',
            toolCallCount: 5,
            blockedBy: [],
            blocks: [],
            sessionOrigin: 'session-old',
            carriedOver: false,
            sessionAge: 0,
          },
        },
        lastSessionId: 'session-current',
        sessionCount: 1,
        lastSaved: '2026-02-18T10:06:00.000Z',
      };

      fs.writeFileSync(
        path.join(tmpDir, 'test-project.json'),
        JSON.stringify(store)
      );

      const service = createService();
      await service.initialize();
      const tasks = service.loadPersistedTasks();

      expect(tasks[0].status).toBe('pending');
      service.dispose();
    });

    it('does not mutate store when returning copies', async () => {
      const store: TaskPersistenceStore = {
        schemaVersion: TASK_PERSISTENCE_SCHEMA_VERSION,
        tasks: {
          '1': {
            taskId: '1',
            subject: 'Test',
            status: 'in_progress',
            createdAt: '2026-02-18T10:00:00.000Z',
            updatedAt: '2026-02-18T10:05:00.000Z',
            toolCallCount: 0,
            blockedBy: [],
            blocks: [],
            sessionOrigin: 'session-old',
            carriedOver: false,
            sessionAge: 0,
          },
        },
        lastSessionId: 'session-current',
        sessionCount: 1,
        lastSaved: '2026-02-18T10:06:00.000Z',
      };

      fs.writeFileSync(
        path.join(tmpDir, 'test-project.json'),
        JSON.stringify(store)
      );

      const service = createService();
      await service.initialize();
      service.loadPersistedTasks();

      // Store should still have in_progress (not mutated to pending)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internalStore = (service as any).store as TaskPersistenceStore;
      expect(internalStore.tasks['1'].status).toBe('in_progress');
      service.dispose();
    });
  });

  describe('clearCompleted', () => {
    it('removes only completed tasks', async () => {
      const service = createService();
      await service.initialize();

      service.saveSessionTasks('session-111', makeTaskState([
        makeTask({ taskId: '1', status: 'completed' }),
        makeTask({ taskId: '2', status: 'pending' }),
        makeTask({ taskId: '3', status: 'completed' }),
      ]));

      service.clearCompleted();
      service.dispose();

      const service2 = createService();
      await service2.initialize();
      const tasks = service2.loadPersistedTasks();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].taskId).toBe('2');
      service2.dispose();
    });
  });

  describe('archiveAll', () => {
    it('removes all tasks', async () => {
      const service = createService();
      await service.initialize();

      service.saveSessionTasks('session-111', makeTaskState([
        makeTask({ taskId: '1', status: 'completed' }),
        makeTask({ taskId: '2', status: 'pending' }),
      ]));

      service.archiveAll();
      service.dispose();

      const service2 = createService();
      await service2.initialize();
      const tasks = service2.loadPersistedTasks();

      expect(tasks).toHaveLength(0);
      service2.dispose();
    });
  });

  describe('dispose', () => {
    it('writes dirty data synchronously on dispose', async () => {
      const service = createService();
      await service.initialize();

      service.saveSessionTasks('session-111', makeTaskState([
        makeTask({ taskId: '1', status: 'pending' }),
      ]));

      // Don't wait for debounce — just dispose
      service.dispose();

      // File should exist and contain the task
      const filePath = path.join(tmpDir, 'test-project.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const store = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TaskPersistenceStore;
      expect(Object.keys(store.tasks)).toHaveLength(1);
      expect(store.tasks['1'].subject).toBe('Task 1');
    });

    it('does not write when not dirty', async () => {
      const service = createService();
      await service.initialize();
      service.dispose();

      // No file should be created (empty store, never dirtied)
      const filePath = path.join(tmpDir, 'test-project.json');
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('sessionCount tracking', () => {
    it('increments sessionCount on each saveSessionTasks call', async () => {
      const service = createService();
      await service.initialize();

      service.saveSessionTasks('session-1', makeTaskState([
        makeTask({ taskId: '1' }),
      ]));
      service.saveSessionTasks('session-2', makeTaskState([
        makeTask({ taskId: '2' }),
      ]));

      service.dispose();

      const store = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'test-project.json'), 'utf-8')
      ) as TaskPersistenceStore;
      expect(store.sessionCount).toBe(2);
      expect(store.lastSessionId).toBe('session-2');
    });
  });
});
