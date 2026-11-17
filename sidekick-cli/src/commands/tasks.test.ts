import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersistedTask } from 'sidekick-shared';
import { openTasksFirst, printTasksTable, taskReference } from './tasks';

function task(
  taskId: string,
  status: PersistedTask['status'],
  sessionOrigin = 'cli',
): PersistedTask {
  return {
    taskId,
    subject: `${status} ${taskId}`,
    status,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    toolCallCount: 1,
    blockedBy: [],
    blocks: [],
    sessionOrigin,
    carriedOver: false,
    sessionAge: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tasks', () => {
  it('names a CLI task by its UUID prefix and a session task by session and id', () => {
    expect(taskReference(task('a1b2c3d4-0000-4000-8000-000000000000', 'pending'))).toBe('a1b2c3d4');
    expect(taskReference(task('5', 'pending', '5f2e9c1a-1111-4000-8000-000000000000'))).toBe(
      '5f2e9c1a:5',
    );
  });

  it('lists open work first and keeps each group in its order', () => {
    const ordered = openTasksFirst([
      task('1', 'completed'),
      task('2', 'pending'),
      task('3', 'in_progress'),
      task('4', 'pending'),
    ]);
    expect(ordered.map((entry) => entry.taskId)).toEqual(['3', '2', '4', '1']);
  });

  it('prints each row with a reference `tasks done` accepts, and the shown count', () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    printTasksTable([task('5', 'pending', '5f2e9c1a-1111-4000-8000-000000000000')], 12);
    const text = out.join('');
    expect(text).toContain('Tasks (1 of 12)');
    expect(text).toContain('5f2e9c1a:5  pending 5');
    expect(text).toMatch(/1 tool call(?!s)/);
  });
});
