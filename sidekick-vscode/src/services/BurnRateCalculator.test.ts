/**
 * @fileoverview Tests for BurnRateCalculator — sliding window burn rate.
 *
 * @module BurnRateCalculator.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BurnRateCalculator } from './BurnRateCalculator';

/** Helper: create a Date offset by minutes from a base. */
function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

describe('BurnRateCalculator', () => {
  const baseTime = new Date('2025-01-01T00:00:00Z');
  let calc: BurnRateCalculator;

  beforeEach(() => {
    calc = new BurnRateCalculator(5); // 5-minute window
  });

  // ── calculateBurnRate ─────────────────────────────────────────────

  describe('calculateBurnRate', () => {
    it('returns 0 when no events have been recorded', () => {
      expect(calc.calculateBurnRate(baseTime)).toBe(0);
    });

    it('returns totalTokens / 1 for a single event (minimum 1 min elapsed)', () => {
      // Single event at baseTime, query at baseTime -> elapsed clamped to 1 min
      calc.addEvent(600, baseTime);
      expect(calc.calculateBurnRate(baseTime)).toBe(600); // 600 / 1
    });

    it('calculates rate over elapsed time for multiple events', () => {
      calc.addEvent(600, baseTime);
      calc.addEvent(400, minutesAfter(baseTime, 2));

      // Total tokens = 1000, elapsed = 2 min -> 500 tokens/min
      expect(calc.calculateBurnRate(minutesAfter(baseTime, 2))).toBe(500);
    });

    it('accounts for elapsed time after the last event', () => {
      calc.addEvent(1000, baseTime);
      // Query 4 minutes later — elapsed = 4 min -> 1000/4 = 250
      expect(calc.calculateBurnRate(minutesAfter(baseTime, 4))).toBe(250);
    });

    it('prunes events outside the window', () => {
      calc.addEvent(5000, baseTime);                      // will be pruned
      calc.addEvent(1000, minutesAfter(baseTime, 4));     // inside window

      // Query at minute 6 — window is [1, 6], so baseTime event is pruned
      const now = minutesAfter(baseTime, 6);
      const rate = calc.calculateBurnRate(now);

      // Only 1000 tokens remain, elapsed from minute 4 to 6 = 2 min
      expect(rate).toBe(500);
    });

    it('returns 0 after all events fall outside the window', () => {
      calc.addEvent(1000, baseTime);
      // 6 minutes later: the 5-minute window excludes the event
      expect(calc.calculateBurnRate(minutesAfter(baseTime, 6))).toBe(0);
    });
  });

  // ── estimateTimeToQuota ───────────────────────────────────────────

  describe('estimateTimeToQuota', () => {
    it('returns null when burn rate is zero (no events)', () => {
      expect(calc.estimateTimeToQuota(5000, 100000, baseTime)).toBeNull();
    });

    it('returns 0 when already at quota', () => {
      calc.addEvent(1000, baseTime);
      expect(calc.estimateTimeToQuota(100000, 100000, baseTime)).toBe(0);
    });

    it('returns 0 when over quota', () => {
      calc.addEvent(1000, baseTime);
      expect(calc.estimateTimeToQuota(120000, 100000, baseTime)).toBe(0);
    });

    it('estimates remaining minutes correctly', () => {
      calc.addEvent(1000, baseTime);
      // Burn rate = 1000 tokens/min (single event, 1 min minimum)
      // Remaining = 100000 - 50000 = 50000 tokens
      // ETA = 50000 / 1000 = 50 minutes
      expect(calc.estimateTimeToQuota(50000, 100000, baseTime)).toBe(50);
    });

    it('uses current burn rate for estimation', () => {
      calc.addEvent(2000, baseTime);
      calc.addEvent(2000, minutesAfter(baseTime, 2));

      // Total 4000 tokens over 2 min = 2000 tokens/min
      // Remaining = 10000 - 6000 = 4000
      // ETA = 4000 / 2000 = 2 minutes
      const now = minutesAfter(baseTime, 2);
      expect(calc.estimateTimeToQuota(6000, 10000, now)).toBe(2);
    });
  });

  // ── event management ──────────────────────────────────────────────

  describe('event management', () => {
    it('tracks event count', () => {
      expect(calc.getEventCount()).toBe(0);

      calc.addEvent(100, baseTime);
      expect(calc.getEventCount()).toBe(1);

      calc.addEvent(200, minutesAfter(baseTime, 1));
      expect(calc.getEventCount()).toBe(2);
    });

    it('prunes old events on addEvent', () => {
      calc.addEvent(100, baseTime);
      calc.addEvent(200, minutesAfter(baseTime, 1));

      // Add event 6 minutes later — window is [1, 6], cutoff = minute 1.
      // pruneOldEvents uses >= so the event at exactly minute 1 is kept.
      calc.addEvent(300, minutesAfter(baseTime, 6));
      expect(calc.getEventCount()).toBe(2); // minute 1 event + minute 6 event

      // Add event 7 minutes later — now minute-1 event falls outside
      calc.addEvent(100, minutesAfter(baseTime, 7));
      expect(calc.getEventCount()).toBe(2); // minute 6 + minute 7
    });

    it('reset clears all events', () => {
      calc.addEvent(100, baseTime);
      calc.addEvent(200, minutesAfter(baseTime, 1));

      calc.reset();

      expect(calc.getEventCount()).toBe(0);
      expect(calc.calculateBurnRate(baseTime)).toBe(0);
    });
  });

  // ── custom window size ────────────────────────────────────────────

  describe('custom window size', () => {
    it('respects a 1-minute window', () => {
      const shortCalc = new BurnRateCalculator(1);

      shortCalc.addEvent(500, baseTime);
      shortCalc.addEvent(500, minutesAfter(baseTime, 0.5));

      // At minute 0.5, both events are in window. Elapsed = 0.5 min,
      // but Math.max clamps to 1 min. So rate = 1000 / 1 = 1000
      expect(shortCalc.calculateBurnRate(minutesAfter(baseTime, 0.5))).toBe(1000);

      // At minute 2, both events are outside the 1-minute window
      expect(shortCalc.calculateBurnRate(minutesAfter(baseTime, 2))).toBe(0);

      // Add a new event at minute 2
      shortCalc.addEvent(600, minutesAfter(baseTime, 2));
      // At minute 2.5, elapsed = 0.5 min, clamped to 1 min -> 600/1 = 600
      expect(shortCalc.calculateBurnRate(minutesAfter(baseTime, 2.5))).toBe(600);
      // At minute 2.8, elapsed = 0.8 min, clamped to 1 min -> 600/1 = 600
      expect(shortCalc.calculateBurnRate(minutesAfter(baseTime, 2.8))).toBe(600);
    });
  });

  // ── edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles zero-token events', () => {
      calc.addEvent(0, baseTime);
      expect(calc.calculateBurnRate(baseTime)).toBe(0);
    });

    it('handles very large token values', () => {
      calc.addEvent(1_000_000_000, baseTime);
      expect(calc.calculateBurnRate(baseTime)).toBe(1_000_000_000);
    });

    it('handles many events within a short window', () => {
      for (let i = 0; i < 100; i++) {
        calc.addEvent(10, minutesAfter(baseTime, i * 0.01));
      }
      // 1000 tokens total, elapsed = 0.99 min, clamped to 1 min minimum
      const rate = calc.calculateBurnRate(minutesAfter(baseTime, 0.99));
      expect(rate).toBeGreaterThan(0);
      // Math.max(0.99, 1) = 1, so rate = 1000 / 1 = 1000
      expect(rate).toBe(1000);
    });

    it('handles many events over a longer window', () => {
      for (let i = 0; i < 50; i++) {
        calc.addEvent(100, minutesAfter(baseTime, i * 0.05));
      }
      // 5000 tokens total, elapsed = 2.45 min from first to query time
      const rate = calc.calculateBurnRate(minutesAfter(baseTime, 2.45));
      expect(rate).toBeCloseTo(5000 / 2.45, 0);
    });
  });
});
