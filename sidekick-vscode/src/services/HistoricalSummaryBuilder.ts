/**
 * Builds the History tab's summaries from the historical data store.
 *
 * Pure over a narrow read interface so it can be tested without VS Code:
 * the dashboard provider hands in its `HistoricalDataService` and the
 * request (range, series, project) and posts the result.
 *
 * - `today` is hourly (from the stored hourly buckets; days recorded before
 *   hourly tracking synthesise one bucket).
 * - `series: 'model' | 'tool'` attaches a per-point breakdown from the daily
 *   and monthly records' model/tool usage; hourly buckets carry none.
 * - `project` aggregates the durable session records (the last 500) for one
 *   workspace instead of the store's aggregates.
 * - `previousPeriod` is the same range one period earlier, for the overlay
 *   and the tile deltas.
 *
 * @module services/HistoricalSummaryBuilder
 */

import { addLocalDays, formatLocalDateKey, parseLocalDateKey } from 'sidekick-shared';
import type {
  DailyData,
  HourlyData,
  ModelUsageRecord,
  MonthlyData,
  SessionHistoryRecord,
  ToolUsageRecord,
} from '../types/historicalData';
import type {
  HistoricalBreakdownValue,
  HistoricalDataPoint,
  HistoricalRange,
  HistoricalSeries,
  HistoricalSummary,
} from '../types/dashboard';

/** The reads the builder needs; `HistoricalDataService` satisfies it. */
export interface HistoricalSummarySource {
  getDailyData(startDate: string, endDate: string): DailyData[];
  getHourlyData(date: string): HourlyData[];
  getMonthlyData(startMonth: string, endMonth: string): MonthlyData[];
  getAllTimeStats(): { firstDate: string; lastDate: string };
  getSessionRecords(): SessionHistoryRecord[];
}

export interface HistoricalSummaryOptions {
  series?: HistoricalSeries;
  project?: string | null;
  now?: Date;
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  messageCount: number;
  sessionCount: number;
}

function emptyTotals(): Totals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    messageCount: 0,
    sessionCount: 0,
  };
}

function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

function lastDayOfMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  const last = new Date(year, mon, 0).getDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

function addMonths(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number);
  const date = new Date(year, mon - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dayLabel(dateKey: string, range: HistoricalRange): string {
  const date = parseLocalDateKey(dateKey);
  if (!date) return dateKey;
  return range === 'week'
    ? date.toLocaleDateString('en-US', { weekday: 'short' })
    : String(date.getDate());
}

function monthLabel(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  return new Date(year, mon - 1, 1).toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
  });
}

function hourLabel(hour: number): string {
  const ampm = hour < 12 ? 'AM' : 'PM';
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${display}${ampm}`;
}

function breakdownFrom(
  series: HistoricalSeries,
  models: ModelUsageRecord[] | undefined,
  tools: ToolUsageRecord[] | undefined,
): Record<string, HistoricalBreakdownValue> | undefined {
  if (series === 'model') {
    if (!models || models.length === 0) return undefined;
    const out: Record<string, HistoricalBreakdownValue> = {};
    for (const m of models) out[m.model] = { tokens: m.tokens, cost: m.cost, calls: m.calls };
    return out;
  }
  if (series === 'tool') {
    if (!tools || tools.length === 0) return undefined;
    const out: Record<string, HistoricalBreakdownValue> = {};
    for (const t of tools) out[t.tool] = { tokens: 0, cost: 0, calls: t.calls };
    return out;
  }
  return undefined;
}

function pointFromDaily(
  day: DailyData,
  range: HistoricalRange,
  series: HistoricalSeries,
): HistoricalDataPoint {
  return {
    timestamp: day.date,
    label: dayLabel(day.date, range),
    inputTokens: day.tokens.inputTokens,
    outputTokens: day.tokens.outputTokens,
    cacheWriteTokens: day.tokens.cacheWriteTokens,
    cacheReadTokens: day.tokens.cacheReadTokens,
    totalCost: day.totalCost,
    messageCount: day.messageCount,
    sessionCount: day.sessionCount,
    breakdown: breakdownFrom(series, day.modelUsage, day.toolUsage),
  };
}

function pointFromMonthly(month: MonthlyData, series: HistoricalSeries): HistoricalDataPoint {
  return {
    timestamp: month.month,
    label: monthLabel(month.month),
    inputTokens: month.tokens.inputTokens,
    outputTokens: month.tokens.outputTokens,
    cacheWriteTokens: month.tokens.cacheWriteTokens,
    cacheReadTokens: month.tokens.cacheReadTokens,
    totalCost: month.totalCost,
    messageCount: month.messageCount,
    sessionCount: month.sessionCount,
    breakdown: breakdownFrom(series, month.modelUsage, month.toolUsage),
  };
}

/** Hourly points for one local day, from the stored hourly buckets. */
export function buildHourlyPoints(
  source: HistoricalSummarySource,
  dateKey: string,
): HistoricalDataPoint[] {
  return source.getHourlyData(dateKey).map((bucket) => ({
    timestamp: `${dateKey}T${String(bucket.hour).padStart(2, '0')}:00:00`,
    label: hourLabel(bucket.hour),
    inputTokens: bucket.tokens.inputTokens,
    outputTokens: bucket.tokens.outputTokens,
    cacheWriteTokens: bucket.tokens.cacheWriteTokens,
    cacheReadTokens: bucket.tokens.cacheReadTokens,
    totalCost: bucket.totalCost,
    messageCount: bucket.messageCount,
    sessionCount: bucket.sessionCount,
  }));
}

function sumTotals(points: HistoricalDataPoint[]): Totals {
  const totals = emptyTotals();
  for (const p of points) {
    totals.inputTokens += p.inputTokens;
    totals.outputTokens += p.outputTokens;
    totals.cacheWriteTokens += p.cacheWriteTokens;
    totals.cacheReadTokens += p.cacheReadTokens;
    totals.totalCost += p.totalCost;
    totals.messageCount += p.messageCount;
    totals.sessionCount += p.sessionCount;
  }
  return totals;
}

/** Breakdown keys across points, ordered by their summed tokens (tools: calls), largest first. */
function seriesKeysOf(points: HistoricalDataPoint[], series: HistoricalSeries): string[] {
  if (series === 'total') return [];
  const weight = new Map<string, number>();
  for (const p of points) {
    for (const [key, value] of Object.entries(p.breakdown ?? {})) {
      const w = series === 'tool' ? value.calls : value.tokens;
      weight.set(key, (weight.get(key) ?? 0) + w);
    }
  }
  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

/** Window of a range, as inclusive local day keys (or month keys for `all`). */
interface Window {
  start: string;
  end: string;
}

function rangeWindow(
  range: HistoricalRange,
  today: string,
  source: HistoricalSummarySource,
): Window | null {
  switch (range) {
    case 'today':
      return { start: today, end: today };
    case 'week':
      return { start: addLocalDays(today, -6), end: today };
    case 'month':
      return { start: `${monthKey(today)}-01`, end: today };
    case 'all': {
      const allTime = source.getAllTimeStats();
      if (!allTime.firstDate || !allTime.lastDate) return null;
      return { start: monthKey(allTime.firstDate), end: monthKey(allTime.lastDate) };
    }
  }
}

function previousWindow(range: HistoricalRange, window: Window): Window | null {
  switch (range) {
    case 'today':
      return { start: addLocalDays(window.start, -1), end: addLocalDays(window.start, -1) };
    case 'week':
      return { start: addLocalDays(window.start, -7), end: addLocalDays(window.start, -1) };
    case 'month': {
      const previous = addMonths(monthKey(window.start), -1);
      return { start: `${previous}-01`, end: lastDayOfMonth(previous) };
    }
    case 'all':
      return null;
  }
}

/** Points for a window from the store's aggregates (daily/monthly/hourly records). */
function storePoints(
  source: HistoricalSummarySource,
  range: HistoricalRange,
  window: Window,
  series: HistoricalSeries,
): HistoricalDataPoint[] {
  if (range === 'today') return buildHourlyPoints(source, window.start);
  if (range === 'all') {
    return source.getMonthlyData(window.start, window.end).map((m) => pointFromMonthly(m, series));
  }
  return source.getDailyData(window.start, window.end).map((d) => pointFromDaily(d, range, series));
}

/** Points for a window aggregated from the durable session records of one project. */
function sessionPoints(
  records: SessionHistoryRecord[],
  range: HistoricalRange,
  window: Window,
  series: HistoricalSeries,
): HistoricalDataPoint[] {
  const buckets = new Map<string, HistoricalDataPoint>();
  for (const record of records) {
    const started = new Date(record.startTime);
    if (Number.isNaN(started.getTime())) continue;
    const dayKey = formatLocalDateKey(started);
    const key = range === 'all' ? monthKey(dayKey) : dayKey;
    if (key < window.start || key > window.end) continue;
    const bucketKey = range === 'today' ? String(started.getHours()) : key;
    let point = buckets.get(bucketKey);
    if (!point) {
      point = {
        timestamp:
          range === 'today'
            ? `${dayKey}T${String(started.getHours()).padStart(2, '0')}:00:00`
            : key,
        label:
          range === 'today'
            ? hourLabel(started.getHours())
            : range === 'all'
              ? monthLabel(key)
              : dayLabel(key, range),
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalCost: 0,
        messageCount: 0,
        sessionCount: 0,
      };
      buckets.set(bucketKey, point);
    }
    point.inputTokens += record.tokens.inputTokens;
    point.outputTokens += record.tokens.outputTokens;
    point.cacheWriteTokens += record.tokens.cacheWriteTokens;
    point.cacheReadTokens += record.tokens.cacheReadTokens;
    point.totalCost += record.totalCost;
    point.messageCount += record.messageCount;
    point.sessionCount += 1;
    const breakdown = breakdownFrom(series, record.modelUsage, record.toolUsage);
    if (breakdown) {
      point.breakdown ??= {};
      for (const [k, v] of Object.entries(breakdown)) {
        const existing = point.breakdown[k] ?? { tokens: 0, cost: 0, calls: 0 };
        point.breakdown[k] = {
          tokens: existing.tokens + v.tokens,
          cost: existing.cost + v.cost,
          calls: existing.calls + v.calls,
        };
      }
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Distinct, sorted project paths across the durable session records. */
export function listHistoricalProjects(records: SessionHistoryRecord[]): string[] {
  return [...new Set(records.map((r) => r.project).filter((p): p is string => Boolean(p)))].sort();
}

export function buildHistoricalSummary(
  source: HistoricalSummarySource,
  range: HistoricalRange,
  options: HistoricalSummaryOptions = {},
): HistoricalSummary {
  const series = options.series ?? 'total';
  const project = options.project ?? null;
  const today = formatLocalDateKey(options.now ?? new Date());
  const granularity = range === 'today' ? 'hourly' : range === 'all' ? 'monthly' : 'daily';
  const records = source.getSessionRecords();
  const projects = listHistoricalProjects(records);

  const window = rangeWindow(range, today, source);
  if (!window) {
    return {
      range,
      granularity,
      dataPoints: [],
      totals: emptyTotals(),
      series,
      seriesKeys: [],
      projects,
      project,
      previousPeriod: [],
    };
  }

  const pointsFor = (w: Window): HistoricalDataPoint[] =>
    project
      ? sessionPoints(
          records.filter((r) => r.project === project),
          range,
          w,
          series,
        )
      : storePoints(source, range, w, series);

  const dataPoints = pointsFor(window);
  const previous = previousWindow(range, window);
  const previousPeriod = previous ? pointsFor(previous) : [];

  return {
    range,
    granularity,
    dataPoints,
    totals: sumTotals(dataPoints),
    series,
    seriesKeys: seriesKeysOf(dataPoints, series),
    projects,
    project,
    previousPeriod,
  };
}
