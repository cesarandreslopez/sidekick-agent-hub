import { describe, expect, it } from 'vitest';
import { formatCost, formatDurationMs, formatTokenCount } from './formatting';

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

describe('formatCost', () => {
  // The implementation shipped before the `source` option, kept verbatim so
  // numeric output stays byte-identical for every existing caller.
  function previousFormatCost(cost: number | null | undefined): string {
    if (cost === null || cost === undefined) return '—';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  }

  const values = [
    0,
    -0,
    0.001234,
    0.005,
    0.00999,
    0.009999,
    0.01,
    0.015,
    1.005,
    1.234,
    12.345,
    1234567.891,
    1e-10,
    1e21,
    -0.5,
    -5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];

  it('keeps numeric output byte-identical to the previous implementation', () => {
    for (const value of values) {
      expect(formatCost(value), String(value)).toBe(previousFormatCost(value));
      expect(formatCost(value, { source: 'reported' }), String(value)).toBe(
        previousFormatCost(value),
      );
      expect(formatCost(value, {}), String(value)).toBe(previousFormatCost(value));
    }
  });

  it('pins the documented outputs', () => {
    expect(formatCost(0)).toBe('$0.0000');
    expect(formatCost(0.001234)).toBe('$0.0012');
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
    expect(formatCost(1234.5)).toBe('$1234.50');
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
  });

  it('renders unpriced values as a dash whatever the number', () => {
    expect(formatCost(0, { source: 'unpriced' })).toBe('—');
    expect(formatCost(1.23, { source: 'unpriced' })).toBe('—');
    expect(formatCost(null, { source: 'unpriced' })).toBe('—');
  });

  it('marks estimated values', () => {
    expect(formatCost(1.234, { source: 'estimated' })).toBe('$1.23 (est.)');
    expect(formatCost(0.001234, { source: 'estimated' })).toBe('$0.0012 (est.)');
    expect(formatCost(0, { source: 'estimated' })).toBe('$0.0000 (est.)');
    expect(formatCost(null, { source: 'estimated' })).toBe('—');
    expect(formatCost(undefined, { source: 'estimated' })).toBe('—');
  });

  it('stays safe as an array callback', () => {
    // `map` passes the index as the second argument; it must be ignored, and
    // the call must still type-check without a cast.
    expect([0.5, 2].map(formatCost)).toEqual(['$0.50', '$2.00']);
  });
});
