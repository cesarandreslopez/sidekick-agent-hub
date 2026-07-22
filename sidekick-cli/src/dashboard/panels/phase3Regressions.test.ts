import { describe, expect, it } from 'vitest';
import { DashboardState, type DashboardMetrics, type TaskItem } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import { PlansPanel } from './PlansPanel';
import { TasksPanel } from './TasksPanel';
import { mergeTasks } from '../utils/taskMerger';

function metrics(overrides: Partial<DashboardMetrics> = {}): DashboardMetrics {
  return { ...new DashboardState().getMetrics(), ...overrides };
}

const EMPTY_STATIC = {
  sessions: [],
  tasks: [],
  decisions: [],
  notes: [],
  plans: [],
  totalTokens: 0,
  totalCost: 0,
  totalSessions: 0,
} as StaticData;

describe('Phase 3 panel regressions', () => {
  it('deduplicates the active plan using the real session id', () => {
    const panel = new PlansPanel();
    const active = {
      title: 'Ship it',
      source: 'claude-code' as const,
      completionRate: 0.5,
      steps: [],
    };
    const items = panel.getItems(metrics({ sessionId: 'session-uuid', plan: active }), {
      ...EMPTY_STATIC,
      plans: [
        {
          sessionId: 'session-uuid',
          title: 'Ship it',
          source: 'claude-code',
          status: 'in_progress',
          createdAt: '2026-07-21T12:00:00Z',
          completionRate: 0.5,
          steps: [],
        },
      ],
    });
    expect(items.map((item) => item.id)).toEqual(['active-plan']);
  });

  it('assigns finite status-grouped sort keys to non-numeric task ids', () => {
    const panel = new TasksPanel();
    const task = (taskId: string, status: TaskItem['status']): TaskItem => ({
      taskId,
      subject: taskId,
      status,
      blockedBy: [],
      blocks: [],
      toolCallCount: 0,
    });
    const items = panel.getItems(
      metrics({ tasks: [task('toolu_abc', 'completed'), task('plan-step', 'in_progress')] }),
      EMPTY_STATIC,
    );
    expect(items.every((item) => Number.isFinite(item.sortKey))).toBe(true);
    expect(items.find((item) => item.id === 'plan-step')!.sortKey).toBeLessThan(
      items.find((item) => item.id === 'toolu_abc')!.sortKey,
    );
  });

  it('preserves persisted timestamps when live tasks overwrite content', () => {
    const live = {
      taskId: '1',
      subject: 'Live subject',
      status: 'in_progress' as const,
      blockedBy: [],
      blocks: [],
      toolCallCount: 0,
    };
    const [merged] = mergeTasks(
      [live],
      [
        {
          taskId: '1',
          subject: 'Persisted subject',
          status: 'pending',
          createdAt: '2026-07-21T12:00:00Z',
          sessionOrigin: 'session-1',
        },
      ],
    );
    expect(merged).toMatchObject({
      subject: 'Live subject',
      createdAt: '2026-07-21T12:00:00Z',
      sessionOrigin: 'session-1',
    });
  });
});
