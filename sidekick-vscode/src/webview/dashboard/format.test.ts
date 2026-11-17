import { describe, expect, it } from 'vitest';
import { SESSION_LIVE_WINDOW_MS } from '../../utils/sessionLiveness';
import { SESSION_IDLE_AFTER_MS as SUMMARY_IDLE_AFTER_MS } from '../../services/SessionSummaryService';
import {
  SESSION_IDLE_AFTER_MS,
  axisCost,
  compactNumber,
  exactNumber,
  frequentWords,
  plural,
  sessionDurationText,
  statusLabel,
} from './format';

describe('dashboard format helpers', () => {
  it('formats compact and exact numbers', () => {
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(12_345)).toBe('12.3k');
    expect(compactNumber(12_345_678)).toBe('12.3M');
    // The old helper turned 999,600 into "1000K".
    expect(compactNumber(999_960)).toBe('1.0M');
    expect(compactNumber(Number.NaN)).toBe('0');
    expect(exactNumber(1_234_567)).toBe('1,234,567');
  });

  it('formats axis dollars, plurals, and statuses', () => {
    expect(axisCost(0)).toBe('$0');
    expect(axisCost(0.5)).toBe('$0.5');
    expect(axisCost(1)).toBe('$1');
    expect(axisCost(1500)).toBe('$1.5k');
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(3, 'file')).toBe('3 files');
    expect(statusLabel('in_progress')).toBe('In Progress');
    expect(statusLabel('completed')).toBe('Completed');
    expect(statusLabel('waiting_on_user')).toBe('Waiting On User');
  });

  it('drops stopwords before taking the top words', () => {
    const words = [
      { name: 'the', count: 90 },
      { name: 'and', count: 80 },
      { name: 'file', count: 70 },
      { name: 'ok', count: 60 },
      { name: 'migration', count: 50 },
      { name: 'schema', count: 40 },
      { name: 'Tests', count: 30 },
    ];
    expect(frequentWords(words, 2).map((w) => w.name)).toEqual(['migration', 'schema']);
    expect(frequentWords(words, 8).map((w) => w.name)).toEqual(['migration', 'schema', 'Tests']);
    expect(frequentWords(undefined, 8)).toEqual([]);
  });

  it('stops the session duration at the last event once idle', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(sessionDurationText('2026-11-15T10:56:00Z', '2026-11-15T11:59:30Z', now)).toBe('1h 4m');
    // A week-old session reads as its own length, not "172h".
    expect(sessionDurationText('2026-11-08T10:00:00Z', '2026-11-08T10:42:00Z', now)).toBe('42m');
    expect(sessionDurationText(null, null, now)).toBe('0m');
  });

  it('stops the clock when the pill turns Viewing, in both the dashboard and the Summary', () => {
    expect(SESSION_IDLE_AFTER_MS).toBe(SESSION_LIVE_WINDOW_MS);
    expect(SUMMARY_IDLE_AFTER_MS).toBe(SESSION_LIVE_WINDOW_MS);
    // Idle 1:59 still counts to now; 2:01 stops at the last event.
    const last = Date.parse('2026-11-15T11:00:00Z');
    const start = '2026-11-15T10:00:00Z';
    expect(sessionDurationText(start, new Date(last).toISOString(), last + 119_000)).toBe('1h 1m');
    expect(sessionDurationText(start, new Date(last).toISOString(), last + 121_000)).toBe('1h 0m');
  });
});
