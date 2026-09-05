import { describe, expect, it } from 'vitest';
import { failingToolTrend, mergeFailingToolWindows } from './failingTools';

describe('failingToolTrend', () => {
  it('compares the last week with the 30-day weekly average', () => {
    // 30 failures over 30 days is 7 a week: 10 this week is up, 4 is down, 7 is flat.
    expect(failingToolTrend(10, 30)).toBe('up');
    expect(failingToolTrend(4, 30)).toBe('down');
    expect(failingToolTrend(7, 30)).toBe('flat');
    expect(failingToolTrend(0, 0)).toBe('flat');
    expect(failingToolTrend(2, 0)).toBe('up');
  });
});

describe('mergeFailingToolWindows', () => {
  it('produces one row per tool ordered by recent failures with trends', () => {
    const rows = mergeFailingToolWindows(
      [
        { tool: 'Bash', failures: 6, categories: { timeout: 6 } },
        { tool: 'Fresh', failures: 1 },
      ],
      [
        { tool: 'Bash', failures: 12, categories: { timeout: 10, permission: 2 } },
        { tool: 'Read', failures: 8, categories: { not_found: 8 } },
      ],
    );
    expect(rows.map((r) => r.tool)).toEqual(['Bash', 'Fresh', 'Read']);
    expect(rows[0]).toMatchObject({
      last7: 6,
      last30: 12,
      trend: 'up',
      categories: { timeout: 10, permission: 2 },
    });
    expect(rows[1]).toMatchObject({ last7: 1, last30: 1, trend: 'up' });
    expect(rows[2]).toMatchObject({ last7: 0, last30: 8, trend: 'down' });
  });
});
