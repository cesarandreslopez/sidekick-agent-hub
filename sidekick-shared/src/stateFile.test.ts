import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sidekickStateFileSchema } from './schemas/stateFile';
import {
  STATE_FILE_SCHEMA_VERSION,
  billingBlockToStateFile,
  quotaToStateFile,
  readStateFile,
  writeStateFile,
} from './stateFile';
import type { SidekickStateInput } from './stateFile';

let tmpDir: string;
let filePath: string;

const NOW = new Date('2026-09-04T12:00:00Z');

function input(overrides: Partial<SidekickStateInput> = {}): SidekickStateInput {
  return {
    writer: 'statusline',
    account: { providerId: 'claude-code', id: 'acct-1', label: 'Work' },
    quota: {
      claude: {
        fiveHour: { utilization: 42, resetsAt: '2026-09-04T15:00:00Z' },
        sevenDay: { utilization: 61, resetsAt: '2026-09-08T09:00:00Z' },
        source: 'statusline',
        capturedSource: null,
        capturedAt: NOW.toISOString(),
        ageMs: 0,
        freshness: 'fresh',
      },
      codex: null,
    },
    context: {
      usedPercentage: 37,
      contextWindowSize: 200_000,
      totalInputTokens: 60_000,
      totalOutputTokens: 14_000,
    },
    session: {
      sessionId: 'sess-1',
      cwd: '/work/project',
      model: 'claude-sonnet-4-5',
      costUsd: 0.42,
      durationMs: 600_000,
      linesAdded: 12,
      linesRemoved: 3,
      promptCacheHitRatio: 0.93,
    },
    billingBlock: null,
    ...overrides,
  };
}

describe('writeStateFile', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-state-file-'));
    filePath = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a versioned document that validates against the public schema', () => {
    expect(writeStateFile(input(), { filePath, now: NOW })).toBe(true);
    const state = readStateFile(filePath);
    expect(state).toMatchObject({
      schemaVersion: STATE_FILE_SCHEMA_VERSION,
      writtenAt: NOW.toISOString(),
      writer: 'statusline',
      account: { providerId: 'claude-code', id: 'acct-1' },
    });
    expect(sidekickStateFileSchema.safeParse(state).success).toBe(true);
  });

  it('skips the write when nothing but the timestamp would change', () => {
    writeStateFile(input(), { filePath, now: NOW });
    const before = fs.statSync(filePath).mtimeMs;
    expect(writeStateFile(input(), { filePath, now: new Date(NOW.getTime() + 60_000) })).toBe(
      false,
    );
    expect(readStateFile(filePath)?.writtenAt).toBe(NOW.toISOString());
    expect(fs.statSync(filePath).mtimeMs).toBe(before);

    expect(
      writeStateFile(input({ context: null }), { filePath, now: new Date(NOW.getTime() + 60_000) }),
    ).toBe(true);
    expect(readStateFile(filePath)?.context).toBeNull();
  });

  it('overwrites a corrupt or foreign file and never throws', () => {
    fs.writeFileSync(filePath, '{not json');
    expect(readStateFile(filePath)).toBeNull();
    expect(writeStateFile(input(), { filePath, now: NOW })).toBe(true);
    expect(readStateFile(filePath)?.session?.sessionId).toBe('sess-1');

    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99 }));
    expect(readStateFile(filePath)).toBeNull();
    expect(writeStateFile(input(), { filePath, now: NOW })).toBe(true);

    // An unwritable location is reported as "not written", not thrown.
    expect(writeStateFile(input(), { filePath: path.join(filePath, 'nested', 'x.json') })).toBe(
      false,
    );
  });
});

describe('state-file projections', () => {
  it('projects quota samples and billing blocks, dropping unavailable quota', () => {
    expect(quotaToStateFile(null)).toBeNull();
    expect(
      quotaToStateFile({
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
      }),
    ).toBeNull();
    expect(
      quotaToStateFile({
        fiveHour: { utilization: 42, resetsAt: '2026-09-04T15:00:00Z' },
        sevenDay: { utilization: 61, resetsAt: '' },
        available: true,
        source: 'cache',
        capturedSource: 'statusline',
        capturedAt: NOW.toISOString(),
        ageMs: 120_000,
        freshness: 'fresh',
      }),
    ).toEqual({
      fiveHour: { utilization: 42, resetsAt: '2026-09-04T15:00:00Z' },
      sevenDay: { utilization: 61, resetsAt: '' },
      source: 'cache',
      capturedSource: 'statusline',
      capturedAt: NOW.toISOString(),
      ageMs: 120_000,
      freshness: 'fresh',
    });

    // A live sample has a capture time but no age: derive both from `now`.
    expect(
      quotaToStateFile(
        {
          fiveHour: { utilization: 42, resetsAt: '' },
          sevenDay: { utilization: 0, resetsAt: '' },
          available: true,
          source: 'statusline',
          capturedAt: NOW.toISOString(),
        },
        NOW.getTime() + 30_000,
      ),
    ).toMatchObject({ source: 'statusline', ageMs: 30_000, freshness: 'fresh' });

    expect(billingBlockToStateFile(null)).toBeNull();
    expect(
      billingBlockToStateFile({
        id: '2026-09-04T12:00:00.000Z',
        start: '2026-09-04T12:00:00.000Z',
        end: '2026-09-04T17:00:00.000Z',
        firstEvent: '2026-09-04T12:34:00.000Z',
        lastEvent: '2026-09-04T13:00:00.000Z',
        isActive: true,
        calls: 3,
        tokens: {
          inputTokens: 1,
          outputTokens: 2,
          cacheWriteTokens: 3,
          cacheReadTokens: 4,
          total: 10,
        },
        costUsd: 0.5,
        costProvenance: 'estimated',
        unpricedCalls: 0,
        models: {},
        elapsedMs: 60_000,
        remainingMs: 3_600_000,
        burnRatePerMinute: 100,
        projectedTokens: 6010,
        projectedCostUsd: 300.5,
      }),
    ).toEqual({
      start: '2026-09-04T12:00:00.000Z',
      end: '2026-09-04T17:00:00.000Z',
      isActive: true,
      tokens: 10,
      costUsd: 0.5,
      costProvenance: 'estimated',
      burnRatePerMinute: 100,
      projectedTokens: 6010,
      projectedCostUsd: 300.5,
      remainingMs: 3_600_000,
    });
  });
});
