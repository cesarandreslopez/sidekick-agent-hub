import { describe, expect, it } from 'vitest';
import { formatLocalDateKey } from '../formatting';
import { SYNTHETIC_MODEL } from './claudeUsageDedupe';
import {
  bucketUsage,
  summarizeUsageRows,
  usageBucketKey,
  weekKey,
  type UsageBucketRow,
} from './usageReports';
import type { UsageEventRecord } from './usageEvents';

function event(
  iso: string,
  overrides: Partial<UsageEventRecord> & { total?: number } = {},
): UsageEventRecord {
  const total = overrides.total ?? 1000;
  return {
    timestamp: Date.parse(iso),
    provider: 'claude-code',
    sessionId: 's1',
    project: '/work/a',
    model: 'claude-sonnet-4-5',
    tokens: {
      inputTokens: total / 2,
      outputTokens: total / 4,
      cacheWriteTokens: 0,
      cacheReadTokens: total / 4,
      totalTokens: total,
    },
    costUsd: 0.01,
    costProvenance: 'model-catalog',
    ...overrides,
  };
}

describe('usage bucket keys', () => {
  it('keys days by the UTC or local calendar', () => {
    const ts = Date.parse('2026-09-04T23:30:00Z');
    expect(
      usageBucketKey({ timestamp: ts, sessionId: 's' }, { granularity: 'day', utc: true }),
    ).toBe('2026-09-04');
    expect(usageBucketKey({ timestamp: ts, sessionId: 's' }, { granularity: 'day' })).toBe(
      formatLocalDateKey(ts),
    );
  });

  it('keys weeks by their start day and months by YYYY-MM', () => {
    // 2026-09-04 is a Friday.
    const friday = Date.parse('2026-09-04T12:00:00Z');
    expect(weekKey(friday, { utc: true })).toBe('2026-08-31');
    expect(weekKey(friday, { utc: true, weekStartsOn: 0 })).toBe('2026-08-30');
    expect(
      usageBucketKey({ timestamp: friday, sessionId: 's' }, { granularity: 'month', utc: true }),
    ).toBe('2026-09');
    expect(
      usageBucketKey({ timestamp: friday, sessionId: 'abc' }, { granularity: 'session' }),
    ).toBe('abc');
  });
});

describe('bucketUsage', () => {
  it('splits a session that crosses midnight across both days', () => {
    const rows = bucketUsage(
      [
        event('2026-09-04T23:30:00Z'),
        event('2026-09-05T00:30:00Z', { total: 500 }),
        event('2026-09-05T01:00:00Z', { total: 500 }),
      ],
      { granularity: 'day', utc: true },
    );

    expect(rows.map((row) => [row.key, row.calls, row.totalTokens, row.sessions])).toEqual([
      ['2026-09-04', 1, 1000, 1],
      ['2026-09-05', 2, 1000, 1],
    ]);
    expect(rows[0].tokens).toEqual({
      inputTokens: 500,
      outputTokens: 250,
      cacheWriteTokens: 0,
      cacheReadTokens: 250,
    });
    expect(rows[0].provider).toBe('claude-code');
    expect(rows[0].project).toBeNull();
    expect(rows[0].model).toBeNull();
    expect(rows[0].models).toEqual(['claude-sonnet-4-5']);
  });

  it('groups by provider by default and adds model and project dimensions on request', () => {
    const events = [
      event('2026-09-04T12:00:00Z'),
      event('2026-09-04T13:00:00Z', { provider: 'codex', model: 'gpt-5-codex', sessionId: 's2' }),
      event('2026-09-04T14:00:00Z', {
        model: 'claude-opus-4-1',
        project: '/work/b',
        sessionId: 's3',
        total: 4000,
      }),
    ];

    const byProvider = bucketUsage(events, { granularity: 'day', utc: true });
    expect(byProvider.map((row) => [row.provider, row.calls, row.sessions])).toEqual([
      ['claude-code', 2, 2],
      ['codex', 1, 1],
    ]);
    expect(byProvider[0].models).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5']);

    const byModel = bucketUsage(events, {
      granularity: 'day',
      utc: true,
      groupBy: ['provider', 'model'],
    });
    expect(byModel.map((row) => [row.provider, row.model])).toEqual([
      ['claude-code', 'claude-opus-4-1'],
      ['claude-code', 'claude-sonnet-4-5'],
      ['codex', 'gpt-5-codex'],
    ]);

    const byProject = bucketUsage(events, {
      granularity: 'day',
      utc: true,
      groupBy: ['project'],
    });
    expect(byProject.map((row) => [row.project, row.provider, row.calls])).toEqual([
      ['/work/a', null, 2],
      ['/work/b', null, 1],
    ]);
  });

  it('produces one row per session ordered by first event', () => {
    const rows = bucketUsage(
      [
        event('2026-09-04T12:00:00Z', { sessionId: 'later' }),
        event('2026-09-03T12:00:00Z', { sessionId: 'earlier', project: '/work/b' }),
        event('2026-09-04T12:30:00Z', { sessionId: 'later' }),
      ],
      { granularity: 'session' },
    );
    expect(
      rows.map((row) => [row.key, row.sessionId, row.project, row.calls, row.sessions]),
    ).toEqual([
      ['earlier', 'earlier', '/work/b', 1, 1],
      ['later', 'later', '/work/a', 2, 1],
    ]);
    expect(rows[1].firstTimestamp).toBe(Date.parse('2026-09-04T12:00:00Z'));
    expect(rows[1].lastTimestamp).toBe(Date.parse('2026-09-04T12:30:00Z'));
  });

  it('classifies cost provenance per row and across totals', () => {
    const rows = bucketUsage(
      [
        event('2026-09-04T12:00:00Z', { costUsd: 0.5, costProvenance: 'provider-reported' }),
        event('2026-09-04T12:10:00Z'),
        event('2026-09-05T12:00:00Z', {
          costUsd: null,
          costProvenance: 'unpriced',
          model: 'mystery',
        }),
      ],
      { granularity: 'day', utc: true },
    );
    expect(rows.map((row) => [row.key, row.costProvenance, row.unpricedCalls])).toEqual([
      ['2026-09-04', 'mixed', 0],
      ['2026-09-05', 'unpriced', 1],
    ]);
    expect(rows[0].costUsd).toBeCloseTo(0.51, 9);

    const totals = summarizeUsageRows(rows);
    expect(totals).toMatchObject({
      calls: 3,
      sessions: 2,
      totalTokens: 3000,
      unpricedCalls: 1,
      costProvenance: 'mixed',
    });
    expect(totals.costUsd).toBeCloseTo(0.51, 9);
  });

  it('counts distinct sessions in totals from the events when rows span sessions', () => {
    const events = [
      event('2026-09-04T12:00:00Z', { sessionId: 'a' }),
      event('2026-09-05T12:00:00Z', { sessionId: 'a' }),
      event('2026-09-05T13:00:00Z', { sessionId: 'b' }),
    ];
    const rows = bucketUsage(events, { granularity: 'day', utc: true });
    // Row-level sessions would double count session `a` (2 + 1 = 3).
    expect(summarizeUsageRows(rows, events).sessions).toBe(2);
    expect(summarizeUsageRows(rows).sessions).toBe(3);
  });

  it('returns no rows for no events', () => {
    expect(bucketUsage([], { granularity: 'week' })).toEqual([]);
    expect(summarizeUsageRows([]).costProvenance).toBe('none');
  });
});

describe('bucketUsage — session dimension, priced cost, reasoning, synthetic', () => {
  it('splits a time bucket per session when grouping by session', () => {
    const events = [
      event('2026-09-04T12:30:00Z', { sessionId: 'b' }),
      event('2026-09-04T12:00:00Z', { sessionId: 'a' }),
      event('2026-09-04T13:00:00Z', { sessionId: 'a', total: 500 }),
      event('2026-09-05T09:00:00Z', { sessionId: 'a' }),
    ];
    for (const granularity of ['day', 'week', 'month'] as const) {
      const rows = bucketUsage(events, { granularity, utc: true, groupBy: ['session'] });
      expect(rows.every((row) => row.sessionId !== null && row.provider === null)).toBe(true);
      expect(rows.every((row) => row.sessions === 1)).toBe(true);
    }
    const days = bucketUsage(events, { granularity: 'day', utc: true, groupBy: ['session'] });
    expect(days.map((row) => [row.key, row.sessionId, row.calls, row.totalTokens])).toEqual([
      ['2026-09-04', 'a', 2, 1500],
      ['2026-09-04', 'b', 1, 1000],
      ['2026-09-05', 'a', 1, 1000],
    ]);
    const months = bucketUsage(events, {
      granularity: 'month',
      utc: true,
      groupBy: ['provider', 'session'],
    });
    expect(months.map((row) => [row.key, row.provider, row.sessionId, row.calls])).toEqual([
      ['2026-09', 'claude-code', 'a', 3],
      ['2026-09', 'claude-code', 'b', 1],
    ]);
    // Session rows already carry their id; the dimension changes nothing there.
    expect(bucketUsage(events, { granularity: 'session', groupBy: ['session'] })).toEqual(
      bucketUsage(events, { granularity: 'session' }),
    );
    // Without the dimension, time rows keep a null session id.
    expect(bucketUsage(events, { granularity: 'day', utc: true })[0].sessionId).toBeNull();
    // Totals count each session once from session-grouped rows.
    expect(summarizeUsageRows(days).sessions).toBe(2);
  });

  it('reports the priced cost, or null when nothing in the row was priced', () => {
    const rows = bucketUsage(
      [
        event('2026-09-04T12:00:00Z', { costUsd: 0.25 }),
        event('2026-09-04T12:10:00Z', { costUsd: null, costProvenance: 'unpriced' }),
        event('2026-09-05T12:00:00Z', { costUsd: null, costProvenance: 'unpriced' }),
        event('2026-09-06T12:00:00Z', { costUsd: 0, costProvenance: 'provider-reported' }),
      ],
      { granularity: 'day', utc: true },
    );
    expect(rows.map((row) => [row.key, row.costUsd, row.pricedCostUsd])).toEqual([
      ['2026-09-04', 0.25, 0.25],
      ['2026-09-05', 0, null],
      ['2026-09-06', 0, 0],
    ]);
    expect(summarizeUsageRows(rows)).toMatchObject({ costUsd: 0.25, pricedCostUsd: 0.25 });
    expect(summarizeUsageRows([rows[1]]).pricedCostUsd).toBeNull();
    expect(summarizeUsageRows([]).pricedCostUsd).toBeNull();
  });

  it('sums reasoning tokens into rows and totals, 0 when none', () => {
    const base = event('2026-09-04T12:00:00Z');
    const withReasoning = (iso: string, reasoningTokens: number) =>
      event(iso, { tokens: { ...base.tokens, reasoningTokens } });
    const rows = bucketUsage(
      [
        withReasoning('2026-09-04T12:00:00Z', 200),
        withReasoning('2026-09-04T13:00:00Z', 50),
        event('2026-09-05T12:00:00Z'),
      ],
      { granularity: 'day', utc: true },
    );
    expect(rows.map((row) => [row.key, row.reasoningTokens, row.totalTokens])).toEqual([
      ['2026-09-04', 250, 2000],
      ['2026-09-05', 0, 1000],
    ]);
    expect(summarizeUsageRows(rows).reasoningTokens).toBe(250);
  });

  it('drops synthetic placeholder events only with excludeSynthetic', () => {
    const events = [
      event('2026-09-04T12:00:00Z'),
      event('2026-09-04T12:05:00Z', {
        model: SYNTHETIC_MODEL,
        costUsd: null,
        costProvenance: 'unpriced',
        total: 0,
      }),
    ];
    const kept = bucketUsage(events, { granularity: 'day', utc: true });
    expect(kept[0]).toMatchObject({ calls: 2, unpricedCalls: 1 });
    expect(kept[0].models).toContain(SYNTHETIC_MODEL);

    const dropped = bucketUsage(events, { granularity: 'day', utc: true, excludeSynthetic: true });
    expect(dropped[0]).toMatchObject({ calls: 1, unpricedCalls: 0, costProvenance: 'estimated' });
    expect(dropped[0].models).toEqual(['claude-sonnet-4-5']);
    expect(
      bucketUsage([events[1]], { granularity: 'day', utc: true, excludeSynthetic: true }),
    ).toEqual([]);
  });

  it('merges spellings of one model only with modelKey canonical', () => {
    const events = [
      event('2026-09-04T12:00:00Z', { model: 'claude-opus-5-5-20261001' }),
      event('2026-09-04T12:05:00Z', { model: 'claude-opus-5-5' }),
      event('2026-09-04T12:10:00Z', { model: 'us.anthropic.claude-opus-5-5-20261001-v1:0' }),
    ];
    const raw = bucketUsage(events, { granularity: 'day', utc: true, groupBy: ['model'] });
    expect(raw).toHaveLength(3);
    const merged = bucketUsage(events, {
      granularity: 'day',
      utc: true,
      groupBy: ['model'],
      modelKey: 'canonical',
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ model: 'claude-opus-5-5', calls: 3 });
    expect(merged[0].models).toEqual(['claude-opus-5-5']);
  });

  it('totals rows built before pricedCostUsd existed from their priced calls', () => {
    const [row] = bucketUsage([event('2026-09-04T12:00:00Z', { costUsd: 0.5 })], {
      granularity: 'day',
      utc: true,
    });
    const { pricedCostUsd: _priced, reasoningTokens: _reasoning, ...legacy } = row;
    const legacyUnpriced = { ...legacy, costUsd: 0, unpricedCalls: legacy.calls };
    expect(summarizeUsageRows([legacy as UsageBucketRow]).pricedCostUsd).toBe(0.5);
    expect(summarizeUsageRows([legacyUnpriced as UsageBucketRow]).pricedCostUsd).toBeNull();
  });
});
