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
import { modelLabel, unpricedNote } from './cost';
import { captureFocus, restoreFocus } from './focus';
import { axisCost, compactNumber, exactNumber, plural } from './format';

export type HistoryMetric = 'tokens' | 'cost' | 'messages';
/** The value actually plotted: tool series always plot calls. */
export type HistoryValueMetric = HistoryMetric | 'calls';

export const SERIES_SELECT_ID = 'history-series-select';
export const PROJECT_SELECT_ID = 'history-project-select';
export const SERIES_NOTE_ID = 'history-series-note';
export const HISTORY_RANGES: readonly HistoricalRange[] = ['today', 'week', 'month', 'all'];

/** Stacked charts show this many series; the rest are summed into "Other". */
export const MAX_STACKED_SERIES = 6;
export const OTHER_SERIES_LABEL = 'Other';

export function isHistoricalRange(value: unknown): value is HistoricalRange {
  return typeof value === 'string' && (HISTORY_RANGES as readonly string[]).includes(value);
}

function pointIsEmpty(point: HistoricalDataPoint): boolean {
  return (
    point.inputTokens <= 0 &&
    point.outputTokens <= 0 &&
    (point.cacheWriteTokens || 0) <= 0 &&
    (point.cacheReadTokens || 0) <= 0 &&
    point.totalCost <= 0 &&
    point.messageCount <= 0 &&
    point.sessionCount <= 0
  );
}

/**
 * Whether a summary can draw stacked per-model / per-tool bars: every point
 * with activity carries a breakdown. Empty (zero-filled) slots don't count
 * against it; the store's hourly buckets carry no breakdown, so a store-backed
 * hourly view falls back to totals.
 */
export function isStackable(summary: HistoricalSummary): boolean {
  const points = summary.dataPoints;
  return (
    (summary.series ?? 'total') !== 'total' &&
    (summary.seriesKeys ?? []).length > 0 &&
    points.some((p) => p.breakdown !== undefined) &&
    points.every((p) => p.breakdown !== undefined || pointIsEmpty(p))
  );
}

/** Why a per-model / per-tool request fell back to totals, or null when it didn't. */
export function seriesFallbackNote(summary: HistoricalSummary): string | null {
  const series = summary.series ?? 'total';
  if (series === 'total' || isStackable(summary)) return null;
  const points = summary.dataPoints;
  // An empty range has its own empty state; no note beside it.
  if (points.every(pointIsEmpty)) return null;
  if (
    (summary.seriesKeys ?? []).length === 0 &&
    points.every((p) => p.breakdown !== undefined || pointIsEmpty(p))
  ) {
    return series === 'tool' ? 'No tool calls in this range.' : 'No per-model usage in this range.';
  }
  const what = series === 'tool' ? 'Per-tool' : 'Per-model';
  return summary.granularity === 'hourly'
    ? `${what} breakdown isn't recorded hourly; showing totals.`
    : `${what} breakdown isn't recorded for this range; showing totals.`;
}

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

/**
 * The value a summary plots: a stackable tool series plots tool calls (the
 * only thing tool records carry); everything else plots the selected metric.
 */
export function effectiveMetric(summary: HistoricalSummary, metric: string): HistoryValueMetric {
  if (summary.series === 'tool' && isStackable(summary)) return 'calls';
  return metric === 'cost' || metric === 'messages' ? metric : 'tokens';
}

/** Axis tick text for a plotted value: compact numbers, short dollars for cost. */
export function formatAxisValue(metric: HistoryValueMetric, value: number): string {
  return metric === 'cost' ? axisCost(value) : compactNumber(value);
}

/** Tooltip line: `Sonnet 4.5: 1,234,567` / `Previous period: $1.23`. */
export function formatTooltipLabel(
  datasetLabel: string | undefined,
  metric: HistoryValueMetric,
  value: number,
  formatCost: (value: number) => string,
): string {
  const text = metric === 'cost' ? formatCost(value) : exactNumber(value);
  return datasetLabel ? `${datasetLabel}: ${text}` : text;
}

export function pointValue(point: HistoricalDataPoint, metric: HistoryValueMetric): number {
  switch (metric) {
    case 'cost':
      return point.totalCost;
    case 'messages':
      return point.messageCount;
    case 'calls':
      // Tool calls, not messages: the sum of the per-tool breakdown (none recorded = 0).
      return Object.values(point.breakdown ?? {}).reduce((sum, entry) => sum + entry.calls, 0);
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

/** `color` at `alpha`: 6-digit hex and `rgb()`/`rgba()` become `rgba()`; anything else is returned as is. */
function withAlpha(color: string, alpha: number): string {
  const value = color.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb) {
    const channels = rgb[1]
      .split(',')
      .slice(0, 3)
      .map((part) => part.trim());
    return `rgba(${channels.join(', ')}, ${alpha})`;
  }
  return value;
}

const METRIC_LABELS: Record<HistoryValueMetric, string> = {
  tokens: 'Tokens',
  cost: 'Cost',
  messages: 'Messages',
  calls: 'Tool calls',
};

/** Legend / tooltip name for a series key: model ids read as `Sonnet 4.5`. */
export function seriesLabel(series: HistoricalSeries | undefined, key: string): string {
  return series === 'model' ? modelLabel(key) : key;
}

/**
 * Chart.js data for a summary: stacked bars per series key (the largest
 * {@link MAX_STACKED_SERIES}, the rest summed as "Other") when the summary is
 * stackable, otherwise one total bar series; plus a dashed previous-period
 * line aligned by slot when the summary carries one.
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
  const stacked = isStackable(summary);
  const shown = keys.slice(0, MAX_STACKED_SERIES);
  const rest = keys.slice(MAX_STACKED_SERIES);

  const stackedDatasets = (): HistoryDataset[] => {
    const series: Array<{ label: string; data: number[] }> = shown.map((key) => ({
      label: seriesLabel(summary.series, key),
      data: points.map((p) => breakdownValue(p, key, metric)),
    }));
    if (rest.length > 0) {
      series.push({
        label: OTHER_SERIES_LABEL,
        data: points.map((p) => rest.reduce((sum, key) => sum + breakdownValue(p, key, metric), 0)),
      });
    }
    return series.map((entry, index) => {
      const color = s.palette[index % s.palette.length];
      return {
        type: 'bar',
        label: entry.label,
        data: entry.data,
        backgroundColor: withAlpha(color, 0.7),
        borderColor: color,
        borderWidth: 1,
        stack: 'current',
        order: 2,
      };
    });
  };

  const datasets: HistoryDataset[] = stacked
    ? stackedDatasets()
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

/**
 * Summary tiles with deltas versus the previous period (null deltas when
 * there is none). A period still in progress compares against the same
 * stretch of the previous one (`comparableSlots`): today at 10:00 against
 * yesterday until 10:59, not all of yesterday.
 */
export function computeHistoryTiles(summary: HistoricalSummary): HistoryTiles {
  const current = totalsOf(summary.dataPoints);
  const previous = summary.previousPeriod ?? [];
  if (previous.length === 0) return { ...current, deltas: null };
  const before = totalsOf(previous.slice(0, summary.comparableSlots ?? previous.length));
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

/**
 * The Total Cost tile and its note. Unpriced models contribute nothing, so a
 * range where nothing was priced shows "—" rather than `$0`, and any unpriced
 * model is named in the note.
 */
export function costTile(
  summary: Pick<HistoricalSummary, 'unpricedModelIds'>,
  cost: number,
  fmt: (value: number) => string,
): { value: string; note: string; title: string } {
  const unpriced = summary.unpricedModelIds ?? [];
  return {
    value: unpriced.length > 0 && !(cost > 0) ? '—' : fmt(cost),
    note: unpricedNote(unpriced.length),
    title: unpriced.join('\n'),
  };
}

export interface HistoryEmptyState {
  /** Nothing recorded in this range. */
  empty: boolean;
  /** What the empty state says. */
  message: string;
  /** Offer the import button (only when no history exists anywhere). */
  showImport: boolean;
}

// History records sessions when they end, so the copy says "finished": a
// session running all morning is not in it yet (see the live note).
const EMPTY_RANGE_TEXT: Record<HistoricalRange, string> = {
  today: 'No finished sessions today.',
  week: 'No finished sessions in the last 7 days.',
  month: 'No finished sessions this month.',
  all: 'No finished sessions recorded.',
};

/**
 * Empty state for a summary. Zero-filled slots mean "no points" no longer
 * signals emptiness; the totals do. A range with nothing in it is only
 * offered the import when there is no history at all.
 */
export function historyEmptyState(summary: HistoricalSummary): HistoryEmptyState {
  const t = summary.totals;
  const empty =
    !(t.inputTokens > 0) &&
    !(t.outputTokens > 0) &&
    !(t.totalCost > 0) &&
    !(t.messageCount > 0) &&
    !(t.sessionCount > 0) &&
    summary.dataPoints.every(pointIsEmpty);
  if (!empty) return { empty: false, message: '', showImport: false };
  if (summary.hasAnyHistory !== true) {
    return { empty: true, message: 'No historical data available.', showImport: true };
  }
  const message = summary.project
    ? `No activity for this project in this range.`
    : summary.drill
      ? 'No activity in this period.'
      : EMPTY_RANGE_TEXT[summary.range];
  return { empty: true, message, showImport: false };
}

/** `+12%`, `−5%`, `0%`, or `new` when the previous period had nothing. */
export function formatDelta(value: number | null): string {
  if (value === null) return 'new';
  const pct = Math.round(value * 100);
  if (pct === 0) return '0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
}

/**
 * A tile's delta line: `+12% vs same time yesterday` for a partial day,
 * `vs same point last month` for a partial month, `vs previous` otherwise,
 * and `no prior activity` when the previous stretch had nothing.
 */
export function deltaText(
  value: number | null,
  summary: Pick<HistoricalSummary, 'comparableSlots' | 'granularity'>,
): string {
  if (value === null) return 'no prior activity';
  const versus =
    summary.comparableSlots === undefined
      ? 'vs previous'
      : summary.granularity === 'hourly'
        ? 'vs same time yesterday'
        : 'vs same point last month';
  return `${formatDelta(value)} ${versus}`;
}

// ── Text alternative to the chart ────────────────────────────────────────

export const POINTS_ID = 'history-points';

const RANGE_NAMES: Record<HistoricalRange, string> = {
  today: 'today',
  week: 'last 7 days',
  month: 'this month',
  all: 'all time',
};

const SLOT_NAMES: Record<HistoricalSummary['granularity'], string> = {
  hourly: 'hour',
  daily: 'day',
  monthly: 'month',
};

/** Day and month bars drill down; an hourly view is the deepest level. */
export function historyCanDrill(summary: Pick<HistoricalSummary, 'granularity'>): boolean {
  return summary.granularity !== 'hourly';
}

/** A readable name for a slot: `Mon, Nov 3` for a day; the chart label otherwise. */
export function pointName(point: HistoricalDataPoint): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(point.timestamp);
  if (!day) return point.label;
  return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** `1.2M tokens`, `$3.40`, `12 messages`, `8 tool calls`. */
export function formatPointValue(
  metric: HistoryValueMetric,
  value: number,
  formatCost: (value: number) => string,
): string {
  switch (metric) {
    case 'cost':
      return formatCost(value);
    case 'messages':
      return plural(Math.round(value), 'message');
    case 'calls':
      return plural(Math.round(value), 'tool call');
    default:
      return `${compactNumber(value)} tokens`;
  }
}

/**
 * The chart's accessible name: what it plots, over which period, the total,
 * and the busiest slot (`Tokens per day, last 7 days: total 4.1M, peak Tue,
 * Nov 3 1.2M tokens`).
 */
export function historyChartLabel(
  summary: HistoricalSummary,
  metric: HistoryValueMetric,
  formatCost: (value: number) => string,
): string {
  const scope = summary.drill?.label ?? RANGE_NAMES[summary.range];
  const head = `${METRIC_LABELS[metric]} per ${SLOT_NAMES[summary.granularity]}, ${scope}`;
  const values = summary.dataPoints.map((p) => pointValue(p, metric));
  const total = values.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) return `${head}: no activity`;
  const peakIndex = values.indexOf(Math.max(...values));
  const peak = summary.dataPoints[peakIndex];
  return (
    `${head}: total ${formatPointValue(metric, total, formatCost)}, ` +
    `peak ${pointName(peak)} ${formatPointValue(metric, values[peakIndex], formatCost)}`
  );
}

/**
 * The chart's points as a list: read by screen readers, and shown when a
 * keyboard user tabs into it, with a drill-down button per day or month
 * (the chart's own drill-down is a mouse click on a bar).
 */
export function renderHistoryPoints(
  container: HTMLElement,
  summary: HistoricalSummary,
  metric: HistoryValueMetric,
  formatCost: (value: number) => string,
): void {
  const doc = container.ownerDocument;
  const focus = captureFocus(container, 'data-point');
  container.replaceChildren();
  const active = summary.dataPoints.filter((p) => !pointIsEmpty(p));
  if (active.length === 0) return;
  const canDrill = historyCanDrill(summary);
  const action = summary.granularity === 'monthly' ? 'Show days' : 'Show hours';
  const list = doc.createElement('ul');
  list.setAttribute('aria-label', historyChartLabel(summary, metric, formatCost));
  for (const point of active) {
    const item = doc.createElement('li');
    item.setAttribute('data-point', point.timestamp);
    const text = doc.createElement('span');
    const name = pointName(point);
    text.textContent = `${name}: ${formatPointValue(metric, pointValue(point, metric), formatCost)}`;
    item.appendChild(text);
    if (canDrill) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'history-point-drill';
      button.setAttribute('data-timestamp', point.timestamp);
      button.textContent = action;
      button.setAttribute('aria-label', `${action} for ${name}`);
      item.appendChild(button);
    }
    list.appendChild(item);
  }
  container.appendChild(list);
  restoreFocus(container, 'data-point', focus);
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
  options: {
    scales?: Record<string, { stacked?: boolean } | undefined>;
    plugins?: {
      legend?: {
        display?: boolean;
        position?: string;
        labels?: Record<string, unknown>;
      };
      [key: string]: unknown;
    };
  };
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
  emptyState(summary: HistoricalSummary): HistoryEmptyState;
  axisLabel(metric: HistoryValueMetric, value: number): string;
  tooltipLabel(datasetLabel: string | undefined, metric: HistoryValueMetric, value: number): string;
  isRange(value: unknown): value is HistoricalRange;
}

const TILE_IDS: Record<keyof Omit<HistoryTiles, 'deltas'>, string> = {
  tokens: 'history-total-tokens',
  cost: 'history-total-cost',
  sessions: 'history-sessions',
  messages: 'history-messages',
};

export function createHistoryView(doc: Document): HistoryView {
  let mounted: HistoryMountOptions | null = null;
  /** The summary on screen, which the points list's drill buttons act on. */
  let shown: HistoricalSummary | null = null;
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
        // Tool series plot calls: the metric select does not apply (re-enabled
        // when the reply falls back to totals).
        if (metricSelect) metricSelect.disabled = currentSeries() === 'tool';
        repost();
      });
      projectSelect?.addEventListener('change', repost);
      // The points list's drill-down buttons do what clicking a bar does.
      doc.getElementById(POINTS_ID)?.addEventListener('click', (event) => {
        const button = (event.target as Element | null)?.closest?.('.history-point-drill');
        const timestamp = button?.getAttribute('data-timestamp');
        if (!timestamp || !shown || !historyCanDrill(shown)) return;
        options.post({ type: 'drillDown', timestamp, currentRange: shown.range });
      });
    },
    request,
    effectiveMetric,
    emptyState: historyEmptyState,
    axisLabel: formatAxisValue,
    tooltipLabel(datasetLabel, metric, value) {
      const fmtCost = mounted?.formatCost ?? ((v: number) => `$${v.toFixed(2)}`);
      return formatTooltipLabel(datasetLabel, metric, value, fmtCost);
    },
    isRange: isHistoricalRange,
    applyToChart(chart, summary, metric) {
      syncProjects(summary);
      if (seriesSelect && summary.series && seriesSelect.value !== summary.series) {
        seriesSelect.value = summary.series;
      }
      if (metricSelect) metricSelect.disabled = metric === 'calls';
      const note = doc.getElementById(SERIES_NOTE_ID);
      if (note) {
        const text = seriesFallbackNote(summary);
        note.textContent = text ?? '';
        note.hidden = !text;
      }
      const data = buildHistoryChartData(summary, metric, style(metric));
      chart.data.labels = data.labels;
      chart.data.datasets = data.datasets;
      chart.options.scales ??= {};
      chart.options.scales.x = { ...(chart.options.scales.x ?? {}), stacked: data.stacked };
      chart.options.scales.y = { ...(chart.options.scales.y ?? {}), stacked: data.stacked };
      // Stacked bars are unreadable without naming the series.
      chart.options.plugins ??= {};
      chart.options.plugins.legend = {
        ...(chart.options.plugins.legend ?? {}),
        display: data.stacked,
        position: 'bottom',
        labels: {
          ...(chart.options.plugins.legend?.labels ?? {}),
          boxWidth: 10,
          font: { size: 10 },
        },
      };
      chart.update();
      // The canvas is a picture: name it, and list its points beside it.
      shown = summary;
      const fmtCost = mounted?.formatCost ?? ((v: number) => `$${v.toFixed(2)}`);
      const canvas = doc.getElementById('historyChart');
      if (canvas) {
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', historyChartLabel(summary, metric, fmtCost));
      }
      const points = doc.getElementById(POINTS_ID);
      if (points) renderHistoryPoints(points, summary, metric, fmtCost);
    },
    applyTiles(summary) {
      const tiles = computeHistoryTiles(summary);
      const fmtCost = mounted?.formatCost ?? ((v: number) => `$${v.toFixed(2)}`);
      const cost = costTile(summary, tiles.cost, fmtCost);
      // Compact headline values (a month of tokens overflowed the tile); exact in the tooltip.
      const values: Record<keyof typeof TILE_IDS, string> = {
        tokens: compactNumber(tiles.tokens),
        cost: cost.value,
        sessions: compactNumber(tiles.sessions),
        messages: compactNumber(tiles.messages),
      };
      const titles: Record<keyof typeof TILE_IDS, string> = {
        tokens: `${exactNumber(tiles.tokens)} tokens`,
        cost: cost.title,
        sessions: `${exactNumber(tiles.sessions)} sessions`,
        messages: `${exactNumber(tiles.messages)} messages`,
      };
      const costNote = doc.getElementById(`${TILE_IDS.cost}-note`);
      if (costNote) {
        costNote.textContent = cost.note;
        costNote.title = cost.title;
      }
      for (const key of Object.keys(TILE_IDS) as Array<keyof typeof TILE_IDS>) {
        const valueEl = doc.getElementById(TILE_IDS[key]);
        if (valueEl) {
          valueEl.textContent = values[key];
          valueEl.title = titles[key];
        }
        const deltaEl = doc.getElementById(`${TILE_IDS[key]}-delta`);
        if (!deltaEl) continue;
        const d = tiles.deltas?.[key];
        if (tiles.deltas === null || d === undefined) {
          deltaEl.textContent = '';
          deltaEl.className = 'stat-delta';
          continue;
        }
        deltaEl.textContent = deltaText(d, summary);
        deltaEl.className = `stat-delta ${d === null ? 'neutral' : d > 0 ? 'up' : d < 0 ? 'down' : 'neutral'}`;
      }
    },
  };
}
