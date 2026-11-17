/**
 * Tests for SessionsPanel detail rendering.
 */

import { describe, it, expect } from 'vitest';
import { SessionsPanel, hangingWrap } from './SessionsPanel';
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

describe('SessionsPanel honest costs', () => {
  const activeItem = (metrics: DashboardMetrics): PanelItem => ({
    id: 'active',
    label: 'session',
    sortKey: 0,
    data: { type: 'active', metrics },
  });
  const render = (metrics: DashboardMetrics) => {
    const panel = new SessionsPanel();
    const out = panel.detailTabs[0].render(activeItem(metrics), metrics, {} as never, {
      width: 100,
    });
    panel.dispose?.();
    return out;
  };

  it('renders "—" for an unpriced session and its unpriced model, never $0', () => {
    const base = metricsWithTasks();
    const out = render({
      ...base,
      tokens: { ...base.tokens, cost: 0, costProvenance: 'unpriced', unpricedCalls: 4 },
      modelStats: [{ model: 'acme-unknown', calls: 4, tokens: 1000, cost: 0, priced: false }],
    });
    expect(out).not.toContain('$0.0000');
    expect(out).toContain('{yellow-fg}—{/yellow-fg}');
  });

  it('marks estimated and partially priced figures', () => {
    const base = metricsWithTasks();
    const out = render({
      ...base,
      tokens: { ...base.tokens, cost: 1.5, costProvenance: 'estimated', unpricedCalls: 1 },
      modelStats: [
        { model: 'claude-opus-5-5', calls: 3, tokens: 1000, cost: 1.5, partiallyPriced: true },
      ],
    });
    expect(out).toContain('{green-fg}$1.50 (est., partial){/green-fg}');
  });

  it('shows no projected cost for an unpriced billing block', () => {
    const block = {
      id: '2026-11-01T10:00:00.000Z',
      start: '2026-11-01T10:00:00.000Z',
      end: '2026-11-01T15:00:00.000Z',
      isActive: true,
      calls: 2,
      tokens: {
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        total: 2,
      },
      costUsd: 0,
      costProvenance: 'unpriced',
      unpricedCalls: 2,
      models: {},
      elapsedMs: 3_600_000,
      remainingMs: 3_600_000,
      burnRatePerMinute: 10,
      projectedTokens: 5000,
      projectedCostUsd: 0,
    } as unknown as DashboardMetrics['billingBlock'];
    const out = render({ ...metricsWithTasks(), billingBlock: block });
    const byEnd = out.split('\n').find((line) => line.includes('by end')) ?? '';
    expect(byEnd).toContain('{yellow-fg}—{/yellow-fg}');
    expect(byEnd).not.toContain('$');
  });
});

describe('SessionsPanel narrative retry hint', () => {
  async function failNarrative(diagnosis: Record<string, unknown> | undefined): Promise<string> {
    const panel = new SessionsPanel();
    const metrics = metricsWithTasks();
    const item: PanelItem = {
      id: 'active',
      label: 's',
      sortKey: 0,
      data: { type: 'active', metrics },
    };
    const internals = panel as unknown as {
      inferenceClient: unknown;
      generateNarrative(): void;
    };
    internals.inferenceClient = {
      isAvailable: true,
      getEnableHint: () => '',
      complete: async () => ({ text: '', error: 'request failed', diagnosis }),
    };
    panel.detailTabs[6].render(item, metrics, {} as never);
    internals.generateNarrative();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const out = panel.detailTabs[6].render(item, metrics, {} as never);
    panel.dispose?.();
    return out;
  }

  const diagnosis = (overrides: Record<string, unknown>) => ({
    provider: 'claude-code',
    credentialKind: 'api-key',
    evidence: [],
    ...overrides,
  });

  it('offers a retry only when the failure is retryable', async () => {
    const overloaded = await failNarrative(
      diagnosis({ diagnosis: 'overloaded', recovery: 'retry_later', retryable: true }),
    );
    expect(overloaded).toContain("Press 'n' to retry");

    const signedOut = await failNarrative(
      diagnosis({
        diagnosis: 'missing_credentials',
        recovery: 'update_credentials',
        retryable: false,
      }),
    );
    expect(signedOut).toContain('API key is not configured');
    expect(signedOut).not.toContain("Press 'n' to retry");

    // Older diagnoses without the flag, and failures with no diagnosis, keep the hint.
    expect(
      await failNarrative(diagnosis({ diagnosis: 'timeout', recovery: 'retry_later' })),
    ).toContain("Press 'n' to retry");
    expect(await failNarrative(undefined)).toContain("Press 'n' to retry");
  });
});

describe('hangingWrap', () => {
  it('splits a long path across rows without inserting a space inside it', () => {
    const path =
      '/Users/someone/projects/sidekick/src/dashboard/ink/SessionPickerInk.frame.test.tsx';
    const rows = hangingWrap(`Edit ${path} now`, 40, 10, 6);
    for (const [i, row] of rows.entries()) {
      // First row follows the prefix; the rest hang under it at the same column.
      expect(row.length).toBeLessThanOrEqual(i === 0 ? 24 : 40);
    }
    const text = rows.map((row, i) => (i === 0 ? row : row.slice(10))).join('\n');
    // The path's pieces sit on consecutive rows; joined with nothing between
    // them they give back the path exactly, with no space inserted.
    expect(text.replace(/\n/g, '')).toContain(path);
    expect(rows.length).toBeGreaterThan(2);
  });

  it('keeps ordinary words whole and separated by single spaces', () => {
    const rows = hangingWrap('alpha beta gamma delta epsilon zeta eta theta', 30, 4);
    expect(rows.map((row, i) => (i === 0 ? row : row.slice(4))).join(' ')).toBe(
      'alpha beta gamma delta epsilon zeta eta theta',
    );
  });
});

describe('SessionsPanel Agents tab', () => {
  const stripTags = (line: string) => line.replace(/\{[^}]*\}/g, '');

  it('keeps subagent tasks and descriptions readable at a narrow width', () => {
    const panel = new SessionsPanel();
    const base = metricsWithTasks();
    const metrics = {
      ...base,
      subagents: [
        {
          id: 'a1',
          subagentType: 'general-purpose',
          description:
            'Survey the knowledge builder and the sidekick usage reports for every place they disagree',
          status: 'completed',
          durationMs: 61_000,
        },
      ],
      tasks: [
        {
          taskId: 'agent-toolu_01AaF9aPPWXcsumffvSpkwbo',
          subject: 'Survey the repository layout and summarise the build scripts',
          status: 'completed',
          subagentType: 'general-purpose',
        },
      ],
    } as unknown as DashboardMetrics;
    const item: PanelItem = { id: 'active', label: 's', sortKey: 0, data: { type: 'active' } };
    const out = panel.detailTabs[5].render(item, metrics, { width: 52 } as never);
    const lines = out.split('\n');

    // The prefix used to leave a width of 1, so the subject came out one
    // character per row (about 940 rows for one session).
    expect(lines.length).toBeLessThan(20);
    expect(lines.some((line) => /^\s*\S\s*$/.test(stripTags(line)))).toBe(false);
    for (const line of lines) expect(stripTags(line).length).toBeLessThanOrEqual(52);
    // The tool-use id is shortened for display.
    expect(out).toContain('#Spkwbo:');
    expect(out).not.toContain('agent-toolu_');
    // Words stay whole: no "kn" / "owledge" split.
    expect(out).toContain('knowledge');
    panel.dispose?.();
  });
});

describe('SessionsPanel narrative ownership', () => {
  function setup(reply: { text: string; error?: string }) {
    const panel = new SessionsPanel();
    const internals = panel as unknown as {
      inferenceClient: unknown;
      generateNarrative(): void;
    };
    internals.inferenceClient = {
      isAvailable: true,
      getEnableHint: () => '',
      complete: async () => reply,
    };
    const render = (sessionId: string) => {
      const metrics = { ...metricsWithTasks(), sessionId };
      const item: PanelItem = { id: 'active', label: 's', sortKey: 0, data: { type: 'active' } };
      return panel.detailTabs[6].render(item, metrics, { width: 60 } as never);
    };
    return { panel, internals, render };
  }

  it('does not show one session’s narrative under another session', async () => {
    const { panel, internals, render } = setup({ text: 'Session A refactored the parser.' });
    render('session-a');
    internals.generateNarrative();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render('session-a')).toContain('Session A refactored the parser.');
    // After a switch the tab starts over instead of describing session A.
    const other = render('session-b');
    expect(other).not.toContain('Session A refactored');
    expect(other).toContain('Press {bold}n{/bold} to generate.');
    panel.dispose?.();
  });

  it('reports an empty reply instead of silently showing the placeholder again', async () => {
    const { panel, internals, render } = setup({ text: '   ' });
    render('session-a');
    internals.generateNarrative();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render('session-a')).toContain('The provider returned an empty narrative');
    panel.dispose?.();
  });

  it('wraps the placeholder to the pane instead of leaving orphan words', () => {
    const { panel, render } = setup({ text: '' });
    const visible = (line: string) => line.replace(/\{[^}]+\}/g, '');
    for (const line of render('session-a').split('\n')) {
      expect(visible(line).length).toBeLessThanOrEqual(60);
    }
    panel.dispose?.();
  });
});

describe('SessionsPanel past sessions', () => {
  const activeItem: PanelItem = { id: 'active', label: 's', sortKey: 0, data: { type: 'active' } };

  it('stops the clock at the last event for a session that has ended', () => {
    const panel = new SessionsPanel();
    const start = Date.now() - 3 * 24 * 3_600_000;
    const metrics = {
      ...metricsWithTasks(),
      sessionStartTime: new Date(start).toISOString(),
      lastEventTime: new Date(start + 3_600_000).toISOString(),
    };
    const out = panel.detailTabs[0].render(
      activeItem,
      metrics,
      { sessions: [] } as never,
      {
        width: 80,
      } as never,
    );
    expect(out).toContain('01:00:00');
    expect(out).toContain('ran');
    expect(out).toContain('ended 2d ago');
    expect(out).not.toContain('elapsed{');
    // The side list shows a hollow dot for a session that is not live.
    const label = panel.getItems(metrics, { sessions: [] } as never)[0].label;
    expect(label.startsWith('○')).toBe(true);
    panel.dispose?.();
  });

  it('keeps counting while the session is live', () => {
    const panel = new SessionsPanel();
    const metrics = {
      ...metricsWithTasks(),
      sessionStartTime: new Date(Date.now() - 60_000).toISOString(),
      lastEventTime: new Date(Date.now() - 10_000).toISOString(),
    };
    const out = panel.detailTabs[0].render(
      activeItem,
      metrics,
      { sessions: [] } as never,
      {
        width: 80,
      } as never,
    );
    expect(out).toContain('elapsed');
    panel.dispose?.();
  });
});

describe('SessionsPanel Files tab', () => {
  it('keeps the read/write/edit counts on the same row as a long path', () => {
    const panel = new SessionsPanel();
    const metrics = {
      ...metricsWithTasks(),
      fileTouches: [
        {
          path: '/Users/someone/projects/sidekick/src/dashboard/ink/SessionPickerInk.frame.test.tsx',
          reads: 3,
          writes: 1,
          edits: 2,
        },
      ],
    };
    const activeItem: PanelItem = {
      id: 'active',
      label: 's',
      sortKey: 0,
      data: { type: 'active' },
    };
    const out = panel.detailTabs[4].render(
      activeItem,
      metrics,
      {} as never,
      { width: 50 } as never,
    );
    const row = out.split('\n').find((line) => line.includes('R:3')) ?? '';
    expect(row).toContain('W:1');
    expect(row).toContain('E:2');
    expect(row).toContain('SessionPickerInk.frame.test.tsx');
    expect(row.replace(/\{[^}]+\}/g, '').length).toBeLessThanOrEqual(50);
    panel.dispose?.();
  });
});
