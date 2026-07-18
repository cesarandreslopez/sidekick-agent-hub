import { describe, expect, it } from 'vitest';
import { EventAggregator } from '../aggregation/EventAggregator';
import { calculateCodeImpact } from './codeImpact';
import { calculateCompactionLedger, formatCompactionLedger } from './compactionLedger';
import { calculateQualityTrend, scoreSessionQuality } from './qualityScore';

describe('shared analytics engines', () => {
  it('scores a clean completed session on a 0-100 beta scale', () => {
    const metrics = new EventAggregator().getMetrics();
    const score = scoreSessionQuality(metrics);
    expect(score.beta).toBe(true);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.factors.reduce((sum, factor) => sum + factor.maximum, 0)).toBe(100);
  });

  it('calculates cost per changed line and per-model table', () => {
    expect(calculateCodeImpact(4, 30, 10, [{ model: 'model-a', cost: 2 }])).toMatchObject({
      changedLines: 40,
      costPerChangedLine: 0.1,
      byModel: [{ model: 'model-a', costPerChangedLine: 0.05 }],
    });
    expect(calculateCodeImpact(4, 0, 0).costPerChangedLine).toBeNull();
  });

  it('labels reported and heuristic compaction facts honestly', () => {
    const ledger = calculateCompactionLedger([
      {
        timestamp: new Date(),
        contextBefore: 1000,
        contextAfter: 700,
        tokensReclaimed: 300,
        source: 'reported',
      },
      {
        timestamp: new Date(),
        contextBefore: 700,
        contextAfter: 500,
        tokensReclaimed: 200,
        source: 'heuristic',
      },
    ]);
    expect(ledger).toMatchObject({ count: 2, tokensEvicted: 500, source: 'mixed' });
    expect(formatCompactionLedger(ledger)).toContain('500 tokens evicted');
  });

  it('calculates a week-over-week quality trend', () => {
    const base = {
      provider: 'codex',
      project: 'project',
      startTime: '',
      tokens: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      totalCost: 0,
      messageCount: 0,
      qualityFactors: [],
      additions: 0,
      deletions: 0,
      costPerChangedLine: null,
    };
    const trend = calculateQualityTrend(
      [
        {
          ...base,
          sessionId: 'previous',
          endTime: '2026-07-08T12:00:00Z',
          qualityScore: 70,
        },
        {
          ...base,
          sessionId: 'current',
          endTime: '2026-07-17T12:00:00Z',
          qualityScore: 82,
        },
      ],
      new Date('2026-07-18T12:00:00Z'),
    );
    expect(trend).toMatchObject({
      currentWeekAverage: 82,
      previousWeekAverage: 70,
      delta: 12,
      direction: 'improving',
    });
  });
});
