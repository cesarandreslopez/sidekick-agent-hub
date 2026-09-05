import { describe, expect, it } from 'vitest';
import {
  applySessionSummary,
  isFileImported,
  markFileImported,
  removeSessionSummary,
  sessionSummaryFromStats,
} from './historicalStore';
import type { SessionFileStats } from './providers/types';
import { createEmptyDataStore } from './types/historicalData';
import type { SessionSummary } from './types/historicalData';

const NOW = new Date('2026-07-21T13:00:00.000Z');

function summary(inputTokens: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    startTime: '2026-07-21T12:00:00.000Z',
    endTime: '2026-07-21T12:05:00.000Z',
    tokens: { inputTokens, outputTokens: 20, cacheWriteTokens: 10, cacheReadTokens: 30 },
    totalCost: inputTokens / 100,
    messageCount: 2,
    modelUsage: [{ model: 'test-model', calls: 2, tokens: inputTokens + 50, cost: 1 }],
    toolUsage: [{ tool: 'Read', calls: 1, successCount: 1, failureCount: 0 }],
    provider: 'claude-code',
    project: '/work/project',
    ...overrides,
  };
}

describe('applySessionSummary', () => {
  it('replaces a saved session contribution instead of accumulating it again', () => {
    const store = createEmptyDataStore();
    applySessionSummary(store, summary(100), { now: NOW });
    applySessionSummary(store, summary(250), { now: NOW });

    const date = Object.keys(store.daily)[0];
    expect(store.daily[date]).toMatchObject({
      sessionCount: 1,
      messageCount: 2,
      totalCost: 2.5,
      tokens: { inputTokens: 250, outputTokens: 20, cacheWriteTokens: 10, cacheReadTokens: 30 },
      modelUsage: [{ model: 'test-model', calls: 2, tokens: 300, cost: 1 }],
      toolUsage: [{ tool: 'Read', calls: 1, successCount: 1, failureCount: 0 }],
      updatedAt: NOW.toISOString(),
    });
    expect(store.monthly[date.slice(0, 7)]).toMatchObject({ sessionCount: 1, totalCost: 2.5 });
    expect(store.allTime).toMatchObject({
      sessionCount: 1,
      tokens: { inputTokens: 250 },
      firstDate: date,
      lastDate: date,
    });
    expect(store.hourly?.[date]).toEqual([
      expect.objectContaining({
        sessionCount: 1,
        tokens: expect.objectContaining({ inputTokens: 250 }),
      }),
    ]);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions?.[0]).toMatchObject({
      sessionId: 'session-1',
      provider: 'claude-code',
      project: '/work/project',
      totalCost: 2.5,
      qualityScore: 0,
      costPerChangedLine: null,
    });
  });

  it('keys daily and hourly buckets by the same local calendar', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Bogota';
    try {
      const store = createEmptyDataStore();
      applySessionSummary(
        store,
        summary(50, {
          sessionId: 'timezone-session',
          startTime: '2026-01-01T02:00:00.000Z',
          endTime: '2026-01-01T02:05:00.000Z',
        }),
        { now: NOW },
      );
      expect(Object.keys(store.daily)).toEqual(['2025-12-31']);
      expect(store.hourly?.['2025-12-31']).toEqual([
        expect.objectContaining({ hour: 21, sessionCount: 1 }),
      ]);
    } finally {
      process.env.TZ = previousTimezone;
    }
  });

  it('caps the per-session list and keeps newest last', () => {
    const store = createEmptyDataStore();
    for (let index = 0; index < 5; index += 1) {
      applySessionSummary(store, summary(10, { sessionId: `s${index}` }), {
        now: NOW,
        retentionLimit: 3,
      });
    }
    expect(store.sessions?.map((session) => session.sessionId)).toEqual(['s2', 's3', 's4']);
    // Aggregates still count every session; only the record list is capped.
    expect(store.allTime.sessionCount).toBe(5);
  });

  it('removes a session cleanly, dropping empty buckets', () => {
    const store = createEmptyDataStore();
    const record = applySessionSummary(store, summary(100), { now: NOW });
    removeSessionSummary(store, record, NOW);
    expect(store.daily).toEqual({});
    expect(store.monthly).toEqual({});
    expect(store.hourly).toEqual({});
    expect(store.allTime).toMatchObject({ sessionCount: 0, totalCost: 0, messageCount: 0 });
    expect(store.allTime.modelUsage).toEqual([]);
  });

  it('taints merged model rows when either side was unpriced', () => {
    const store = createEmptyDataStore();
    applySessionSummary(store, summary(10, { sessionId: 'a' }), { now: NOW });
    applySessionSummary(
      store,
      summary(10, {
        sessionId: 'b',
        modelUsage: [{ model: 'test-model', calls: 1, tokens: 10, cost: 0, priced: false }],
        unpricedModelIds: ['test-model'],
      }),
      { now: NOW },
    );
    expect(store.allTime.modelUsage).toEqual([
      { model: 'test-model', calls: 3, tokens: 70, cost: 1, priced: false },
    ]);
  });
});

describe('markFileImported', () => {
  it('records each path once and stamps the import time', () => {
    const store = createEmptyDataStore();
    expect(isFileImported(store, '/a.jsonl')).toBe(false);
    expect(markFileImported(store, '/a.jsonl', NOW)).toBe(true);
    expect(markFileImported(store, '/a.jsonl', NOW)).toBe(false);
    expect(store.importedFiles).toEqual(['/a.jsonl']);
    expect(store.lastImportTimestamp).toBe(NOW.toISOString());
    expect(isFileImported(store, '/a.jsonl')).toBe(true);
  });
});

describe('sessionSummaryFromStats', () => {
  it('maps unified stats onto the store summary with provider, project, and tool split', () => {
    const stats: SessionFileStats = {
      providerId: 'codex',
      sessionId: 'abc',
      filePath: '/rollouts/abc.jsonl',
      label: 'Fix it',
      startTime: '2026-09-04T12:00:00.000Z',
      endTime: '',
      messageCount: 4,
      tokens: { input: 100, output: 50, cacheWrite: 5, cacheRead: 400 },
      modelUsage: {
        'gpt-5-codex': { calls: 2, tokens: 555, costUsd: 0.12, priced: true },
        mystery: { calls: 1, tokens: 10, costUsd: 0, priced: false },
      },
      toolUsage: { Read: 3, Bash: 2 },
      toolFailures: { Bash: 1 },
      compactionEstimate: 0,
      truncationCount: 0,
      costUsd: 0.12,
      costProvenance: 'estimated',
      unpricedCalls: 1,
      availability: 'full',
      reportedCost: 0.12,
    };

    expect(sessionSummaryFromStats(stats, { project: '/work' })).toEqual({
      sessionId: 'abc',
      startTime: '2026-09-04T12:00:00.000Z',
      endTime: '2026-09-04T12:00:00.000Z',
      tokens: { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 5, cacheReadTokens: 400 },
      totalCost: 0.12,
      messageCount: 4,
      modelUsage: [
        { model: 'gpt-5-codex', calls: 2, tokens: 555, cost: 0.12, priced: true },
        { model: 'mystery', calls: 1, tokens: 10, cost: 0, priced: false },
      ],
      toolUsage: [
        { tool: 'Read', calls: 3, successCount: 3, failureCount: 0 },
        { tool: 'Bash', calls: 2, successCount: 1, failureCount: 1 },
      ],
      unpricedModelIds: ['mystery'],
      provider: 'codex',
      project: '/work',
    });
  });
});
