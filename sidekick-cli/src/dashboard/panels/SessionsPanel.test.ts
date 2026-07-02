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
});
