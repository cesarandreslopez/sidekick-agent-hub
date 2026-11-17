import { afterEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { mergeFailingToolWindows } from 'sidekick-shared';

const { mockReadHistory } = vi.hoisted(() => ({ mockReadHistory: vi.fn() }));

vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  readHistory: () => mockReadHistory(),
  getTopFailingTools: async () => [],
}));

import { formatFailingToolsBlock, printStatsSummary, statsAction } from './stats';

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

describe('statsAction model usage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('merges spellings of one model and marks a partially priced merge', async () => {
    chalk.level = 0;
    const tokens = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
    mockReadHistory.mockResolvedValue({
      schemaVersion: 2,
      daily: {},
      monthly: {},
      allTime: {
        tokens,
        totalCost: 1,
        messageCount: 1,
        sessionCount: 1,
        firstDate: '2026-10-01',
        lastDate: '2026-10-31',
        modelUsage: [
          { model: 'claude-opus-5-5-20261001', calls: 4, tokens: 100, cost: 0.4 },
          { model: 'claude-opus-5-5', calls: 2, tokens: 50, cost: 0.2 },
          {
            model: 'us.anthropic.claude-sonnet-5-5-v1:0',
            calls: 1,
            tokens: 10,
            cost: 0,
            priced: false,
          },
          { model: 'claude-sonnet-5-5', calls: 1, tokens: 10, cost: 0.1 },
          { model: '<synthetic>', calls: 9, tokens: 0, cost: 0, priced: false },
        ],
        toolUsage: [],
        updatedAt: '2026-10-31T00:00:00Z',
      },
    });
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
    await statsAction({}, {
      parent: { opts: () => ({}) },
      opts: () => ({}),
    } as unknown as import('commander').Command);

    expect(out).toMatch(/claude-opus-5-5\s+6 calls \(\$0\.60\)/);
    expect(out).toMatch(/claude-sonnet-5-5\s+2 calls \(\$0\.10, partial\)/);
    expect(out).not.toContain('claude-opus-5-5-20261001');
    expect(out).not.toContain('<synthetic>');
    expect(out).not.toContain('unpriced');
    // The total inherits the partially priced row.
    expect(out).toMatch(/Total cost:\s+\$1\.00 \(partial\)/);
  });
});

describe('printStatsSummary layout', () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(run: () => void): string {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    run();
    return out.join('');
  }

  const tokens = { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const day = (date: string, messageCount: number) => ({
    date,
    tokens,
    totalCost: 1,
    messageCount,
    sessionCount: 1,
    modelUsage: [],
    toolUsage: [],
  });

  function history(daily: Record<string, unknown>) {
    return {
      schemaVersion: 3,
      daily,
      monthly: {},
      lastSaved: '2026-11-17T00:00:00.000Z',
      allTime: {
        tokens,
        totalCost: 210149.07,
        messageCount: 1494051,
        sessionCount: 7771,
        firstDate: '2026-03-26',
        lastDate: '2026-11-16',
        modelUsage: [{ model: 'claude-opus-5-5', calls: 1, tokens: 1, cost: 1 }],
        toolUsage: [
          {
            tool: 'mcp__plugin_context7_context7__query-docs',
            calls: 8,
            successCount: 8,
            failureCount: 0,
          },
          { tool: 'Bash', calls: 4096, successCount: 1199, failureCount: 2897 },
          { tool: 'Unused', calls: 0, successCount: 0, failureCount: 0 },
        ],
      },
    } as never;
  }

  it('lines up the summary values, cuts long names, and groups counts', () => {
    chalk.level = 0;
    const text = capture(() => printStatsSummary(history({}), [], []));
    const valueColumns = text
      .split('\n')
      .filter((line) => /^ {2}(?:Sessions|Messages|Total \(incl\. cache\)|Total cost):/.test(line))
      .map((line) => line.length - line.replace(/^ {2}\S[^:]*:\s+/, '').length);
    expect(valueColumns).toHaveLength(4);
    expect(new Set(valueColumns).size).toBe(1);
    expect(text).toContain('mcp__plugin_context7_context7…');
    expect(text).toContain('(2,897 failed)');
    expect(text).toMatch(/1 call(?!s)/);
    expect(text).not.toContain('Unused');
  });

  it('shows only the last seven calendar days', () => {
    chalk.level = 0;
    const now = new Date(2026, 10, 17, 12);
    const text = capture(() =>
      printStatsSummary(
        history({ '2026-11-16': day('2026-11-16', 4096), '2026-09-20': day('2026-09-20', 1) }),
        [],
        [],
        now,
      ),
    );
    expect(text).toContain('2026-11-16');
    expect(text).toContain('4,096');
    expect(text).not.toContain('2026-09-20');

    const quiet = capture(() =>
      printStatsSummary(history({ '2026-09-20': day('2026-09-20', 1) }), [], [], now),
    );
    expect(quiet).toContain('No activity in the last 7 days.');
  });
});
