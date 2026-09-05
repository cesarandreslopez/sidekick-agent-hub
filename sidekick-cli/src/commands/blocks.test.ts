import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

const { mockCollect, mockResolveProvider } = vi.hoisted(() => ({
  mockCollect: vi.fn(),
  mockResolveProvider: vi.fn(),
}));

vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  collectUsageEvents: (...args: unknown[]) => mockCollect(...args),
}));

vi.mock('../cli', () => ({
  resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
}));

import { blocksAction, buildBlocksReport, formatBlocksCsv, formatBlocksTable } from './blocks';
import { parseTimeOption } from '../timeRange';

const NOW = new Date('2026-09-04T14:34:00Z');
const T0 = Date.parse('2026-09-04T12:34:00Z');
const MODEL = 'claude-sonnet-4-5';

function usage(offsetMs: number, total = 1000, extra: Record<string, unknown> = {}) {
  return {
    timestamp: T0 + offsetMs,
    provider: 'claude-code',
    sessionId: 's1',
    project: '/work',
    model: MODEL,
    tokens: {
      inputTokens: total / 2,
      outputTokens: total / 4,
      cacheWriteTokens: 0,
      cacheReadTokens: total / 4,
      totalTokens: total,
    },
    costUsd: 0.01,
    costProvenance: 'model-catalog',
    ...extra,
  };
}

const provider = { id: 'claude-code', dispose: vi.fn() };

describe('buildBlocksReport', () => {
  beforeEach(() => {
    mockCollect.mockReset();
    mockCollect.mockResolvedValue({
      events: [usage(0), usage(30 * 60_000), usage(-20 * 3_600_000, 500)],
      sessions: [{ sessionId: 's1' }, { sessionId: 's0' }],
      diagnostics: [],
      cacheHits: 1,
      cacheMisses: 1,
    });
  });

  it('collects two block lengths before the window and keeps blocks that overlap it', async () => {
    const windowStart = new Date(NOW.getTime() - 3 * 86_400_000);
    const report = await buildBlocksReport({
      provider: provider as never,
      now: NOW,
      mode: 'recent',
      windowStart,
      resolveOfficial: async () => null,
    });

    expect(mockCollect).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [provider],
        since: new Date(windowStart.getTime() - 10 * 3_600_000),
        until: NOW,
      }),
    );
    expect(report.blocks).toHaveLength(2);
    expect(report.active?.start).toBe('2026-09-04T12:00:00.000Z');
    expect(report.active?.tokens.total).toBe(2000);
    expect(report.sessions).toBe(2);
    expect(report.cacheHits).toBe(1);
    expect(report.official).toBeNull();
  });

  it('keeps only the active block in active mode and attaches a status-line sample', async () => {
    const report = await buildBlocksReport({
      provider: provider as never,
      now: NOW,
      mode: 'active',
      windowStart: new Date(NOW.getTime() - 5 * 3_600_000),
      resolveOfficial: async () =>
        ({
          available: true,
          capturedSource: 'statusline',
          fiveHour: { utilization: 42, resetsAt: '2026-09-04T17:00:00Z' },
          sevenDay: { utilization: 61, resetsAt: '2026-09-08T09:00:00Z' },
          capturedAt: '2026-09-04T14:31:00Z',
          ageMs: 180_000,
          freshness: 'fresh',
        }) as never,
    });

    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0].isActive).toBe(true);
    expect(report.official).toMatchObject({ fiveHour: { utilization: 42 }, ageMs: 180_000 });
  });

  it('ignores a persisted sample that did not come from the status line', async () => {
    const report = await buildBlocksReport({
      provider: provider as never,
      now: NOW,
      mode: 'active',
      windowStart: NOW,
      resolveOfficial: async () =>
        ({ available: true, capturedSource: 'session', fiveHour: {}, sevenDay: {} }) as never,
    });
    expect(report.official).toBeNull();
  });
});

describe('blocks rendering', () => {
  beforeEach(() => {
    chalk.level = 0;
  });

  it('renders the table with an active row, the official sample, and provenance', async () => {
    mockCollect.mockResolvedValue({
      events: [usage(0), usage(30 * 60_000)],
      sessions: [{ sessionId: 's1' }],
      diagnostics: [],
      cacheHits: 0,
      cacheMisses: 1,
    });
    const report = await buildBlocksReport({
      provider: provider as never,
      now: NOW,
      mode: 'recent',
      windowStart: new Date(NOW.getTime() - 86_400_000),
      resolveOfficial: async () =>
        ({
          available: true,
          capturedSource: 'statusline',
          fiveHour: { utilization: 42, resetsAt: '2026-09-04T17:00:00Z' },
          sevenDay: { utilization: 61, resetsAt: '' },
          ageMs: 180_000,
          freshness: 'fresh',
        }) as never,
    });
    const text = formatBlocksTable(report);

    expect(text).toContain('Billing blocks');
    expect(text).toContain('last 3 days');
    expect(text).toContain('Total (incl. cache)');
    expect(text).toContain('active');
    expect(text).toContain('2.0k');
    expect(text).toContain('$0.02');
    expect(text).toContain('Local estimate from session logs');
    expect(text).toContain('estimated from catalog pricing');
    expect(text).toContain('Official (status line): 5h 42% used');
    expect(text).toContain('7d 61%');
    expect(text).toContain('(sample 3m ago)');

    const csv = formatBlocksCsv(report);
    expect(csv.split('\n')[0]).toBe(
      'start,end,status,calls,input,output,cache_write,cache_read,total,cost_usd,cost_provenance,unpriced_calls,burn_per_min,projected_tokens,projected_cost_usd,remaining_minutes',
    );
    expect(csv).toContain(
      '2026-09-04T12:00:00.000Z,2026-09-04T17:00:00.000Z,active,2,1000,500,0,500,2000,0.02,estimated,0',
    );
  });

  it('explains an empty active view', async () => {
    mockCollect.mockResolvedValue({
      events: [],
      sessions: [],
      diagnostics: [],
      cacheHits: 0,
      cacheMisses: 0,
    });
    const report = await buildBlocksReport({
      provider: provider as never,
      now: NOW,
      mode: 'active',
      windowStart: NOW,
      resolveOfficial: async () => null,
    });
    expect(formatBlocksTable(report)).toContain('No active billing block');
  });
});

describe('blocksAction', () => {
  let stdoutData = '';
  let stderrData = '';

  beforeEach(() => {
    stdoutData = '';
    stderrData = '';
    chalk.level = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutData += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrData += String(chunk);
      return true;
    });
    process.exitCode = undefined;
    mockResolveProvider.mockReset();
    mockResolveProvider.mockReturnValue({ id: 'opencode', dispose: vi.fn() });
    mockCollect.mockReset();
    mockCollect.mockResolvedValue({
      events: [usage(0, 1000, { provider: 'opencode' })],
      sessions: [{ sessionId: 's1' }],
      diagnostics: [],
      cacheHits: 0,
      cacheMisses: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const makeCmd = (json = false, localOpts: Record<string, unknown> = {}) =>
    ({
      parent: { opts: () => ({ json, project: undefined }) },
      opts: () => localOpts,
    }) as unknown as import('commander').Command;

  it('prints JSON with the report shape and disposes the provider', async () => {
    const dispose = vi.fn();
    mockResolveProvider.mockReturnValue({ id: 'opencode', dispose });
    await blocksAction({}, makeCmd(true, { since: '7d' }));

    const parsed = JSON.parse(stdoutData);
    expect(parsed.provider).toBe('opencode');
    expect(parsed.mode).toBe('since');
    expect(Array.isArray(parsed.blocks)).toBe(true);
    expect(parsed.official).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects an unparseable --since without touching the logs', async () => {
    await blocksAction({}, makeCmd(false, { since: 'yesterday-ish' }));
    expect(stderrData).toContain('Invalid time');
    expect(process.exitCode).toBe(1);
    expect(mockCollect).not.toHaveBeenCalled();
  });
});

describe('parseTimeOption', () => {
  it('parses relative windows, local days, and ISO timestamps', () => {
    expect(parseTimeOption('90m', NOW).getTime()).toBe(NOW.getTime() - 90 * 60_000);
    expect(parseTimeOption('24h', NOW).getTime()).toBe(NOW.getTime() - 86_400_000);
    expect(parseTimeOption('7d', NOW).getTime()).toBe(NOW.getTime() - 7 * 86_400_000);
    expect(parseTimeOption('2w', NOW).getTime()).toBe(NOW.getTime() - 14 * 86_400_000);
    const day = parseTimeOption('2026-09-01', NOW);
    expect(day.getFullYear()).toBe(2026);
    expect(day.getMonth()).toBe(8);
    expect(day.getDate()).toBe(1);
    expect(day.getHours()).toBe(0);
    expect(parseTimeOption('2026-09-01T10:00:00Z', NOW).toISOString()).toBe(
      '2026-09-01T10:00:00.000Z',
    );
    expect(() => parseTimeOption('soon', NOW)).toThrow(RangeError);
  });
});
