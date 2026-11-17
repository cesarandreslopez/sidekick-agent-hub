import { describe, expect, it } from 'vitest';
import { formatDateTime, plural } from './formatters';
import { PlansPanel } from './panels/PlansPanel';
import { DashboardState } from './DashboardState';
import type { StaticData } from './StaticDataLoader';

describe('plural', () => {
  it('uses the singular for one', () => {
    expect(plural(1, 'call')).toBe('1 call');
    expect(plural(0, 'call')).toBe('0 calls');
    expect(plural(2, 'session')).toBe('2 sessions');
  });
});

describe('formatDateTime', () => {
  it('shows local date and time instead of a raw UTC ISO string', () => {
    const out = formatDateTime('2026-11-14T00:05:08.781Z');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(out).not.toContain('Z');
    expect(formatDateTime(undefined)).toBe('unknown');
  });
});

describe('Plans side-list labels', () => {
  it('lead with the date and use the first step for a generic title', () => {
    const plan = (createdAt: string, step: string) => ({
      id: createdAt,
      projectSlug: 'p',
      sessionId: createdAt,
      title: 'Plan',
      source: 'codex',
      createdAt,
      status: 'completed',
      steps: [{ id: 's1', description: step, status: 'completed' }],
      completionRate: 1,
    });
    const staticData = {
      sessions: [],
      tasks: [],
      decisions: [],
      notes: [],
      plans: [
        plan('2026-11-05T10:00:00Z', 'Audit the picker'),
        plan('2026-11-06T10:00:00Z', 'Fix the toast stack'),
      ],
      totalTokens: 0,
      totalCost: 0,
      totalSessions: 0,
    } as unknown as StaticData;
    const labels = new PlansPanel()
      .getItems(new DashboardState().getMetrics(), staticData)
      .map((item) => item.label);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('11-05 Audit the picker');
    expect(labels[1]).toContain('11-06 Fix the toast stack');
    const visible = labels.map((label) => label.replace(/\{[^}]*\}/g, '').slice(0, 21));
    expect(new Set(visible).size).toBe(2);
  });
});
