/**
 * Failing-tool trend rows shared by the CLI `stats` block and the VS Code
 * Health tab. Browser-safe: no filesystem access; callers pass the two
 * windows they read with `getTopFailingTools()`.
 *
 * @module failingTools
 */

/** The shape `getTopFailingTools()` returns; declared structurally to stay fs-free. */
export interface FailingToolWindow {
  tool: string;
  failures: number;
  categories?: Record<string, number>;
}

export type FailingToolTrend = 'up' | 'down' | 'flat';

export interface FailingToolTrendRow {
  tool: string;
  /** Failures in the last 7 days. */
  last7: number;
  /** Failures in the last 30 days. */
  last30: number;
  /** Category counts over the 30-day window (or the 7-day one when only that is known). */
  categories: Record<string, number>;
  /** Whether the last week is worse, better, or in line with the 30-day weekly average. */
  trend: FailingToolTrend;
}

const TREND_TOLERANCE = 0.1;

/**
 * Compare the last week against the 30-day weekly average: more than 10%
 * above is `up`, more than 10% below is `down`, otherwise `flat`. A tool
 * with no 30-day history but failures this week is `up`.
 */
export function failingToolTrend(last7: number, last30: number): FailingToolTrend {
  const weeklyAverage = last30 / (30 / 7);
  if (weeklyAverage <= 0) return last7 > 0 ? 'up' : 'flat';
  const ratio = last7 / weeklyAverage;
  if (ratio > 1 + TREND_TOLERANCE) return 'up';
  if (ratio < 1 - TREND_TOLERANCE) return 'down';
  return 'flat';
}

export const FAILING_TOOL_TREND_ARROWS: Record<FailingToolTrend, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

/**
 * Merge the 7-day and 30-day windows into one row per tool, ordered by
 * 7-day failures, then 30-day failures, then name.
 */
export function mergeFailingToolWindows(
  last7: FailingToolWindow[],
  last30: FailingToolWindow[],
): FailingToolTrendRow[] {
  const rows = new Map<string, FailingToolTrendRow>();
  for (const tool of last30) {
    rows.set(tool.tool, {
      tool: tool.tool,
      last7: 0,
      last30: tool.failures,
      categories: { ...(tool.categories ?? {}) },
      trend: 'flat',
    });
  }
  for (const tool of last7) {
    const row = rows.get(tool.tool);
    if (row) {
      row.last7 = tool.failures;
      // A 7-day count cannot exceed the 30-day one; tolerate windows read at different instants.
      row.last30 = Math.max(row.last30, tool.failures);
    } else {
      rows.set(tool.tool, {
        tool: tool.tool,
        last7: tool.failures,
        last30: tool.failures,
        categories: { ...(tool.categories ?? {}) },
        trend: 'flat',
      });
    }
  }
  for (const row of rows.values()) row.trend = failingToolTrend(row.last7, row.last30);
  return [...rows.values()].sort(
    (a, b) => b.last7 - a.last7 || b.last30 - a.last30 || a.tool.localeCompare(b.tool),
  );
}
