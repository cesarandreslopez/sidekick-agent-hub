import { describe, it, expect, beforeEach } from 'vitest';
import { FrequencyTracker } from './FrequencyTracker';

describe('FrequencyTracker', () => {
  let tracker: FrequencyTracker;

  beforeEach(() => {
    tracker = new FrequencyTracker();
  });

  it('increments and tracks counts', () => {
    tracker.increment('Read', '2024-01-01T00:00:00Z');
    tracker.increment('Read', '2024-01-01T00:01:00Z');
    tracker.increment('Write', '2024-01-01T00:02:00Z');

    expect(tracker.getCount('Read')).toBe(2);
    expect(tracker.getCount('Write')).toBe(1);
    expect(tracker.getCount('Missing')).toBe(0);
  });

  it('returns top N entries sorted by count', () => {
    tracker.increment('a', '2024-01-01T00:00:00Z');
    tracker.increment('b', '2024-01-01T00:01:00Z');
    tracker.increment('b', '2024-01-01T00:02:00Z');
    tracker.increment('c', '2024-01-01T00:03:00Z');
    tracker.increment('c', '2024-01-01T00:04:00Z');
    tracker.increment('c', '2024-01-01T00:05:00Z');

    const top2 = tracker.getTopN(2);
    expect(top2).toHaveLength(2);
    expect(top2[0].key).toBe('c');
    expect(top2[0].count).toBe(3);
    expect(top2[1].key).toBe('b');
    expect(top2[1].count).toBe(2);
  });

  it('tracks firstSeen and lastSeen', () => {
    tracker.increment('key', '2024-01-01T00:00:00Z');
    tracker.increment('key', '2024-01-01T12:00:00Z');

    const entries = tracker.getTopN(1);
    expect(entries[0].firstSeen).toBe('2024-01-01T00:00:00Z');
    expect(entries[0].lastSeen).toBe('2024-01-01T12:00:00Z');
  });

  it('evicts oldest entries at capacity', () => {
    const small = new FrequencyTracker(3);
    small.increment('a', '2024-01-01T00:00:00Z');
    small.increment('b', '2024-01-01T00:01:00Z');
    small.increment('c', '2024-01-01T00:02:00Z');
    small.increment('d', '2024-01-01T00:03:00Z');

    expect(small.size).toBe(3);
    expect(small.getCount('a')).toBe(0); // evicted
    expect(small.getCount('d')).toBe(1);
  });

  it('resets all state', () => {
    tracker.increment('x');
    tracker.reset();
    expect(tracker.size).toBe(0);
  });

  it('serializes and restores', () => {
    tracker.increment('foo', '2024-01-01T00:00:00Z');
    tracker.increment('foo', '2024-01-01T00:01:00Z');
    tracker.increment('bar', '2024-01-01T00:02:00Z');

    const state = tracker.serialize();
    const restored = new FrequencyTracker();
    restored.restore(state);

    expect(restored.getCount('foo')).toBe(2);
    expect(restored.getCount('bar')).toBe(1);
  });
});
