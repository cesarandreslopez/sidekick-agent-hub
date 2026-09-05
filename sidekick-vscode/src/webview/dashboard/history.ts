/**
 * History tab behaviour (typed). The legacy script still owns the tab's
 * range buttons, the Chart.js instance, and the message loop; it calls into
 * this module for request payloads, chart datasets, and the summary tiles.
 * The pure functions here are the unit-tested core; `createHistoryView`
 * is the thin DOM binding.
 *
 * @module webview/dashboard/history
 */

import type {
  DashboardWebviewMessage,
  HistoricalDataPoint,
  HistoricalRange,
  HistoricalSeries,
  HistoricalSummary,
} from '../../types/dashboard';

export type HistoryMetric = 'tokens' | 'cost' | 'messages';
/** The value actually plotted: tool series always plot calls. */
export type HistoryValueMetric = HistoryMetric | 'calls';

export const SERIES_SELECT_ID = 'history-series-select';
export const PROJECT_SELECT_ID = 'history-project-select';

export interface HistoryDataset {
  type?: 'bar' | 'line';
  label: string;
  data: Array<number | null>;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderDash?: number[];
  fill?: boolean;
  pointRadius?: number;
  tension?: number;
  stack?: string;
  order?: number;
}

export interface HistoryChartData {
  labels: string[];
  datasets: HistoryDataset[];
  stacked: boolean;
}

export interface HistoryTiles {
  tokens: number;
  cost: number;
  sessions: number;
  messages: number;
  /** Fractional change versus the previous period (0.25 = +25%); null without a previous period. */
  deltas: {
    tokens: number | null;
    cost: number | null;
    sessions: number | null;
    messages: number | null;
  } | null;
}

export function effectiveMetric(summary: HistoricalSummary, metric: string): HistoryValueMetric {
  if (summary.series === 'tool') return 'calls';
  return metric === 'cost' || metric === 'messages' ? metric : 'tokens';
}

export function pointValue(point: HistoricalDataPoint, metric: HistoryValueMetric): number {
  switch (metric) {
    case 'cost':
      return point.totalCost;
    case 'messages':
    case 'calls':
      return point.messageCount;
    default:
      // Shared vocabulary (summarizeTokens().total): every billed bucket, cache included.
      return (
        point.inputTokens +
        point.outputTokens +
        (point.cacheWriteTokens || 0) +
        (point.cacheReadTokens || 0)
      );
  }
}

function breakdownValue(
  point: HistoricalDataPoint,
  key: string,
  metric: HistoryValueMetric,
): number {
  const entry = point.breakdown?.[key];
  if (!entry) return 0;
  if (metric === 'cost') return entry.cost;
  if (metric === 'messages' || metric === 'calls') return entry.calls;
  return entry.tokens;
}

export function historyRequest(
  range: HistoricalRange,
  metric: string,
  series: HistoricalSeries,
  project: string | null,
): DashboardWebviewMessage {
  return { type: 'requestHistoricalData', range, metric, series, project };
}

export interface HistoryChartStyle {
  /** Colour of the single total series for this metric. */
  totalColor: string;
  /** Palette for stacked series, cycled. */
  palette: string[];
  /** Colour of the dashed previous-period line. */
  previousColor: string;
}

const DEFAULT_STYLE: HistoryChartStyle = {
  totalColor: 'rgb(75, 192, 192)',
  palette: [
    'rgb(75, 192, 192)',
    'rgb(33, 150, 243)',
    'rgb(255, 159, 64)',
    'rgb(156, 39, 176)',
    'rgb(76, 175, 80)',
    'rgb(255, 99, 132)',
    'rgb(255, 205, 86)',
    'rgb(120, 144, 156)',
  ],
  previousColor: 'rgb(150, 150, 150)',
};

function withAlpha(rgb: string, alpha: number): string {
  return rgb.startsWith('rgb(') ? rgb.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`) : rgb;
}

const METRIC_LABELS: Record<HistoryValueMetric, string> = {
  tokens: 'Tokens',
  cost: 'Cost',
  messages: 'Messages',
  calls: 'Tool calls',
};

/**
 * Chart.js data for a summary: stacked bars per series key when every point
 * carries a breakdown, otherwise one total bar series; plus a dashed
 * previous-period line aligned by index when the summary carries one.
 */
export function buildHistoryChartData(
  summary: HistoricalSummary,
  metric: HistoryValueMetric,
  style: Partial<HistoryChartStyle> = {},
): HistoryChartData {
  const s = { ...DEFAULT_STYLE, ...style };
  const points = summary.dataPoints;
  const labels = points.map((p) => p.label);
  const keys = summary.seriesKeys ?? [];
  const stacked =
    (summary.series ?? 'total') !== 'total' &&
    keys.length > 0 &&
    points.length > 0 &&
    points.every((p) => p.breakdown !== undefined);

  const datasets: HistoryDataset[] = stacked
    ? keys.map((key, index) => {
        const color = s.palette[index % s.palette.length];
        return {
          type: 'bar',
          label: key,
          data: points.map((p) => breakdownValue(p, key, metric)),
          backgroundColor: withAlpha(color, 0.7),
          borderColor: color,
          borderWidth: 1,
          stack: 'current',
          order: 2,
        };
      })
    : [
        {
          type: 'bar',
          label: METRIC_LABELS[metric],
          data: points.map((p) => pointValue(p, metric)),
          backgroundColor: withAlpha(s.totalColor, 0.7),
          borderColor: s.totalColor,
          borderWidth: 1,
          order: 2,
        },
      ];

  const previous = summary.previousPeriod ?? [];
  if (previous.length > 0 && points.length > 0) {
    datasets.push({
      type: 'line',
      label: 'Previous period',
      data: points.map((_, index) =>
        index < previous.length ? pointValue(previous[index], metric) : null,
      ),
      borderColor: s.previousColor,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [4, 4],
      fill: false,
      pointRadius: 2,
      tension: 0.2,
      order: 1,
    });
  }

  return { labels, datasets, stacked };
}

function totalsOf(points: HistoricalDataPoint[]): Omit<HistoryTiles, 'deltas'> {
  return {
    tokens: points.reduce((sum, p) => sum + pointValue(p, 'tokens'), 0),
    cost: points.reduce((sum, p) => sum + p.totalCost, 0),
    sessions: points.reduce((sum, p) => sum + p.sessionCount, 0),
    messages: points.reduce((sum, p) => sum + p.messageCount, 0),
  };
}

function delta(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0;
  return (current - previous) / previous;
}

/** Summary tiles with deltas versus the previous period (null deltas when there is none). */
export function computeHistoryTiles(summary: HistoricalSummary): HistoryTiles {
  const current = totalsOf(summary.dataPoints);
  const previous = summary.previousPeriod ?? [];
  if (previous.length === 0) return { ...current, deltas: null };
  const before = totalsOf(previous);
  return {
    ...current,
    deltas: {
      tokens: delta(current.tokens, before.tokens),
      cost: delta(current.cost, before.cost),
      sessions: delta(current.sessions, before.sessions),
      messages: delta(current.messages, before.messages),
    },
  };
}

/** `+12%`, `−5%`, `0%`, or `new` when the previous period had nothing. */
export function formatDelta(value: number | null): string {
  if (value === null) return 'new';
  const pct = Math.round(value * 100);
  if (pct === 0) return '0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
}

// ── DOM binding ──────────────────────────────────────────────────────────

/** What the legacy script lends the view: its state, its post function, its formatters. */
export interface HistoryMountOptions {
  getRange(): HistoricalRange;
  getMetric(): string;
  post(message: DashboardWebviewMessage): void;
  formatNumber(value: number): string;
  formatCost(value: number): string;
  cssVar(name: string, fallback: string): string;
}

/** Structural view of the Chart.js instance the legacy script owns. */
export interface HistoryChartLike {
  data: { labels: unknown[]; datasets: unknown[] };
  options: { scales?: Record<string, { stacked?: boolean } | undefined> };
  update(): void;
}

export interface HistoryView {
  mount(options: HistoryMountOptions): void;
  /** Request payload for the current series/project selection. */
  request(range: HistoricalRange, metric: string): DashboardWebviewMessage;
  effectiveMetric(summary: HistoricalSummary, metric: string): HistoryValueMetric;
  applyToChart(
    chart: HistoryChartLike,
    summary: HistoricalSummary,
    metric: HistoryValueMetric,
  ): void;
  applyTiles(summary: HistoricalSummary, metric: HistoryValueMetric): void;
}

const TILE_IDS: Record<keyof Omit<HistoryTiles, 'deltas'>, string> = {
  tokens: 'history-total-tokens',
  cost: 'history-total-cost',
  sessions: 'history-sessions',
  messages: 'history-messages',
};

export function createHistoryView(doc: Document): HistoryView {
  let mounted: HistoryMountOptions | null = null;
  const seriesSelect = doc.getElementById(SERIES_SELECT_ID) as HTMLSelectElement | null;
  const projectSelect = doc.getElementById(PROJECT_SELECT_ID) as HTMLSelectElement | null;
  const metricSelect = doc.getElementById('history-metric-select') as HTMLSelectElement | null;

  const currentSeries = (): HistoricalSeries => {
    const value = seriesSelect?.value;
    return value === 'model' || value === 'tool' ? value : 'total';
  };
  const currentProject = (): string | null => projectSelect?.value || null;

  const request = (range: HistoricalRange, metric: string): DashboardWebviewMessage =>
    historyRequest(range, metric, currentSeries(), currentProject());

  const style = (metric: HistoryValueMetric): HistoryChartStyle => {
    const cssVar = mounted?.cssVar ?? ((_: string, fallback: string) => fallback);
    const totalByMetric: Record<HistoryValueMetric, string> = {
      tokens: cssVar('--vscode-charts-blue', DEFAULT_STYLE.totalColor),
      cost: cssVar('--vscode-charts-green', 'rgb(76, 175, 80)'),
      messages: cssVar('--vscode-charts-purple', 'rgb(33, 150, 243)'),
      calls: cssVar('--vscode-charts-orange', 'rgb(255, 159, 64)'),
    };
    return {
      totalColor: totalByMetric[metric],
      palette: [
        cssVar('--vscode-charts-blue', DEFAULT_STYLE.palette[0]),
        cssVar('--vscode-charts-green', DEFAULT_STYLE.palette[1]),
        cssVar('--vscode-charts-orange', DEFAULT_STYLE.palette[2]),
        cssVar('--vscode-charts-purple', DEFAULT_STYLE.palette[3]),
        cssVar('--vscode-charts-red', DEFAULT_STYLE.palette[4]),
        cssVar('--vscode-charts-yellow', DEFAULT_STYLE.palette[5]),
        DEFAULT_STYLE.palette[6],
        DEFAULT_STYLE.palette[7],
      ],
      previousColor: cssVar('--vscode-descriptionForeground', DEFAULT_STYLE.previousColor),
    };
  };

  const syncProjects = (summary: HistoricalSummary): void => {
    if (!projectSelect) return;
    const projects = summary.projects ?? [];
    const selected = summary.project ?? projectSelect.value ?? '';
    const wanted = ['', ...projects];
    const existing = Array.from(projectSelect.options).map((o) => o.value);
    if (wanted.join('\n') !== existing.join('\n')) {
      projectSelect.replaceChildren();
      for (const value of wanted) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = value
          ? value.split(/[\\/]/).filter(Boolean).pop() || value
          : 'All projects';
        if (value) option.title = value;
        projectSelect.appendChild(option);
      }
    }
    projectSelect.value = wanted.includes(selected) ? selected : '';
  };

  return {
    mount(options) {
      mounted = options;
      const repost = (): void => options.post(request(options.getRange(), options.getMetric()));
      seriesSelect?.addEventListener('change', () => {
        // Tool series plot calls: the metric select does not apply.
        if (metricSelect) metricSelect.disabled = currentSeries() === 'tool';
        repost();
      });
      projectSelect?.addEventListener('change', repost);
    },
    request,
    effectiveMetric,
    applyToChart(chart, summary, metric) {
      syncProjects(summary);
      if (seriesSelect && summary.series && seriesSelect.value !== summary.series) {
        seriesSelect.value = summary.series;
      }
      if (metricSelect) metricSelect.disabled = summary.series === 'tool';
      const data = buildHistoryChartData(summary, metric, style(metric));
      chart.data.labels = data.labels;
      chart.data.datasets = data.datasets;
      chart.options.scales ??= {};
      chart.options.scales.x = { ...(chart.options.scales.x ?? {}), stacked: data.stacked };
      chart.options.scales.y = { ...(chart.options.scales.y ?? {}), stacked: data.stacked };
      chart.update();
    },
    applyTiles(summary) {
      const tiles = computeHistoryTiles(summary);
      const fmtNumber = mounted?.formatNumber ?? String;
      const fmtCost = mounted?.formatCost ?? ((v: number) => `$${v.toFixed(2)}`);
      const values: Record<keyof typeof TILE_IDS, string> = {
        tokens: fmtNumber(tiles.tokens),
        cost: fmtCost(tiles.cost),
        sessions: fmtNumber(tiles.sessions),
        messages: fmtNumber(tiles.messages),
      };
      for (const key of Object.keys(TILE_IDS) as Array<keyof typeof TILE_IDS>) {
        const valueEl = doc.getElementById(TILE_IDS[key]);
        if (valueEl) valueEl.textContent = values[key];
        const deltaEl = doc.getElementById(`${TILE_IDS[key]}-delta`);
        if (!deltaEl) continue;
        const d = tiles.deltas?.[key];
        if (tiles.deltas === null || d === undefined) {
          deltaEl.textContent = '';
          deltaEl.className = 'stat-delta';
          continue;
        }
        deltaEl.textContent = `${formatDelta(d)} vs previous`;
        deltaEl.className = `stat-delta ${d === null ? 'neutral' : d > 0 ? 'up' : d < 0 ? 'down' : 'neutral'}`;
      }
    },
  };
}
