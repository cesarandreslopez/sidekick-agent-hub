import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ default: {} }));

import { BurnRateCalculator } from 'sidekick-shared';
import { SessionSummaryService } from './SessionSummaryService';
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
