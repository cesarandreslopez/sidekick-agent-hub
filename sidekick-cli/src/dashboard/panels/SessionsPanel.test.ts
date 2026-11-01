/**
 * Tests for SessionsPanel detail rendering.
 */

import { describe, it, expect } from 'vitest';
import { SessionsPanel } from './SessionsPanel';
import { DashboardState } from '../DashboardState';
import type { DashboardMetrics } from '../DashboardState';
import type { PanelItem } from './types';

function metricsWithTasks(): DashboardMetrics {
  const base = new DashboardState().getMetrics();
  return {
    ...base,
    eventCount: 3,
    tasks: [
      { status: 'completed' },
      { status: 'completed' },
      { status: 'completed' },
      { status: 'in_progress' },
      { status: 'pending' },
    ] as DashboardMetrics['tasks'],
  };
}

describe('SessionsPanel Summary tab', () => {
  it('renders the tasks summary with the total count interpolated', () => {
    const panel = new SessionsPanel();
    const metrics = metricsWithTasks();
    const item: PanelItem = {
      id: 'active',
      label: 'session',
      sortKey: 0,
      data: { type: 'active', metrics },
    };
    const out = panel.detailTabs[0].render(item, metrics, {
      sessions: [],
    } as unknown as Parameters<(typeof panel.detailTabs)[0]['render']>[2]);
    // Regression: a missing '$' rendered this as "3/ completed"
    expect(out).toContain('3{/bold}/5');
    expect(out).not.toContain('/{m.tasks.length}');
    panel.dispose?.();
  });

  it('uses the real session id in the active-session label', () => {
    const panel = new SessionsPanel();
    const items = panel.getItems(metricsWithTasks(), { sessions: [] } as unknown as Parameters<
      typeof panel.getItems
    >[1]);
    const withId = panel.getItems({ ...metricsWithTasks(), sessionId: 'abcdef12-rest' }, {
      sessions: [],
    } as unknown as Parameters<typeof panel.getItems>[1]);
    expect(items[0].label).toContain('session-active');
    expect(withId[0].label).toContain('session-abcdef12');
    panel.dispose?.();
  });

  it('renders quota failures by wrapped line rather than by character', () => {
    const panel = new SessionsPanel();
    const metrics = {
      ...metricsWithTasks(),
      providerId: 'claude-code',
      quota: {
        available: false,
        failureKind: 'auth',
        error: 'Authentication is required for quota refresh',
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
      },
    } as DashboardMetrics;
    const item: PanelItem = {
      id: 'active',
      label: 'session',
      sortKey: 0,
      data: { type: 'active', metrics },
    };
    const out = panel.detailTabs[0].render(item, metrics, {} as never, { width: 50 });
    expect(out).toContain('Sign in');
    expect(out.split('\n').filter((line) => line.includes('{grey-fg}')).length).toBeLessThan(20);
    panel.dispose?.();
  });

  it('draws only the windows a plan has, plus extra meters', () => {
    const panel = new SessionsPanel();
    const metrics = {
      ...metricsWithTasks(),
      providerId: 'claude-code',
      quota: {
        available: true,
        fiveHour: { utilization: 0, resetsAt: '', absent: true },
        sevenDay: { utilization: 17, resetsAt: '2026-11-07T06:00:00Z' },
        projectedSevenDay: 136,
        planLabel: 'Ultra',
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            label: '7-Day (Fable)',
            utilization: 4,
            resetsAt: '2026-11-07T06:00:00Z',
            windowMs: 7 * 86_400_000,
            scopeModel: 'Fable',
          },
        ],
      },
    } as DashboardMetrics;
    const item: PanelItem = {
      id: 'active',
      label: 'session',
      sortKey: 0,
      data: { type: 'active', metrics },
    };
    const out = panel.detailTabs[0].render(item, metrics, {} as never, { width: 80 });
    expect(out).not.toContain('{grey-fg}5h{/grey-fg}');
    expect(out).toContain('{grey-fg}7d{/grey-fg}');
    expect(out).toContain('{grey-fg}7d Fable{/grey-fg}');
    expect(out).toContain('no 5-hour limit on Ultra');
    panel.dispose?.();
  });
});
