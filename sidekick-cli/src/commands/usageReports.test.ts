import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

const { mockCollect, mockDetected, mockResolveProvider } = vi.hoisted(() => ({
  mockCollect: vi.fn(),
  mockDetected: vi.fn(),
  mockResolveProvider: vi.fn(),
}));

vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  collectUsageEvents: (...args: unknown[]) => mockCollect(...args),
  getAllDetectedProviders: () => mockDetected(),
  createSessionProviders: (options: { providerIds: string[] }) => ({
    providers: options.providerIds.map((id) => ({ id, dispose: vi.fn() })),
    diagnostics: [],
  }),
}));

vi.mock('../cli', () => ({
  resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
}));

import {
  buildUsageReport,
  defaultWindowStart,
  formatUsageCsv,
  formatUsageTable,
  selectProviders,
  sessionParentMap,
  usageReportAction,
} from './usageReports';

const NOW = new Date('2026-09-04T14:34:00Z');

function usage(iso: string, overrides: Record<string, unknown> & { total?: number } = {}) {
  const total = overrides.total ?? 1000;
  return {
    timestamp: Date.parse(iso),
    provider: 'claude-code',
    sessionId: 's1',
    project: '/Users/dev/work/project',
    model: 'claude-sonnet-4-5',
    tokens: {
      inputTokens: total / 2,
      outputTokens: total / 4,
      cacheWriteTokens: 0,
      cacheReadTokens: total / 4,
      totalTokens: total,
    },
    costUsd: 0.01,
    costProvenance: 'model-catalog',
    ...overrides,
  };
}

const claude = { id: 'claude-code', dispose: vi.fn() };
const codex = { id: 'codex', dispose: vi.fn() };

describe('buildUsageReport', () => {
  beforeEach(() => {
    mockCollect.mockReset();
    mockCollect.mockResolvedValue({
      events: [
        usage('2026-09-03T23:30:00Z'),
        usage('2026-09-04T00:30:00Z', { total: 500 }),
        usage('2026-09-04T10:00:00Z', {
          provider: 'codex',
          sessionId: 's2',
          model: 'gpt-5-codex',
          costUsd: null,
          costProvenance: 'unpriced',
        }),
      ],
      sessions: [{ sessionId: 's1' }, { sessionId: 's2' }],
      diagnostics: [],
      cacheHits: 2,
      cacheMisses: 0,
    });
  });

  it('buckets by event time and attaches per-model sub-rows on request', async () => {
    const since = new Date('2026-09-01T00:00:00Z');
    const report = await buildUsageReport({
      providers: [claude, codex] as never,
      granularity: 'day',
      since,
      until: NOW,
      utc: true,
      breakdown: true,
    });

    expect(mockCollect).toHaveBeenCalledWith(
      expect.objectContaining({ providers: [claude, codex], since, until: NOW }),
    );
    expect(report.rows.map((row) => [row.key, row.provider, row.calls])).toEqual([
      ['2026-09-03', 'claude-code', 1],
      ['2026-09-04', 'claude-code', 1],
      ['2026-09-04', 'codex', 1],
    ]);
    expect(report.breakdown['2026-09-04|claude-code|']).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-4-5', calls: 1 }),
    ]);
    expect(report.totals).toMatchObject({
      calls: 3,
      sessions: 2,
      totalTokens: 2500,
      unpricedCalls: 1,
    });
    expect(report.providers).toEqual(['claude-code', 'codex']);
    expect(report.cacheHits).toBe(2);
  });

  it('renders the table, totals, provenance footer, CSV, and session rows', async () => {
    chalk.level = 0;
    const report = await buildUsageReport({
      providers: [claude, codex] as never,
      granularity: 'day',
      since: new Date('2026-09-01T00:00:00Z'),
      until: NOW,
      utc: true,
      breakdown: true,
    });
    const text = formatUsageTable(report);
    expect(text).toContain('Daily usage');
    expect(text).toContain('2026-09-01 → 2026-09-04');
    expect(text).toContain('Total (incl. cache)');
    expect(text).toContain('2026-09-03  claude');
    expect(text).toContain('└ claude-sonnet-4-5');
    expect(text).toContain('└ gpt-5-codex');
    expect(text).toContain('Total');
    expect(text).toContain('Bucketed by usage-event time (UTC calendar)');
    expect(text).toContain('1 unpriced call');
    expect(text).toContain('2 sessions read');

    const csv = formatUsageCsv(report);
    expect(csv.split('\n')[0]).toBe(
      'period,provider,project,model,sessions,calls,input,output,cache_write,cache_read,total,cost_usd,cost_provenance,unpriced_calls,first_event,last_event,models,reasoning',
    );
    expect(csv).toContain('2026-09-03,claude-code,,,1,1,500,250,0,250,1000,0.01,estimated,0,');

    const sessions = await buildUsageReport({
      providers: [claude, codex] as never,
      granularity: 'session',
      since: new Date('2026-09-01T00:00:00Z'),
      until: NOW,
      utc: true,
    });
    const sessionsText = formatUsageTable(sessions);
    expect(sessionsText).toContain('Sessions');
    expect(sessionsText).toContain('…/work/project');
    expect(sessionsText).toContain('s1');
    expect(sessionsText).toContain('gpt-5-codex');
    expect(formatUsageCsv(sessions).split('\n')[0]).toMatch(/^session_id,/);
  });

  it('explains an empty window', async () => {
    chalk.level = 0;
    mockCollect.mockResolvedValue({
      events: [],
      sessions: [],
      diagnostics: [],
      cacheHits: 0,
      cacheMisses: 0,
    });
    const report = await buildUsageReport({
      providers: [claude] as never,
      granularity: 'week',
      since: new Date('2026-09-01T00:00:00Z'),
      until: NOW,
    });
    expect(formatUsageTable(report)).toContain('No usage events in this window.');
  });
});

describe('usage report costs, pricing basis, reasoning, and sessions', () => {
  const since = new Date('2026-09-01T00:00:00Z');
  const collect = (events: unknown[]) =>
    mockCollect.mockResolvedValue({
      events,
      sessions: [...new Set(events.map((event) => (event as { sessionId: string }).sessionId))].map(
        (sessionId) => ({ sessionId }),
      ),
      diagnostics: [],
      cacheHits: 0,
      cacheMisses: 0,
    });

  beforeEach(() => {
    chalk.level = 0;
    mockCollect.mockReset();
  });

  it('prints "—" for unpriced rows, (est.) for estimates, and marks partially priced rows', async () => {
    collect([
      // 09-01: provider-reported only
      usage('2026-09-01T10:00:00Z', { costUsd: 0.5, costProvenance: 'provider-reported' }),
      // 09-02: nothing priced
      usage('2026-09-02T10:00:00Z', { costUsd: null, costProvenance: 'unpriced' }),
      // 09-03: one estimated call and one unpriced call
      usage('2026-09-03T10:00:00Z', { costUsd: 0.25 }),
      usage('2026-09-03T11:00:00Z', { costUsd: null, costProvenance: 'unpriced' }),
    ]);
    const report = await buildUsageReport({
      providers: [claude] as never,
      granularity: 'day',
      since,
      until: NOW,
      utc: true,
    });
    const lines = formatUsageTable(report).split('\n');
    const row = (key: string) => lines.find((line) => line.trimStart().startsWith(key)) ?? '';
    expect(row('2026-09-01')).toMatch(/\$0\.50$/);
    expect(row('2026-09-02')).toMatch(/—$/);
    expect(row('2026-09-02')).not.toContain('$0.00');
    expect(row('2026-09-03')).toMatch(/\$0\.25 \(est\., partial\)$/);
    expect(row('Total')).toMatch(/\$0\.75 \(est\., partial\)$/);
    expect(lines.join('\n')).toContain('(partial) = priced calls only');
    // CSV keeps the raw number; cost_provenance disambiguates.
    expect(formatUsageCsv(report)).toContain(',0,unpriced,1,');
  });

  it('states the pricing basis in the footer and in --json', async () => {
    collect([usage('2026-09-03T10:00:00Z')]);
    const report = await buildUsageReport({
      providers: [claude] as never,
      granularity: 'day',
      since,
      until: NOW,
    });
    expect(report.pricingCatalog).toMatchObject({
      source: expect.any(String),
      digest: expect.stringMatching(/^fnv1a64:[0-9a-f]{16}$/),
    });
    const text = formatUsageTable(report);
    expect(text).toContain(`Pricing: `);
    expect(text).toContain(report.pricingCatalog.digest);
  });

  it('shows a Reasoning column and appends a reasoning CSV column only when reported', async () => {
    const withReasoning = usage('2026-09-03T10:00:00Z', {
      provider: 'codex',
      model: 'gpt-6.1-sol',
    });
    (withReasoning.tokens as Record<string, number>).reasoningTokens = 120;
    collect([withReasoning, usage('2026-09-03T11:00:00Z')]);
    const report = await buildUsageReport({
      providers: [claude, codex] as never,
      granularity: 'day',
      since,
      until: NOW,
      utc: true,
    });
    const text = formatUsageTable(report);
    expect(text).toContain('Reasoning');
    expect(text).toContain('Reasoning is already included in Total');
    const csv = formatUsageCsv(report).trim().split('\n');
    expect(csv[0].split(',').at(-1)).toBe('reasoning');
    expect(csv[1].split(',').at(-1)).toBe('0');
    expect(csv[2].split(',').at(-1)).toBe('120');

    collect([usage('2026-09-03T11:00:00Z')]);
    const plain = await buildUsageReport({
      providers: [claude] as never,
      granularity: 'day',
      since,
      until: NOW,
    });
    expect(formatUsageTable(plain)).not.toContain('Reasoning');
  });

  it('merges model spellings, drops <synthetic> placeholders, and renders session sub-rows', async () => {
    collect([
      usage('2026-09-03T10:00:00Z', { model: 'claude-opus-5-5-20261001' }),
      usage('2026-09-03T10:05:00Z', { model: 'claude-opus-5-5' }),
      usage('2026-09-03T10:06:00Z', {
        model: '<synthetic>',
        costUsd: null,
        costProvenance: 'unpriced',
        total: 0,
      }),
      usage('2026-09-03T12:00:00Z', {
        provider: 'codex',
        sessionId: 'child-session-1',
        model: 'gpt-6.1-sol',
        subagent: { agentId: 'child-session-1', parentSessionId: 'parent-session-9' },
      }),
      // A Claude subagent call carries its parent's session id: not a child session.
      usage('2026-09-03T10:07:00Z', {
        model: 'claude-opus-5-5',
        subagent: { agentId: 'a1', parentSessionId: 's1' },
      }),
    ]);
    const report = await buildUsageReport({
      providers: [claude, codex] as never,
      granularity: 'session',
      since,
      until: NOW,
      utc: true,
      breakdown: true,
    });
    expect(report.sessionParents).toEqual({ 'child-session-1': 'parent-session-9' });
    const claudeRow = report.rows.find((row) => row.sessionId === 's1')!;
    expect(claudeRow.calls).toBe(3);
    expect(claudeRow.models).toEqual(['claude-opus-5-5']);
    expect(claudeRow.unpricedCalls).toBe(0);
    expect(report.breakdown['s1|claude-code|/Users/dev/work/project']).toEqual([
      expect.objectContaining({ model: 'claude-opus-5-5', calls: 3 }),
    ]);

    const text = formatUsageTable(report);
    expect(text).toContain('└ claude-opus-5-5');
    expect(text).toContain('└ gpt-6.1-sol');
    expect(text).toContain('↳ subagent of parent-s');
    expect(text).not.toContain('<synthetic>');
  });
});

describe('sessionParentMap', () => {
  it('maps only sessions whose parent is another session', () => {
    expect(
      sessionParentMap([
        { sessionId: 'a', subagent: { agentId: 'x', parentSessionId: 'a' } },
        { sessionId: 'b', subagent: { agentId: 'b', parentSessionId: 'a' } },
        { sessionId: 'c' },
      ]),
    ).toEqual({ b: 'a' });
  });
});

describe('defaultWindowStart', () => {
  it('uses 30 days, 12 weeks, and 12 calendar months', () => {
    expect(defaultWindowStart('day', NOW).getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
    expect(defaultWindowStart('session', NOW).getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
    expect(defaultWindowStart('week', NOW).getTime()).toBe(NOW.getTime() - 84 * 86_400_000);
    const month = defaultWindowStart('month', NOW);
    expect(month.getDate()).toBe(1);
    expect((NOW.getFullYear() - month.getFullYear()) * 12 + NOW.getMonth() - month.getMonth()).toBe(
      11,
    );
  });
});

describe('selectProviders', () => {
  beforeEach(() => {
    mockDetected.mockReset();
    mockResolveProvider.mockReset();
    mockResolveProvider.mockReturnValue(claude);
  });

  it('reads every detected provider by default and only the requested one with --provider', () => {
    mockDetected.mockReturnValue(['codex', 'claude-code']);
    expect(selectProviders({}).map((provider) => provider.id)).toEqual(['codex', 'claude-code']);
    expect(selectProviders({ provider: 'auto' }).map((provider) => provider.id)).toEqual([
      'codex',
      'claude-code',
    ]);
    expect(selectProviders({ provider: 'codex' })).toEqual([claude]);
    expect(mockResolveProvider).toHaveBeenCalledWith({ provider: 'codex' });
  });

  it('falls back to the resolved provider when nothing is detected', () => {
    mockDetected.mockReturnValue([]);
    expect(selectProviders({})).toEqual([claude]);
  });
});

describe('usageReportAction', () => {
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
    mockDetected.mockReset();
    mockDetected.mockReturnValue(['claude-code']);
    mockResolveProvider.mockReset();
    mockResolveProvider.mockReturnValue(claude);
    mockCollect.mockReset();
    mockCollect.mockResolvedValue({
      events: [usage('2026-09-04T10:00:00Z')],
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

  it('prints JSON with the report shape, honouring --utc and --since', async () => {
    await usageReportAction('month', {}, makeCmd(true, { since: '2026-01-15', utc: true }));
    const parsed = JSON.parse(stdoutData);
    expect(parsed.granularity).toBe('month');
    expect(parsed.utc).toBe(true);
    expect(parsed.since.startsWith('2026-01-15')).toBe(true);
    expect(parsed.rows[0].key).toBe('2026-09');
    expect(parsed.totals.calls).toBe(1);
    // Additive: the pricing basis and the priced-cost figure.
    expect(parsed.pricingCatalog.digest).toMatch(/^fnv1a64:/);
    expect(parsed.rows[0].pricedCostUsd).toBe(0.01);
  });

  it('rejects an unparseable window without reading logs', async () => {
    await usageReportAction('day', {}, makeCmd(false, { until: 'never' }));
    expect(stderrData).toContain('Invalid time');
    expect(process.exitCode).toBe(1);
    expect(mockCollect).not.toHaveBeenCalled();
  });
});
