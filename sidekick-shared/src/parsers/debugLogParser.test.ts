import { describe, it, expect } from 'vitest';
import { parseDebugLog, filterByLevel, collapseDuplicates } from './debugLogParser';

const SAMPLE_LOG = `2025-01-15T10:30:00.000Z DEBUG Starting session
2025-01-15T10:30:01.000Z INFO Connected to server
2025-01-15T10:30:02.000Z DEBUG Processing event
  continuation line 1
  continuation line 2
2025-01-15T10:30:03.000Z WARN Rate limit approaching
2025-01-15T10:30:04.000Z ERROR Connection failed
2025-01-15T10:30:05.000Z INFO Reconnecting
2025-01-15T10:30:06.000Z INFO Reconnecting
2025-01-15T10:30:07.000Z INFO Connected to server`;

describe('parseDebugLog', () => {
  it('parses basic log entries', () => {
    const entries = parseDebugLog(SAMPLE_LOG);
    expect(entries.length).toBe(8);
    expect(entries[0].level).toBe('DEBUG');
    expect(entries[0].message).toBe('Starting session');
    expect(entries[0].timestamp).toBe('2025-01-15T10:30:00.000Z');
  });

  it('handles multi-line entries', () => {
    const entries = parseDebugLog(SAMPLE_LOG);
    const multiLine = entries[2]; // DEBUG Processing event
    expect(multiLine.message).toBe('Processing event');
    expect(multiLine.fullContent).toContain('continuation line 1');
    expect(multiLine.fullContent).toContain('continuation line 2');
  });

  it('tracks line numbers', () => {
    const entries = parseDebugLog(SAMPLE_LOG);
    expect(entries[0].lineNumber).toBe(1);
    expect(entries[1].lineNumber).toBe(2);
    // Line 3 = DEBUG Processing event, lines 4-5 are continuation
    expect(entries[2].lineNumber).toBe(3);
    expect(entries[3].lineNumber).toBe(6); // WARN
  });

  it('returns empty array for empty input', () => {
    expect(parseDebugLog('')).toEqual([]);
  });
});

describe('filterByLevel', () => {
  it('filters by minimum level', () => {
    const entries = parseDebugLog(SAMPLE_LOG);

    const warnAndAbove = filterByLevel(entries, 'WARN');
    expect(warnAndAbove.length).toBe(2);
    expect(warnAndAbove[0].level).toBe('WARN');
    expect(warnAndAbove[1].level).toBe('ERROR');
  });

  it('includes all entries at DEBUG level', () => {
    const entries = parseDebugLog(SAMPLE_LOG);
    const all = filterByLevel(entries, 'DEBUG');
    expect(all.length).toBe(entries.length);
  });

  it('returns only errors at ERROR level', () => {
    const entries = parseDebugLog(SAMPLE_LOG);
    const errors = filterByLevel(entries, 'ERROR');
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('Connection failed');
  });
});

describe('collapseDuplicates', () => {
  it('collapses consecutive identical messages', () => {
    const entries = parseDebugLog(SAMPLE_LOG);
    const collapsed = collapseDuplicates(entries);
    // "Reconnecting" appears twice consecutively
    const reconnecting = collapsed.find(e => e.message === 'Reconnecting');
    expect(reconnecting?.duplicateCount).toBe(2);
  });

  it('does not collapse non-consecutive duplicates', () => {
    const entries = parseDebugLog(SAMPLE_LOG);
    const collapsed = collapseDuplicates(entries);
    // "Connected to server" appears at positions 1 and 7 (not consecutive)
    const connected = collapsed.filter(e => e.message === 'Connected to server');
    expect(connected.length).toBe(2);
    expect(connected[0].duplicateCount).toBe(1);
    expect(connected[1].duplicateCount).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(collapseDuplicates([])).toEqual([]);
  });
});
