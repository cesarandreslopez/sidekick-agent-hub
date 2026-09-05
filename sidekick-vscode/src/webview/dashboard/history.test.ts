import { describe, expect, it } from 'vitest';
import {
  buildHistoryChartData,
  computeHistoryTiles,
  effectiveMetric,
  formatDelta,
  historyRequest,
} from './history';
import type { HistoricalDataPoint, HistoricalSummary } from '../../types/dashboard';

function point(
  label: string,
  tokens: number,
  breakdown?: HistoricalDataPoint['breakdown'],
): HistoricalDataPoint {
  return {
    timestamp: label,
    label,
    inputTokens: tokens,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalCost: tokens / 1000,
    messageCount: 2,
    sessionCount: 1,
    breakdown,
  };
}

const base: HistoricalSummary = {
  range: 'week',
  granularity: 'daily',
  dataPoints: [point('Mon', 100), point('Tue', 300)],
  totals: { inputTokens: 400, outputTokens: 0, totalCost: 0.4, messageCount: 4, sessionCount: 2 },
};

describe('buildHistoryChartData', () => {
  it('plots one total series without a breakdown', () => {
    const data = buildHistoryChartData(base, 'tokens');
    expect(data.stacked).toBe(false);
    expect(data.datasets).toHaveLength(1);
    expect(data.datasets[0]).toMatchObject({ label: 'Tokens', data: [100, 300] });
    expect(data.labels).toEqual(['Mon', 'Tue']);
  });

  it('stacks one dataset per series key when every point carries a breakdown', () => {
    const summary: HistoricalSummary = {
      ...base,
      series: 'model',
      seriesKeys: ['sonnet', 'haiku'],
      dataPoints: [
        point('Mon', 100, {
          sonnet: { tokens: 80, cost: 0.08, calls: 1 },
          haiku: { tokens: 20, cost: 0.01, calls: 1 },
        }),
        point('Tue', 300, { sonnet: { tokens: 300, cost: 0.3, calls: 2 } }),
      ],
    };
    const data = buildHistoryChartData(summary, 'cost');
    expect(data.stacked).toBe(true);
    expect(data.datasets.map((d) => d.label)).toEqual(['sonnet', 'haiku']);
    expect(data.datasets[0].data).toEqual([0.08, 0.3]);
    expect(data.datasets[1].data).toEqual([0.01, 0]);

    // A point without a breakdown (hourly buckets) falls back to the total.
    const mixed = buildHistoryChartData(
      { ...summary, dataPoints: [summary.dataPoints[0], point('Wed', 5)] },
      'tokens',
    );
    expect(mixed.stacked).toBe(false);
    expect(mixed.datasets).toHaveLength(1);
  });

  it('adds a dashed previous-period line aligned by index', () => {
    const data = buildHistoryChartData({ ...base, previousPeriod: [point('Mon-1', 50)] }, 'tokens');
    const line = data.datasets.find((d) => d.type === 'line');
    expect(line).toMatchObject({ label: 'Previous period', borderDash: [4, 4], data: [50, null] });
  });
});

describe('tiles and requests', () => {
  it('computes deltas against the previous period', () => {
    const tiles = computeHistoryTiles({
      ...base,
      previousPeriod: [point('a', 200), point('b', 0)],
    });
    expect(tiles.tokens).toBe(400);
    expect(tiles.deltas?.tokens).toBeCloseTo(1);
    expect(tiles.deltas?.sessions).toBe(0);
    expect(computeHistoryTiles(base).deltas).toBeNull();
    expect(
      computeHistoryTiles({ ...base, previousPeriod: [point('a', 0)] }).deltas?.tokens,
    ).toBeNull();
  });

  it('formats deltas and resolves the plotted metric', () => {
    expect(formatDelta(0.254)).toBe('+25%');
    expect(formatDelta(-0.05)).toBe('−5%');
    expect(formatDelta(0)).toBe('0%');
    expect(formatDelta(null)).toBe('new');
    expect(effectiveMetric({ ...base, series: 'tool' }, 'cost')).toBe('calls');
    expect(effectiveMetric(base, 'cost')).toBe('cost');
    expect(effectiveMetric(base, 'bogus')).toBe('tokens');
    expect(historyRequest('month', 'cost', 'model', '/work/alpha')).toEqual({
      type: 'requestHistoricalData',
      range: 'month',
      metric: 'cost',
      series: 'model',
      project: '/work/alpha',
    });
  });
});
