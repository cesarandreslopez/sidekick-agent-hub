import { beforeEach, describe, expect, it } from 'vitest';
import { BurnRateCalculator, estimateTimeToQuota } from './BurnRateCalculator';

function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

describe('BurnRateCalculator', () => {
  const baseTime = new Date('2026-01-01T00:00:00Z');
  let calculator: BurnRateCalculator;

  beforeEach(() => {
    calculator = new BurnRateCalculator(5);
  });

  describe('calculateBurnRate', () => {
    it('returns 0 when no events have been recorded', () => {
      expect(calculator.calculateBurnRate(baseTime)).toBe(0);
    });

    it('clamps elapsed time to one minute so a burst does not divide by ~zero', () => {
      calculator.addEvent(600, baseTime);
      expect(calculator.calculateBurnRate(baseTime)).toBe(600);
    });

    it('calculates the rate over elapsed time for multiple events', () => {
      calculator.addEvent(600, baseTime);
      calculator.addEvent(400, minutesAfter(baseTime, 2));

      expect(calculator.calculateBurnRate(minutesAfter(baseTime, 2))).toBe(500);
    });

    it('accounts for elapsed time after the last event', () => {
      calculator.addEvent(1000, baseTime);
      expect(calculator.calculateBurnRate(minutesAfter(baseTime, 4))).toBe(250);
    });

    it('prunes events that fall outside the window', () => {
      calculator.addEvent(5000, baseTime);
      calculator.addEvent(1000, minutesAfter(baseTime, 4));

      expect(calculator.calculateBurnRate(minutesAfter(baseTime, 6))).toBe(500);
    });

    it('returns 0 after every event has aged out of the window', () => {
      calculator.addEvent(1000, baseTime);
      expect(calculator.calculateBurnRate(minutesAfter(baseTime, 6))).toBe(0);
    });
  });

  describe('estimateTimeToQuota (method)', () => {
    it('returns null when the burn rate is zero', () => {
      expect(calculator.estimateTimeToQuota(5_000, 100_000, baseTime)).toBeNull();
    });

    it('returns 0 when already at or over quota', () => {
      calculator.addEvent(1000, baseTime);
      expect(calculator.estimateTimeToQuota(100_000, 100_000, baseTime)).toBe(0);
      expect(calculator.estimateTimeToQuota(150_000, 100_000, baseTime)).toBe(0);
    });

    it('divides the remaining budget by the current burn rate', () => {
      calculator.addEvent(1000, baseTime);
      // Rate = 1000 tokens/min; 10,000 remaining -> 10 minutes.
      expect(calculator.estimateTimeToQuota(90_000, 100_000, baseTime)).toBe(10);
    });
  });

  describe('bookkeeping', () => {
    it('counts events and prunes the count as they age out', () => {
      calculator.addEvent(100, baseTime);
      calculator.addEvent(100, minutesAfter(baseTime, 1));
      expect(calculator.getEventCount()).toBe(2);

      calculator.addEvent(100, minutesAfter(baseTime, 7));
      expect(calculator.getEventCount()).toBe(1);
    });

    it('reset clears all events', () => {
      calculator.addEvent(100, baseTime);
      calculator.reset();
      expect(calculator.getEventCount()).toBe(0);
      expect(calculator.calculateBurnRate(baseTime)).toBe(0);
    });
  });
});

describe('estimateTimeToQuota (pure helper)', () => {
  it('returns null for zero or negative burn rates', () => {
    expect(estimateTimeToQuota(0, 100, 0)).toBeNull();
    expect(estimateTimeToQuota(0, 100, -5)).toBeNull();
  });

  it('returns 0 at or over quota', () => {
    expect(estimateTimeToQuota(100, 100, 10)).toBe(0);
    expect(estimateTimeToQuota(150, 100, 10)).toBe(0);
  });

  it('returns the remaining budget divided by the rate', () => {
    expect(estimateTimeToQuota(40, 100, 20)).toBe(3);
  });
});
