import { describe, it, expect } from 'vitest';
import { quotaHistorySampleSchema, quotaHistoryDailyBucketSchema } from './quotaHistory';

describe('quotaHistorySampleSchema', () => {
  it('round-trips a JSONL-line-shaped sample', () => {
    const sample = {
      timestamp: '2026-06-09T08:00:00Z',
      runtimeProvider: 'claude',
      providerId: 'claude-code',
      workspaceId: 'abc123def4567890',
      fiveHour: { utilization: 35, resetsAt: '2026-06-09T12:00:00Z' },
      sevenDay: { utilization: 12, resetsAt: '2026-06-12T00:00:00Z' },
      available: true,
      source: 'api',
    };
    const result = quotaHistorySampleSchema.safeParse(sample);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(sample);
  });

  it('rejects a sample missing workspaceId', () => {
    const result = quotaHistorySampleSchema.safeParse({
      timestamp: '2026-06-09T08:00:00Z',
      runtimeProvider: 'codex',
      providerId: 'codex',
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown runtimeProvider', () => {
    const result = quotaHistorySampleSchema.safeParse({
      timestamp: '2026-06-09T08:00:00Z',
      runtimeProvider: 'opencode',
      providerId: 'opencode',
      workspaceId: 'abc123def4567890',
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('quotaHistoryDailyBucketSchema', () => {
  it('round-trips a bucket', () => {
    const bucket = {
      date: '2026-06-09',
      samples: 17,
      maxUtilizationFiveHour: 88,
      maxUtilizationSevenDay: 41,
      avgUtilizationFiveHour: 52.5,
      avgUtilizationSevenDay: 30.25,
      anyUnavailable: false,
    };
    const result = quotaHistoryDailyBucketSchema.safeParse(bucket);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(bucket);
  });

  it('rejects a bucket with missing aggregates', () => {
    const result = quotaHistoryDailyBucketSchema.safeParse({
      date: '2026-06-09',
      samples: 1,
    });
    expect(result.success).toBe(false);
  });
});
