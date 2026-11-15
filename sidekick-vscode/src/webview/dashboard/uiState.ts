/**
 * Dashboard UI state kept with the webview (`vscode.setState`), so moving the
 * view to the panel, reloading webviews, or reloading the window keeps the
 * selected tab, Session metric, and History range / series / metric.
 *
 * @module webview/dashboard/uiState
 */

import type { DashboardTab, HistoricalRange, HistoricalSeries } from '../../types/dashboard';

export interface DashboardUiState {
  tab?: DashboardTab;
  /** The Session tab's metric toggle (`quota` / `cost` / `tokens` / `cache`). */
  metric?: string;
  historyRange?: HistoricalRange;
  historySeries?: HistoricalSeries;
  /** The History metric select (`tokens` / `cost` / `messages`). */
  historyMetric?: string;
}

const TABS: readonly DashboardTab[] = ['session', 'summary', 'history', 'health'];
const METRICS = ['quota', 'cost', 'tokens', 'cache'];
const RANGES: readonly HistoricalRange[] = ['today', 'week', 'month', 'all'];
const SERIES: readonly HistoricalSeries[] = ['total', 'model', 'tool'];
const HISTORY_METRICS = ['tokens', 'cost', 'messages'];

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** The saved state with anything unknown or malformed dropped. */
export function readUiState(raw: unknown): DashboardUiState {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const state: DashboardUiState = {};
  const tab = pick(source.tab, TABS);
  const metric = pick(source.metric, METRICS);
  const historyRange = pick(source.historyRange, RANGES);
  const historySeries = pick(source.historySeries, SERIES);
  const historyMetric = pick(source.historyMetric, HISTORY_METRICS);
  if (tab) state.tab = tab;
  if (metric) state.metric = metric;
  if (historyRange) state.historyRange = historyRange;
  if (historySeries) state.historySeries = historySeries;
  if (historyMetric) state.historyMetric = historyMetric;
  return state;
}

/** The saved state with `patch` applied (validated the same way). */
export function mergeUiState(saved: unknown, patch: Partial<DashboardUiState>): DashboardUiState {
  return readUiState({ ...readUiState(saved), ...patch });
}
