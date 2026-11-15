import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ default: {} }));

import { BurnRateCalculator } from 'sidekick-shared';
import {
  SESSION_IDLE_AFTER_MS,
  SessionSummaryService,
  modelCallCount,
  newestActivityMs,
  peakContextTokens,
  sessionDurationMs,
} from './SessionSummaryService';
import type { SessionStats } from '../types/claudeSession';

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheWriteTokens: 0,
    totalCacheReadTokens: 0,
    messageCount: 0,
    toolCalls: [],
    modelUsage: new Map(),
    lastUpdated: new Date(),
    toolAnalytics: new Map(),
    timeline: [],
    errorDetails: new Map(),
    currentContextSize: 0,
    recentUsageEvents: [],
    sessionStartTime: null,
    truncationCount: 0,
    contextHealth: 100,
    ...overrides,
  } as SessionStats;
}

describe('SessionSummaryService burn-rate trend', () => {
  it('reads the trend from the samples it is given, not the always-empty monitor field', () => {
    const service = new SessionSummaryService();
    const now = Date.now();
    const rising = [100, 120, 400, 600].map((tokens, i) => ({
      timestamp: new Date(now - (4 - i) * 30_000),
      tokens,
    }));
    const calc = new BurnRateCalculator(5);
    for (const event of rising) calc.addEvent(event.tokens, event.timestamp);

    expect(service.getAdvancedBurnRate(stats(), calc, undefined).trendDirection).toBe('stable');
    expect(service.getAdvancedBurnRate(stats(), calc, undefined, rising).trendDirection).toBe(
      'increasing',
    );
    expect(
      service.getAdvancedBurnRate(stats(), calc, undefined, [...rising].reverse()).trendDirection,
    ).toBe('decreasing');
  });
});

describe('SessionSummaryService duration, peak, and calls', () => {
  it('stops the duration at the last event once the session is idle', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    const start = new Date('2026-11-15T10:00:00Z');
    // Live: the last event was a minute ago, so the clock runs to now.
    expect(sessionDurationMs(start, now - 60_000, now)).toBe(2 * 3_600_000);
    // Idle (or a past session): the duration ends at its last event.
    const lastEvent = Date.parse('2026-11-15T10:45:00Z');
    expect(now - lastEvent).toBeGreaterThan(SESSION_IDLE_AFTER_MS);
    expect(sessionDurationMs(start, lastEvent, now)).toBe(45 * 60_000);
    // Unknown last activity keeps the old behaviour; no start is zero.
    expect(sessionDurationMs(start, 0, now)).toBe(2 * 3_600_000);
    expect(sessionDurationMs(null, lastEvent, now)).toBe(0);
    expect(
      newestActivityMs({
        timeline: [
          { timestamp: '2026-11-15T10:45:00Z' },
          { timestamp: '2026-11-15T10:00:00Z' },
        ] as never,
      }),
    ).toBe(lastEvent);
  });

  it('reports the context peak and the model call count, not the post-compaction size or every event', () => {
    const sample = stats({
      currentContextSize: 36_000,
      contextTimeline: [
        { timestamp: '', inputTokens: 120_000, turnIndex: 1 },
        { timestamp: '', inputTokens: 90_000, turnIndex: 2 },
      ] as never,
      compactionEvents: [
        {
          timestamp: new Date(),
          contextBefore: 180_000,
          contextAfter: 36_000,
          tokensReclaimed: 144_000,
          source: 'reported',
        },
      ] as never,
      messageCount: 300,
      modelUsage: new Map([
        ['claude-sonnet-4-5', { calls: 70 }],
        ['claude-haiku-4-5', { calls: 30 }],
      ]) as never,
    });
    expect(peakContextTokens(sample)).toBe(180_000);
    expect(modelCallCount(sample)).toBe(100);

    const summary = new SessionSummaryService().generateSummary(
      sample,
      { errors: [], recoveryPatterns: [] } as never,
      200_000,
    );
    expect(summary.contextPeak).toBe(90);
    expect(summary.apiCalls).toBe(100);
  });

  it('shortens Windows file paths like POSIX ones', () => {
    const summary = new SessionSummaryService().generateSummary(
      stats({
        toolCalls: [
          {
            name: 'Write',
            input: { file_path: 'C:\\work\\project\\src\\deep\\file.ts', content: 'a\nb' },
            timestamp: new Date(),
          },
        ] as never,
      }),
      { errors: [], recoveryPatterns: [] } as never,
    );
    expect(summary.filesChanged[0].path).toBe('.../src/deep/file.ts');
  });
});
