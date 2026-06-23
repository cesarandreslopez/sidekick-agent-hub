import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  appendQuotaHistorySample,
  pruneQuotaHistory,
  readQuotaHistoryDailyBuckets,
  readQuotaHistoryRange,
  _resetQuotaHistoryInMemoryStateForTests,
  type QuotaHistorySample,
} from './quotaHistory';
import { readQuotaSnapshot } from './quotaSnapshots';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

const WORKSPACE = 'ws-test';

function makeSample(overrides: Partial<QuotaHistorySample> = {}): QuotaHistorySample {
  return {
    timestamp: '2026-05-19T12:00:00.000Z',
    runtimeProvider: 'claude',
    providerId: 'claude-1',
    workspaceId: WORKSPACE,
    fiveHour: { utilization: 40, resetsAt: '2026-05-19T17:00:00.000Z' },
    sevenDay: { utilization: 30, resetsAt: '2026-05-26T12:00:00.000Z' },
    available: true,
    source: 'session',
    ...overrides,
  };
}

function historyFilePath(provider: 'claude' | 'codex'): string {
  return path.join(tmpDir, 'quota-history', WORKSPACE, `${provider}.jsonl`);
}

describe('quotaHistory', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-quota-history-test-'));
    _resetQuotaHistoryInMemoryStateForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetQuotaHistoryInMemoryStateForTests();
  });

  it('round-trips append → read across three UTC days', async () => {
    const day1 = makeSample({ timestamp: '2026-05-17T08:00:00.000Z' });
    const day2 = makeSample({
      timestamp: '2026-05-18T08:00:00.000Z',
      fiveHour: { utilization: 55, resetsAt: 'x' },
    });
    const day3 = makeSample({
      timestamp: '2026-05-19T08:00:00.000Z',
      fiveHour: { utilization: 70, resetsAt: 'x' },
    });

    await appendQuotaHistorySample(day1, { minIntervalMs: 0 });
    await appendQuotaHistorySample(day2, { minIntervalMs: 0 });
    await appendQuotaHistorySample(day3, { minIntervalMs: 0 });

    const samples = await readQuotaHistoryRange({
      workspaceId: WORKSPACE,
      provider: 'claude',
      from: '2026-05-17T00:00:00.000Z',
      to: '2026-05-19T23:59:59.999Z',
    });
    expect(samples.map((s) => s.timestamp)).toEqual([
      '2026-05-17T08:00:00.000Z',
      '2026-05-18T08:00:00.000Z',
      '2026-05-19T08:00:00.000Z',
    ]);
    expect(samples.map((s) => s.fiveHour.utilization)).toEqual([40, 55, 70]);
  });

  it('prunes samples older than the retention window during append', async () => {
    // Seed 200 lines spanning 16 weeks (≈112 days), then append a 201st sample to trigger prune.
    const filePath = historyFilePath('claude');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const now = Date.now();
    const lines: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      // Distribute timestamps across the last 112 days, oldest first.
      const offsetDays = 112 - (i * 112) / 200;
      const ts = new Date(now - offsetDays * 86_400_000).toISOString();
      lines.push(
        JSON.stringify(
          makeSample({
            timestamp: ts,
            fiveHour: { utilization: i % 100, resetsAt: ts },
            sevenDay: { utilization: i % 100, resetsAt: ts },
          }),
        ),
      );
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    // File needs to exceed the prune-skip threshold (16 KB) for the opportunistic prune to fire.
    expect(fs.statSync(filePath).size).toBeGreaterThan(16 * 1024);

    await appendQuotaHistorySample(makeSample({ timestamp: new Date(now).toISOString() }), {
      minIntervalMs: 0,
      retentionDays: 91,
    });

    const remaining = await readQuotaHistoryRange({
      workspaceId: WORKSPACE,
      provider: 'claude',
      from: new Date(now - 365 * 86_400_000).toISOString(),
      to: new Date(now + 1_000).toISOString(),
    });
    const cutoff = now - 91 * 86_400_000;
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(201);
    for (const s of remaining) {
      expect(Date.parse(s.timestamp)).toBeGreaterThanOrEqual(cutoff);
    }
  });

  it('aggregates daily buckets with max, avg, and sample count', async () => {
    // Five samples within the same UTC day.
    const day = '2026-05-19';
    const utilizations = [10, 30, 50, 80, 60];
    let cursor = 0;
    for (const u of utilizations) {
      const ts = `${day}T0${cursor}:00:00.000Z`;
      await appendQuotaHistorySample(
        makeSample({
          timestamp: ts,
          fiveHour: { utilization: u, resetsAt: ts },
          sevenDay: { utilization: u / 2, resetsAt: ts },
        }),
        { minIntervalMs: 0 },
      );
      cursor += 1;
    }

    const buckets = await readQuotaHistoryDailyBuckets({
      workspaceId: WORKSPACE,
      provider: 'claude',
      from: `${day}T00:00:00.000Z`,
      to: `${day}T23:59:59.999Z`,
    });
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0];
    expect(bucket.date).toBe(day);
    expect(bucket.samples).toBe(5);
    expect(bucket.maxUtilizationFiveHour).toBe(80);
    expect(bucket.maxUtilizationSevenDay).toBe(40);
    expect(bucket.avgUtilizationFiveHour).toBeCloseTo(46, 0);
    expect(bucket.avgUtilizationSevenDay).toBeCloseTo(23, 0);
    expect(bucket.anyUnavailable).toBe(false);
  });

  it('emits empty buckets for days with no samples', async () => {
    await appendQuotaHistorySample(
      makeSample({
        timestamp: '2026-05-19T12:00:00.000Z',
        fiveHour: { utilization: 50, resetsAt: 'x' },
      }),
      { minIntervalMs: 0 },
    );

    const buckets = await readQuotaHistoryDailyBuckets({
      workspaceId: WORKSPACE,
      provider: 'claude',
      from: '2026-05-17T00:00:00.000Z',
      to: '2026-05-19T23:59:59.999Z',
    });

    expect(buckets.map((b) => b.date)).toEqual(['2026-05-17', '2026-05-18', '2026-05-19']);
    expect(buckets[0]).toMatchObject({
      samples: 0,
      maxUtilizationFiveHour: 0,
      anyUnavailable: false,
    });
    expect(buckets[1]).toMatchObject({ samples: 0 });
    expect(buckets[2]).toMatchObject({ samples: 1, maxUtilizationFiveHour: 50 });
  });

  it('debounces consecutive appends within minIntervalMs', async () => {
    const ts = '2026-05-19T12:00:00.000Z';
    await appendQuotaHistorySample(makeSample({ timestamp: ts }), { minIntervalMs: 60_000 });
    await appendQuotaHistorySample(makeSample({ timestamp: '2026-05-19T12:00:30.000Z' }), {
      minIntervalMs: 60_000,
    });

    const samples = await readQuotaHistoryRange({
      workspaceId: WORKSPACE,
      provider: 'claude',
      from: '2026-05-19T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });
    expect(samples).toHaveLength(1);
    expect(samples[0].timestamp).toBe(ts);
  });

  it('serializes concurrent appends without interleaving JSON lines', async () => {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 10; i += 1) {
      const ts = new Date(Date.parse('2026-05-19T12:00:00.000Z') + i * 1_000).toISOString();
      tasks.push(
        appendQuotaHistorySample(
          makeSample({
            timestamp: ts,
            fiveHour: { utilization: i * 10, resetsAt: ts },
          }),
          { minIntervalMs: 0 },
        ),
      );
    }
    await Promise.all(tasks);

    const raw = fs.readFileSync(historyFilePath('claude'), 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(10);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('skips malformed lines without throwing', async () => {
    const filePath = historyFilePath('claude');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const good1 = JSON.stringify(makeSample({ timestamp: '2026-05-18T08:00:00.000Z' }));
    const good2 = JSON.stringify(makeSample({ timestamp: '2026-05-19T08:00:00.000Z' }));
    fs.writeFileSync(filePath, `${good1}\n<not json>\n${good2}\n`);

    const samples = await readQuotaHistoryRange({
      workspaceId: WORKSPACE,
      provider: 'claude',
      from: '2026-05-17T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.timestamp)).toEqual([
      '2026-05-18T08:00:00.000Z',
      '2026-05-19T08:00:00.000Z',
    ]);
  });

  it('returns empty results when the history file is missing', async () => {
    const samples = await readQuotaHistoryRange({
      workspaceId: 'nonexistent-workspace',
      provider: 'claude',
    });
    expect(samples).toEqual([]);

    const buckets = await readQuotaHistoryDailyBuckets({
      workspaceId: 'nonexistent-workspace',
      provider: 'claude',
      from: '2026-05-17T00:00:00.000Z',
      to: '2026-05-19T23:59:59.999Z',
    });
    expect(buckets.every((b) => b.samples === 0)).toBe(true);
  });

  it('also refreshes the latest-snapshot store for backward compatibility', async () => {
    await appendQuotaHistorySample(
      makeSample({
        runtimeProvider: 'codex',
        providerId: 'codex-1',
        timestamp: '2026-05-19T12:00:00.000Z',
        fiveHour: { utilization: 73, resetsAt: '2026-05-19T17:00:00.000Z' },
        sevenDay: { utilization: 62, resetsAt: '2026-05-26T12:00:00.000Z' },
      }),
      { minIntervalMs: 0 },
    );

    const cached = readQuotaSnapshot('codex', 'codex-1');
    expect(cached).not.toBeNull();
    expect(cached).toEqual(
      expect.objectContaining({
        providerId: 'codex',
        source: 'cache',
        stale: true,
        capturedAt: '2026-05-19T12:00:00.000Z',
        available: true,
      }),
    );
    expect(cached!.fiveHour.utilization).toBe(73);
    expect(cached!.sevenDay.utilization).toBe(62);
  });

  it('exposes a standalone prune helper', async () => {
    const filePath = historyFilePath('claude');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(makeSample({ timestamp: old })),
        JSON.stringify(makeSample({ timestamp: recent })),
      ].join('\n') + '\n',
    );

    const result = await pruneQuotaHistory(WORKSPACE, 'claude', 91);
    expect(result.pruned).toBe(1);
    expect(result.kept).toBe(1);

    const samples = await readQuotaHistoryRange({
      workspaceId: WORKSPACE,
      provider: 'claude',
      from: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      to: new Date(Date.now() + 1_000).toISOString(),
    });
    expect(samples).toHaveLength(1);
    expect(samples[0].timestamp).toBe(recent);
  });
});
