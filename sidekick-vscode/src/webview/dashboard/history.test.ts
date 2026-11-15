import { describe, expect, it } from 'vitest';
import {
  buildHistoryChartData,
  computeHistoryTiles,
  costTile,
  effectiveMetric,
  formatAxisValue,
  formatDelta,
  formatTooltipLabel,
  historyEmptyState,
  historyRequest,
  isStackable,
  pointValue,
  seriesFallbackNote,
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

  it('applies the bar alpha to hex theme colours as well as rgb()', () => {
    const hex = buildHistoryChartData(base, 'tokens', { totalColor: '#3794ff' });
    expect(hex.datasets[0]).toMatchObject({
      backgroundColor: 'rgba(55, 148, 255, 0.7)',
      borderColor: '#3794ff',
    });
    const rgb = buildHistoryChartData(base, 'tokens', { totalColor: 'rgb(75, 192, 192)' });
    expect(rgb.datasets[0].backgroundColor).toBe('rgba(75, 192, 192, 0.7)');
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
    // A tool series plots calls only when it can stack; otherwise the selected metric.
    expect(
      effectiveMetric(
        {
          ...base,
          series: 'tool',
          seriesKeys: ['Read'],
          dataPoints: [point('Mon', 100, { Read: { tokens: 0, cost: 0, calls: 3 } })],
        },
        'cost',
      ),
    ).toBe('calls');
    expect(effectiveMetric({ ...base, series: 'tool' }, 'cost')).toBe('cost');
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

describe('costTile', () => {
  const fmt = (v: number) => `$${v.toFixed(2)}`;

  it('shows a dash and a note when nothing in the range was priced', () => {
    expect(costTile({ unpricedModelIds: ['local-model'] }, 0, fmt)).toEqual({
      value: '—',
      note: '1 model unpriced',
      title: 'local-model',
    });
  });

  it('keeps the priced part and names the unpriced models', () => {
    expect(costTile({ unpricedModelIds: ['a', 'b'] }, 2, fmt)).toEqual({
      value: '$2.00',
      note: '2 models unpriced',
      title: 'a\nb',
    });
    expect(costTile({}, 0, fmt)).toEqual({ value: '$0.00', note: '', title: '' });
  });
});

function empty(label: string): HistoricalDataPoint {
  return {
    timestamp: label,
    label,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    messageCount: 0,
    sessionCount: 0,
  };
}

describe('series breakdowns', () => {
  const tool = (calls: number): HistoricalDataPoint['breakdown'] => ({
    Read: { tokens: 0, cost: 0, calls },
  });

  it('stacks when only empty (zero-filled) slots lack a breakdown', () => {
    const summary: HistoricalSummary = {
      ...base,
      series: 'tool',
      seriesKeys: ['Read'],
      dataPoints: [point('Mon', 100, tool(4)), empty('Tue'), point('Wed', 50, tool(1))],
    };
    expect(isStackable(summary)).toBe(true);
    expect(seriesFallbackNote(summary)).toBeNull();
    const data = buildHistoryChartData(summary, 'calls');
    expect(data.stacked).toBe(true);
    expect(data.datasets[0].data).toEqual([4, 0, 1]);
  });

  it('plots tool calls, never message counts, for bars and the previous line', () => {
    const summary: HistoricalSummary = {
      ...base,
      series: 'tool',
      seriesKeys: ['Read'],
      dataPoints: [point('Mon', 100, tool(4)), point('Tue', 100, tool(6))],
      previousPeriod: [point('Mon-1', 100, tool(9)), point('Tue-1', 0)],
    };
    // point() records messageCount 2: the calls value must not be that.
    expect(pointValue(summary.dataPoints[0], 'calls')).toBe(4);
    expect(pointValue(point('x', 1), 'calls')).toBe(0);
    const line = buildHistoryChartData(summary, 'calls').datasets.find((d) => d.type === 'line');
    expect(line?.data).toEqual([9, 0]);
  });

  it('falls back to totals with a note when active slots lack a breakdown (hourly store buckets)', () => {
    const hourly: HistoricalSummary = {
      ...base,
      granularity: 'hourly',
      series: 'model',
      seriesKeys: ['claude-sonnet-4-5'],
      dataPoints: [point('9AM', 100), empty('10AM')],
    };
    expect(isStackable(hourly)).toBe(false);
    expect(seriesFallbackNote(hourly)).toBe(
      "Per-model breakdown isn't recorded hourly; showing totals.",
    );
    expect(buildHistoryChartData(hourly, 'tokens').datasets[0].label).toBe('Tokens');
  });

  it('names model series and folds the tail into Other', () => {
    const keys = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    const breakdown = Object.fromEntries(
      ['claude-sonnet-4-5', ...keys].map((k) => [k, { tokens: 10, cost: 1, calls: 1 }]),
    );
    const summary: HistoricalSummary = {
      ...base,
      series: 'model',
      seriesKeys: ['claude-sonnet-4-5', ...keys],
      dataPoints: [point('Mon', 80, breakdown)],
    };
    const data = buildHistoryChartData(summary, 'tokens');
    expect(data.datasets.filter((d) => d.type === 'bar').map((d) => d.label)).toEqual([
      'Sonnet 4.5',
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'Other',
    ]);
    // m6 and m7 fold into Other.
    expect(data.datasets.find((d) => d.label === 'Other')?.data).toEqual([20]);
  });
});

describe('labels and empty states', () => {
  it('formats axis ticks compactly and tooltips with the series name', () => {
    expect(formatAxisValue('tokens', 120_000_000)).toBe('120.0M');
    expect(formatAxisValue('calls', 12)).toBe('12');
    expect(formatAxisValue('cost', 0)).toBe('$0');
    expect(formatAxisValue('cost', 0.25)).toBe('$0.25');
    expect(formatAxisValue('cost', 12.4)).toBe('$12');
    const fmt = (v: number) => `$${v.toFixed(2)}`;
    expect(formatTooltipLabel('Sonnet 4.5', 'tokens', 1234567, fmt)).toBe('Sonnet 4.5: 1,234,567');
    expect(formatTooltipLabel('Previous period', 'cost', 1.5, fmt)).toBe('Previous period: $1.50');
    // Calls are counts, never dollars.
    expect(formatTooltipLabel('Read', 'calls', 12, fmt)).toBe('Read: 12');
  });

  it('tells an empty range from no history at all', () => {
    const zero: HistoricalSummary = {
      ...base,
      dataPoints: [empty('Mon'), empty('Tue')],
      totals: { inputTokens: 0, outputTokens: 0, totalCost: 0, messageCount: 0, sessionCount: 0 },
    };
    expect(historyEmptyState(base).empty).toBe(false);
    expect(historyEmptyState({ ...zero, hasAnyHistory: false })).toEqual({
      empty: true,
      message: 'No historical data available.',
      showImport: true,
    });
    expect(historyEmptyState({ ...zero, hasAnyHistory: true })).toEqual({
      empty: true,
      message: 'No activity this week.',
      showImport: false,
    });
    expect(
      historyEmptyState({ ...zero, hasAnyHistory: true, project: '/work/alpha' }).message,
    ).toBe('No activity for this project in this range.');
  });
});
