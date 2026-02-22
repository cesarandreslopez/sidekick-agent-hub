import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { readTasks } from './tasks';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
  },
}));

const mockStore = {
  schemaVersion: 1,
  tasks: {
    '1': { taskId: '1', subject: 'Task One', status: 'pending', sessionAge: 0, blockedBy: [], blocks: [], sessionOrigin: 'abc', carriedOver: false, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z', toolCallCount: 5 },
    '2': { taskId: '2', subject: 'Task Two', status: 'completed', sessionAge: 1, blockedBy: [], blocks: [], sessionOrigin: 'abc', carriedOver: true, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-03T00:00:00Z', toolCallCount: 3 },
    '3': { taskId: '3', subject: 'Task Three', status: 'pending', sessionAge: 2, blockedBy: [], blocks: [], sessionOrigin: 'def', carriedOver: true, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', toolCallCount: 0, isGoalGate: true },
  },
  lastSessionId: 'abc',
  sessionCount: 2,
  lastSaved: '2025-01-03T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockStore));
});

describe('readTasks', () => {
  it('returns all tasks by default', async () => {
    const tasks = await readTasks('test-slug');
    expect(tasks).toHaveLength(3);
  });

  it('filters by pending status', async () => {
    const tasks = await readTasks('test-slug', { status: 'pending' });
    expect(tasks).toHaveLength(2);
    expect(tasks.every(t => t.status === 'pending')).toBe(true);
  });

  it('filters by completed status', async () => {
    const tasks = await readTasks('test-slug', { status: 'completed' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe('Task Two');
  });

  it('sorts by updatedAt descending', async () => {
    const tasks = await readTasks('test-slug');
    expect(tasks[0].subject).toBe('Task Two');
    expect(tasks[tasks.length - 1].subject).toBe('Task Three');
  });

  it('returns empty array when file does not exist', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
    const tasks = await readTasks('nonexistent');
    expect(tasks).toEqual([]);
  });
});
