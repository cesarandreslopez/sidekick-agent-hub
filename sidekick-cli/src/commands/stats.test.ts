import { describe, expect, it } from 'vitest';
import { mergeFailingToolWindows } from 'sidekick-shared';
import { formatFailingToolsBlock } from './stats';

describe('formatFailingToolsBlock', () => {
  it('renders both windows with a trend arrow per tool', () => {
    const rows = mergeFailingToolWindows(
      [{ tool: 'Bash', failures: 6, categories: { timeout: 6 } }],
      [
        { tool: 'Bash', failures: 12, categories: { timeout: 10, permission: 2 } },
        { tool: 'Read', failures: 8, categories: { not_found: 8 } },
      ],
    );
    // Strip ANSI styling so the assertions read the columns.
    // eslint-disable-next-line no-control-regex
    const text = formatFailingToolsBlock(rows).replace(/\u001b\[[0-9;]*m/g, '');
    expect(text).toContain('Top Failing Tools (last 7 days / last 30 days)');
    expect(text).toMatch(/Bash\s+6\s+12\s+↑ timeout:10, permission:2/);
    expect(text).toMatch(/Read\s+0\s+8\s+↓ not_found:8/);
  });
});
