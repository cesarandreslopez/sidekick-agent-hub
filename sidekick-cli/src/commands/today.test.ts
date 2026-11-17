import { describe, expect, it, vi } from 'vitest';

vi.mock('../cli', () => ({ resolveProvider: vi.fn() }));

import type { PersistedTask } from 'sidekick-shared';
import {
  compactBriefText,
  openTasksForBrief,
  readableQuotaLine,
  scheduledPeakHoursLine,
} from './today';

describe('scheduledPeakHoursLine', () => {
  it('reports the documented weekday peak window without a network lookup', () => {
    expect(scheduledPeakHoursLine(new Date('2026-07-20T15:00:00Z'))).toContain('active');
    expect(scheduledPeakHoursLine(new Date('2026-07-20T20:00:00Z'))).toContain('off-peak');
    expect(scheduledPeakHoursLine(new Date('2026-07-19T15:00:00Z'))).toContain('off-peak');
  });

  it('keeps long handoffs compact enough for the one-screen brief', () => {
    expect(compactBriefText('line one\n\nline two')).toBe('line one line two');
    expect(compactBriefText('x'.repeat(200), 20)).toHaveLength(20);
  });
});

function task(taskId: string, status: PersistedTask['status']): PersistedTask {
  return {
    taskId,
    subject: taskId,
    status,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    toolCallCount: 0,
    blockedBy: [],
    blocks: [],
    sessionOrigin: 'cli',
    carriedOver: false,
    sessionAge: 0,
  };
}

describe('today brief', () => {
  it('keeps In Progress tasks, listed before Pending ones', () => {
    const open = openTasksForBrief([
      task('p1', 'pending'),
      task('done', 'completed'),
      task('w1', 'in_progress'),
      task('gone', 'deleted'),
    ]);
    expect(open.map((entry) => entry.taskId)).toEqual(['w1', 'p1']);
  });

  it('reads the status-line string as a sentence', () => {
    expect(readableQuotaLine('acct:none · quota unavailable')).toBe(
      'Quota: unavailable (no saved account)',
    );
    expect(readableQuotaLine('acct:work · quota unavailable')).toBe('Quota (work): unavailable');
    expect(readableQuotaLine('acct:work · 5h 42% resets 14:00 · 7d 61%')).toBe(
      'Quota (work): 5h 42% resets 14:00 · 7d 61%',
    );
  });

  it('says when the peak window changes', () => {
    expect(scheduledPeakHoursLine(new Date('2026-07-20T15:00:00Z'))).toContain('off-peak in 4h 0m');
  });
});
