/**
 * Tests for the date filter expression parser.
 */

import { describe, it, expect } from 'vitest';
import { parseDateExpression, itemTimestampMs, type DateBounds } from './dateFilterExpression';

// Wednesday 2026-07-01 15:30 local time
const NOW = new Date(2026, 6, 1, 15, 30, 0);

function bounds(expr: string): DateBounds {
  const result = parseDateExpression(expr, NOW);
  if ('error' in result) throw new Error(`unexpected parse error: ${result.error}`);
  return result;
}

function iso(y: number, m: number, d: number, h = 0, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

describe('parseDateExpression', () => {
  it("'today' spans from local midnight, open-ended", () => {
    expect(bounds('today')).toEqual({ since: iso(2026, 7, 1) });
  });

  it("'yesterday' spans exactly the previous local day", () => {
    expect(bounds('yesterday')).toEqual({
      since: iso(2026, 6, 30),
      until: iso(2026, 7, 1),
    });
  });

  it('relative hours/days/weeks anchor to now', () => {
    expect(bounds('12h')).toEqual({
      since: new Date(NOW.getTime() - 12 * 3600_000).toISOString(),
    });
    expect(bounds('2d')).toEqual({
      since: new Date(NOW.getTime() - 48 * 3600_000).toISOString(),
    });
    expect(bounds('1w')).toEqual({
      since: new Date(NOW.getTime() - 7 * 24 * 3600_000).toISOString(),
    });
  });

  it('an ISO day spans that local calendar day', () => {
    expect(bounds('2026-06-15')).toEqual({
      since: iso(2026, 6, 15),
      until: iso(2026, 6, 16),
    });
  });

  it("'>' means after the expression's range ends", () => {
    expect(bounds('>2026-06-15')).toEqual({ since: iso(2026, 6, 16) });
    expect(bounds('>yesterday')).toEqual({ since: iso(2026, 7, 1) });
  });

  it("'<' means before the expression's range starts", () => {
    expect(bounds('<2026-06-15')).toEqual({ until: iso(2026, 6, 15) });
    // Older than two days
    expect(bounds('<2d')).toEqual({
      until: new Date(NOW.getTime() - 48 * 3600_000).toISOString(),
    });
  });

  it('trims whitespace and ignores case', () => {
    expect(bounds('  Today ')).toEqual({ since: iso(2026, 7, 1) });
    expect(bounds('> 2026-06-15')).toEqual({ since: iso(2026, 6, 16) });
  });

  it('rejects garbage, rollover dates, and empty input', () => {
    for (const bad of ['garbage', '2026-13-40', '2026-02-30', '5x', '--', '>', '']) {
      const result = parseDateExpression(bad, NOW);
      expect('error' in result, `expected error for ${JSON.stringify(bad)}`).toBe(true);
    }
  });

  it('boundary: an item exactly at local midnight belongs to today', () => {
    const b = bounds('today');
    const midnight = new Date(2026, 6, 1).getTime();
    expect(Date.parse(b.since!)).toBe(midnight);
  });
});

describe('itemTimestampMs', () => {
  it('prefers createdAt, then timestamp', () => {
    expect(itemTimestampMs({ createdAt: '2026-06-15T10:00:00Z' })).toBe(
      Date.parse('2026-06-15T10:00:00Z'),
    );
    expect(itemTimestampMs({ timestamp: '2026-06-15T10:00:00Z' })).toBe(
      Date.parse('2026-06-15T10:00:00Z'),
    );
  });

  it('falls back to the leading date of session identifiers', () => {
    expect(itemTimestampMs({ sessionOrigin: '2026-06-15T10-30-45-abc' })).toBe(
      Date.parse('2026-06-15'),
    );
    expect(itemTimestampMs({ sessionId: '2026-06-15-xyz' })).toBe(Date.parse('2026-06-15'));
  });

  it('returns null for undated or malformed payloads', () => {
    expect(itemTimestampMs(undefined)).toBeNull();
    expect(itemTimestampMs('string')).toBeNull();
    expect(itemTimestampMs({})).toBeNull();
    expect(itemTimestampMs({ createdAt: 'not-a-date' })).toBeNull();
    expect(itemTimestampMs({ sessionId: 'no-date-prefix' })).toBeNull();
  });
});
