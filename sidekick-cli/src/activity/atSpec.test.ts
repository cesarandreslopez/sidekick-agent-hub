import { describe, expect, it } from 'vitest';
import { parseAtSpec, resolveAt } from './atSpec';

const START = Date.parse('2026-11-10T22:00:00');
const END = Date.parse('2026-11-10T23:30:00');
const range = { startMs: START, endMs: END };

describe('parseAtSpec', () => {
  it('reads the named ends', () => {
    expect(parseAtSpec('end')).toEqual({ kind: 'end' });
    expect(parseAtSpec('NOW')).toEqual({ kind: 'end' });
    expect(parseAtSpec('')).toEqual({ kind: 'end' });
    expect(parseAtSpec('start')).toEqual({ kind: 'start' });
  });

  it('reads offsets from either end, compound units included', () => {
    expect(parseAtSpec('+15m')).toEqual({ kind: 'offset', from: 'start', ms: 900_000 });
    expect(parseAtSpec('+1h30m')).toEqual({ kind: 'offset', from: 'start', ms: 5_400_000 });
    expect(parseAtSpec('+90s')).toEqual({ kind: 'offset', from: 'start', ms: 90_000 });
    expect(parseAtSpec('-5m')).toEqual({ kind: 'offset', from: 'end', ms: 300_000 });
  });

  it('rejects a bare duration, which elsewhere means "ago"', () => {
    expect(() => parseAtSpec('15m')).toThrow(/\+15m.*-15m/);
  });

  it('reads percentages, clock times and ISO date-times', () => {
    expect(parseAtSpec('50%')).toEqual({ kind: 'fraction', value: 0.5 });
    expect(parseAtSpec('14:03')).toEqual({ kind: 'clock', hours: 14, minutes: 3, seconds: 0 });
    expect(parseAtSpec('14:03:20')).toEqual({ kind: 'clock', hours: 14, minutes: 3, seconds: 20 });
    expect(parseAtSpec('2026-11-10T22:30:00Z')).toEqual({
      kind: 'absolute',
      ms: Date.parse('2026-11-10T22:30:00Z'),
    });
  });

  it('refuses anything else with a hint', () => {
    expect(() => parseAtSpec('150%')).toThrow(/100%/);
    expect(() => parseAtSpec('25:00')).toThrow(/time of day/);
    expect(() => parseAtSpec('yesterday')).toThrow(/use end, start/);
  });
});

describe('resolveAt', () => {
  it('places each form inside the session', () => {
    expect(resolveAt({ kind: 'end' }, range)).toEqual({ at: END, clamped: false });
    expect(resolveAt({ kind: 'start' }, range)).toEqual({ at: START, clamped: false });
    expect(resolveAt(parseAtSpec('+15m'), range).at).toBe(START + 900_000);
    expect(resolveAt(parseAtSpec('-5m'), range).at).toBe(END - 300_000);
    expect(resolveAt(parseAtSpec('50%'), range).at).toBe(START + 45 * 60_000);
    expect(resolveAt(parseAtSpec('22:45'), range).at).toBe(Date.parse('2026-11-10T22:45:00'));
  });

  it('clamps a moment outside the session to its nearest end and says so', () => {
    expect(resolveAt(parseAtSpec('+5h'), range)).toEqual({ at: END, clamped: true });
    expect(resolveAt(parseAtSpec('-5h'), range)).toEqual({ at: START, clamped: true });
  });

  it('reads a clock time on the next day when the session crossed midnight', () => {
    const late = {
      startMs: Date.parse('2026-11-10T23:00:00'),
      endMs: Date.parse('2026-11-11T01:00:00'),
    };
    expect(resolveAt(parseAtSpec('00:30'), late)).toEqual({
      at: Date.parse('2026-11-11T00:30:00'),
      clamped: false,
    });
  });
});
