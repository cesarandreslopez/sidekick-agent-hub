import { describe, expect, it } from 'vitest';
import { formatLocalDateKey, addLocalDays } from 'sidekick-shared';
import {
  buildHistoricalSummary,
  buildHourlyPoints,
  drillDownTarget,
} from './HistoricalSummaryBuilder';
import type { HistoricalSummarySource } from './HistoricalSummaryBuilder';
import type { DailyData, HourlyData, SessionHistoryRecord } from '../types/historicalData';

const NOW = new Date(2026, 8, 4, 12, 0, 0); // local midday, 2026-09-04
const TODAY = formatLocalDateKey(NOW);

function tokens(n: number) {
  return { inputTokens: n, outputTokens: n / 10, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

function day(date: string, n: number): DailyData {
  return {
    date,
    tokens: tokens(n),
    totalCost: n / 1000,
    messageCount: 3,
    sessionCount: 1,
    modelUsage: [
      { model: 'claude-sonnet-4-5', calls: 2, tokens: n * 0.8, cost: n / 1250 },
      { model: 'claude-haiku-4-5', calls: 1, tokens: n * 0.2, cost: n / 5000 },
    ],
    toolUsage: [{ tool: 'Read', calls: 5, successCount: 5, failureCount: 0 }],
    updatedAt: '',
  };
}

function session(project: string, startTime: Date, n: number): SessionHistoryRecord {
  return {
    sessionId: `s-${project}-${startTime.getTime()}`,
    provider: 'claude-code',
    project,
    startTime: startTime.toISOString(),
    endTime: startTime.toISOString(),
    tokens: tokens(n),
    totalCost: n / 1000,
    messageCount: 4,
    modelUsage: [{ model: 'claude-sonnet-4-5', calls: 4, tokens: n, cost: n / 1000 }],
    toolUsage: [{ tool: 'Bash', calls: 2, successCount: 2, failureCount: 0 }],
    qualityScore: 80,
    qualityFactors: [],
    additions: 0,
    deletions: 0,
    costPerChangedLine: null,
  };
}

function source(): HistoricalSummarySource {
  const daily = new Map<string, DailyData>();
  for (let back = 0; back < 20; back += 1) {
    const key = addLocalDays(TODAY, -back);
    daily.set(key, day(key, 1000 + back));
  }
  const hourly: Record<string, HourlyData[]> = {
    [TODAY]: [9, 10, 14].map((hour) => ({
      hour,
      tokens: tokens(100),
      totalCost: 0.1,
      messageCount: 1,
      sessionCount: 1,
    })),
    [addLocalDays(TODAY, -1)]: [11].map((hour) => ({
      hour,
      tokens: tokens(50),
      totalCost: 0.05,
      messageCount: 1,
      sessionCount: 1,
    })),
  };
  const sessions = [
    session('/work/alpha', new Date(2026, 8, 4, 9, 30), 500),
    session('/work/alpha', new Date(2026, 8, 3, 18, 0), 700),
    session('/work/beta', new Date(2026, 8, 4, 10, 0), 900),
    session('/work/beta', new Date(2026, 7, 20, 10, 0), 300),
  ];
  return {
    getDailyData: (start, end) =>
      [...daily.values()]
        .filter((d) => d.date >= start && d.date <= end)
        .sort((a, b) => a.date.localeCompare(b.date)),
    getHourlyData: (date) => hourly[date] ?? [],
    getMonthlyData: () => [],
    getAllTimeStats: () => ({ firstDate: '2026-07-01', lastDate: TODAY }),
    getSessionRecords: () => sessions,
  };
}

describe('buildHistoricalSummary', () => {
  it('returns one point per hourly bucket for today, with yesterday as the previous period', () => {
    const summary = buildHistoricalSummary(source(), 'today', { now: NOW });
    expect(summary.granularity).toBe('hourly');
    expect(summary.dataPoints.map((p) => p.label)).toEqual(['9AM', '10AM', '2PM']);
    expect(summary.totals.inputTokens).toBe(300);
    expect(summary.previousPeriod?.map((p) => p.label)).toEqual(['11AM']);
    expect(buildHourlyPoints(source(), TODAY)).toHaveLength(3);
  });

  it('attaches model breakdowns and series keys ordered by weight', () => {
    const summary = buildHistoricalSummary(source(), 'week', { series: 'model', now: NOW });
    expect(summary.dataPoints).toHaveLength(7);
    expect(summary.seriesKeys).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5']);
    expect(summary.dataPoints[0].breakdown?.['claude-sonnet-4-5']).toMatchObject({ calls: 2 });

    const tools = buildHistoricalSummary(source(), 'week', { series: 'tool', now: NOW });
    expect(tools.seriesKeys).toEqual(['Read']);
    expect(tools.dataPoints[0].breakdown?.Read).toEqual({ tokens: 0, cost: 0, calls: 5 });

    const total = buildHistoricalSummary(source(), 'week', { now: NOW });
    expect(total.seriesKeys).toEqual([]);
    expect(total.dataPoints[0].breakdown).toBeUndefined();
  });

  it('covers the prior seven days as the previous period for a week', () => {
    const summary = buildHistoricalSummary(source(), 'week', { now: NOW });
    expect(summary.dataPoints.map((p) => p.timestamp)).toEqual(
      [6, 5, 4, 3, 2, 1, 0].map((back) => addLocalDays(TODAY, -back)),
    );
    expect(summary.previousPeriod?.map((p) => p.timestamp)).toEqual(
      [13, 12, 11, 10, 9, 8, 7].map((back) => addLocalDays(TODAY, -back)),
    );
  });

  it('aggregates one project from the session records and lists every project', () => {
    const all = buildHistoricalSummary(source(), 'week', { now: NOW });
    const alpha = buildHistoricalSummary(source(), 'week', {
      project: '/work/alpha',
      now: NOW,
      series: 'tool',
    });

    expect(all.projects).toEqual(['/work/alpha', '/work/beta']);
    expect(alpha.project).toBe('/work/alpha');
    expect(alpha.dataPoints).toHaveLength(2);
    expect(alpha.totals.inputTokens).toBe(1200);
    expect(alpha.totals.sessionCount).toBe(2);
    expect(alpha.totals.inputTokens).toBeLessThan(all.totals.inputTokens);
    expect(alpha.seriesKeys).toEqual(['Bash']);

    const beta = buildHistoricalSummary(source(), 'month', { project: '/work/beta', now: NOW });
    // The August session falls in the previous month, not this one.
    expect(beta.dataPoints).toHaveLength(1);
    expect(beta.previousPeriod).toHaveLength(1);
  });
});

describe('drillDownTarget', () => {
  it('drills an all-time month to its days, anchored on the last day of that month', () => {
    const target = drillDownTarget('2026-02', 'all');
    expect(target?.range).toBe('month');
    expect(formatLocalDateKey(target!.now)).toBe('2026-02-28');
  });

  it('drills a day to its hours', () => {
    const target = drillDownTarget('2026-09-03', 'week');
    expect(target?.range).toBe('today');
    expect(formatLocalDateKey(target!.now)).toBe('2026-09-03');
  });

  it('returns null for a timestamp that is not a day or month key', () => {
    expect(drillDownTarget('nope', 'week')).toBeNull();
    expect(drillDownTarget('2026-09-03', 'all')).toBeNull();
  });
});
