import { describe, expect, it } from 'vitest';
import { formatLocalDateKey } from '../formatting';
import { bucketUsage, summarizeUsageRows, usageBucketKey, weekKey } from './usageReports';
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
