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
