import { describe, expect, it } from 'vitest';
import { formatDurationMs, formatTokenCount } from './formatting';

describe('formatTokenCount', () => {
  it('formats small counts as integers', () => {
    expect(formatTokenCount(42)).toBe('42');
    expect(formatTokenCount(999.9)).toBe('999');
  });

  it('formats thousands and millions with compact suffixes', () => {
    expect(formatTokenCount(15_000)).toBe('15.0k');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });

  it('supports uppercase thousands for terminal consumers', () => {
    expect(formatTokenCount(12_500, { suffixCase: 'upper' })).toBe('12.5K');
  });

  it('handles invalid numbers defensively', () => {
    expect(formatTokenCount(Number.NaN)).toBe('0');
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatDurationMs', () => {
  it('formats seconds', () => {
    expect(formatDurationMs(45_000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDurationMs(330_000)).toBe('5m 30s');
  });

  it('formats hours', () => {
    expect(formatDurationMs(5_415_000)).toBe('1h 30m 15s');
  });

  it('supports compact terminal formatting', () => {
    expect(formatDurationMs(5_000, { style: 'compact', secondsFractionDigits: 1 })).toBe('5.0s');
    expect(formatDurationMs(65_000, { style: 'compact', secondsFractionDigits: 1 })).toBe('1m5s');
  });

  it('can render sub-second durations as milliseconds', () => {
    expect(formatDurationMs(250, { includeMilliseconds: true })).toBe('250ms');
  });

  it('returns N/A for invalid durations by default', () => {
    expect(formatDurationMs(-1)).toBe('N/A');
    expect(formatDurationMs(Number.NaN)).toBe('N/A');
  });
});
