import { describe, expect, it } from 'vitest';
import {
  ZAI_PROMPT_INVOCATIONS,
  ZAI_TIER_BUDGETS,
  accumulateZaiUsage,
  extractNextFlushTime,
  inferZaiQuotaState,
  isZaiProviderId,
  makeUnavailableZaiQuotaState,
  parseZaiQuotaError,
  resolveZaiTier,
  turnTokenWeight,
  type ZaiAssistantTurn,
} from './zaiQuota';

const NOW = Date.parse('2025-06-01T12:00:00Z');

function turn(
  minutesAgo: number,
  partial: Partial<ZaiAssistantTurn> = {},
): ZaiAssistantTurn {
  return {
    timestampMs: NOW - minutesAgo * 60_000,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...partial,
  };
}

describe('zaiQuota', () => {
  describe('isZaiProviderId', () => {
    it('recognises the documented z.ai providerIDs', () => {
      expect(isZaiProviderId('zai')).toBe(true);
      expect(isZaiProviderId('zai-coding-plan')).toBe(true);
      expect(isZaiProviderId('openai')).toBe(false);
      expect(isZaiProviderId(undefined)).toBe(false);
    });
  });

  describe('turnTokenWeight', () => {
    it('weights cache reads at 0.1x', () => {
      expect(turnTokenWeight({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        reasoningTokens: 50,
      })).toBe(1000 + 500 + 100 + 200 + 50);
    });
  });

  describe('accumulateZaiUsage', () => {
    it('returns zero usage for an empty buffer', () => {
      const result = accumulateZaiUsage([], NOW);
      expect(result.fiveHourTurns).toBe(0);
      expect(result.weeklyTurns).toBe(0);
      expect(result.fiveHourStartedAtMs).toBeNull();
      expect(result.weeklyStartedAtMs).toBeNull();
    });

    it('buckets turns inside vs outside the 5-hour window', () => {
      const turns = [
        turn(10),               // inside 5h
        turn(60),               // inside 5h
        turn(60 * 4),           // exactly 4h ago — still inside
        turn(60 * 6),           // 6h ago — outside 5h, inside 7d
        turn(60 * 24 * 8),      // 8d ago — outside 7d
      ];
      const result = accumulateZaiUsage(turns, NOW);
      expect(result.fiveHourTurns).toBe(3);
      expect(result.weeklyTurns).toBe(4); // 3 inside 5h + 1 (6h ago)
    });

    it('captures the earliest in-window timestamp as the window start', () => {
      const turns = [turn(30), turn(60), turn(120)];
      const result = accumulateZaiUsage(turns, NOW);
      expect(result.fiveHourStartedAtMs).toBe(turn(120).timestampMs);
      expect(result.weeklyStartedAtMs).toBe(turn(120).timestampMs);
    });

    it('estimates prompts by dividing turns by the documented midpoint', () => {
      const turns = [turn(10), turn(20)];
      const result = accumulateZaiUsage(turns, NOW);
      expect(result.fiveHourPrompts).toBeCloseTo(2 / ZAI_PROMPT_INVOCATIONS, 5);
    });
  });

  describe('resolveZaiTier', () => {
    it('returns the configured tier when not "auto"', () => {
      expect(resolveZaiTier('max', accumulateZaiUsage([], NOW))).toBe('max');
      expect(resolveZaiTier('pro', accumulateZaiUsage([], NOW))).toBe('pro');
    });

    it('upgrades to max when weekly usage exceeds the pro budget', () => {
      const overPro: ZaiAssistantTurn[] = [];
      const overProPrompts = ZAI_TIER_BUDGETS.pro.weekly + 1;
      const turnsNeeded = Math.ceil(overProPrompts * ZAI_PROMPT_INVOCATIONS);
      for (let i = 0; i < turnsNeeded; i++) overPro.push(turn(60));
      expect(resolveZaiTier('auto', accumulateZaiUsage(overPro, NOW))).toBe('max');
    });

    it('defaults to lite when usage is low', () => {
      expect(resolveZaiTier('auto', accumulateZaiUsage([turn(10)], NOW))).toBe('lite');
    });
  });

  describe('inferZaiQuotaState', () => {
    it('computes utilisation against the configured tier budget', () => {
      const turns: ZaiAssistantTurn[] = [];
      // Pick a turn count that maps to 50% of Lite's 5h budget (40 prompts).
      const targetPrompts = 40;
      const turnsNeeded = Math.round(targetPrompts * ZAI_PROMPT_INVOCATIONS);
      for (let i = 0; i < turnsNeeded; i++) turns.push(turn(30));
      const accumulated = accumulateZaiUsage(turns, NOW);
      const state = inferZaiQuotaState(accumulated, 'lite', { capturedAt: '2025-06-01T12:00:00Z' });

      expect(state.available).toBe(true);
      expect(state.providerId).toBe('zai');
      expect(state.fiveHourLabel).toBe('5-Hour');
      expect(state.sevenDayLabel).toBe('Weekly');
      expect(state.planType).toBe('lite');
      expect(state.fiveHour.utilization).toBeGreaterThan(45);
      expect(state.fiveHour.utilization).toBeLessThan(55);
    });

    it('stamps resetsAt = firstTurn + windowDuration when no authoritative override', () => {
      const turns = [turn(60)]; // 1h ago
      const accumulated = accumulateZaiUsage(turns, NOW);
      const state = inferZaiQuotaState(accumulated, 'max');
      const expectedFiveHourReset = new Date(turn(60).timestampMs + 5 * 3600_000).toISOString();
      const expectedSevenDayReset = new Date(turn(60).timestampMs + 7 * 86_400_000).toISOString();
      expect(state.fiveHour.resetsAt).toBe(expectedFiveHourReset);
      expect(state.sevenDay.resetsAt).toBe(expectedSevenDayReset);
    });

    it('uses authoritative reset timestamps when supplied', () => {
      const state = inferZaiQuotaState(
        accumulateZaiUsage([turn(10)], NOW),
        'max',
        {
          authoritativeFiveHourResetAt: '2025-06-01T15:00:00Z',
          authoritativeWeeklyResetAt: '2025-06-05T00:00:00Z',
        },
      );
      expect(state.fiveHour.resetsAt).toBe('2025-06-01T15:00:00Z');
      expect(state.sevenDay.resetsAt).toBe('2025-06-05T00:00:00Z');
    });

    it('caps utilization at 200 when over budget', () => {
      const turns: ZaiAssistantTurn[] = [];
      // 10x Lite's 5h budget
      const turnsNeeded = Math.round(10 * 80 * ZAI_PROMPT_INVOCATIONS);
      for (let i = 0; i < turnsNeeded; i++) turns.push(turn(30));
      const state = inferZaiQuotaState(accumulateZaiUsage(turns, NOW), 'lite');
      expect(state.fiveHour.utilization).toBe(200);
    });

    it('marks unavailable state when no turns observed', () => {
      const state = inferZaiQuotaState(accumulateZaiUsage([], NOW), 'max');
      expect(state.available).toBe(false);
      expect(state.stale).toBe(true);
    });
  });

  describe('makeUnavailableZaiQuotaState', () => {
    it('returns a properly tagged unavailable state', () => {
      const state = makeUnavailableZaiQuotaState('custom message', 'pro');
      expect(state.available).toBe(false);
      expect(state.error).toBe('custom message');
      expect(state.providerId).toBe('zai');
      expect(state.planType).toBe('pro');
      expect(state.fiveHourLabel).toBe('5-Hour');
    });
  });

  describe('parseZaiQuotaError', () => {
    it('parses code 1308 as "exhausted"', () => {
      const result = parseZaiQuotaError({
        code: '1308',
        message: 'Usage limit reached for 5 hour, next_flush_time: 2025-06-01T17:00:00Z',
      });
      expect(result?.kind).toBe('exhausted');
      expect(result?.resetsAt).toBe('2025-06-01T17:00:00.000Z');
    });

    it('parses code 1310 as weekly-exhausted', () => {
      const result = parseZaiQuotaError({
        code: 1310,
        message: 'Weekly limit exhausted, resets at 2025-06-05 00:00:00',
      });
      expect(result?.kind).toBe('exhausted');
      expect(result?.resetsAt).toBe('2025-06-05T00:00:00.000Z');
    });

    it('parses code 1309 as expired', () => {
      const result = parseZaiQuotaError({ code: '1309', message: 'Plan expired' });
      expect(result?.kind).toBe('expired');
      expect(result?.resetsAt).toBeUndefined();
    });

    it('returns null for non-quota codes', () => {
      expect(parseZaiQuotaError({ code: '5000', message: 'unrelated' })).toBeNull();
      expect(parseZaiQuotaError({ message: 'no code' })).toBeNull();
    });
  });

  describe('extractNextFlushTime', () => {
    it('parses ISO 8601 timestamps', () => {
      expect(extractNextFlushTime('resets 2025-06-01T17:00:00Z please')).toBe('2025-06-01T17:00:00.000Z');
    });

    it('parses space-separated timestamps as UTC', () => {
      expect(extractNextFlushTime('at 2025-06-01 17:00:00')).toBe('2025-06-01T17:00:00.000Z');
    });

    it('parses epoch-seconds in a plausible range', () => {
      // 2025-06-01T12:00:00Z = 1748779200 epoch-seconds.
      expect(extractNextFlushTime('flush at 1748779200')).toBe('2025-06-01T12:00:00.000Z');
    });

    it('returns undefined when no timestamp is present', () => {
      expect(extractNextFlushTime('limit reached')).toBeUndefined();
      expect(extractNextFlushTime('')).toBeUndefined();
    });
  });
});
