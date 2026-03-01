import { describe, it, expect, beforeEach } from 'vitest';
import { HeatmapTracker } from './HeatmapTracker';

describe('HeatmapTracker', () => {
  let tracker: HeatmapTracker;

  beforeEach(() => {
    tracker = new HeatmapTracker(5); // 5-minute window for testing
  });

  it('records events into minute buckets', () => {
    tracker.record('2024-01-01T00:00:30Z');
    tracker.record('2024-01-01T00:00:45Z');
    tracker.record('2024-01-01T00:01:10Z');

    const buckets = tracker.getBuckets();
    expect(buckets).toHaveLength(5);
    // Last two buckets should have data
    const counts = buckets.map(b => b.count);
    expect(counts[counts.length - 1]).toBe(1); // 00:01
    expect(counts[counts.length - 2]).toBe(2); // 00:00
  });

  it('returns empty array when no events recorded', () => {
    expect(tracker.getBuckets()).toEqual([]);
  });

  it('fills empty minutes with zeros', () => {
    tracker.record('2024-01-01T00:00:00Z');
    tracker.record('2024-01-01T00:04:00Z');

    const buckets = tracker.getBuckets();
    expect(buckets).toHaveLength(5);
    // Bucket[0] = minute 00:00 (count 1), buckets 1-3 = gap (0), bucket[4] = minute 00:04 (count 1)
    expect(buckets[0].count).toBe(1);
    expect(buckets[1].count).toBe(0);
    expect(buckets[2].count).toBe(0);
    expect(buckets[3].count).toBe(0);
    expect(buckets[4].count).toBe(1);
  });

  it('prunes old buckets outside the window', () => {
    tracker.record('2024-01-01T00:00:00Z');
    tracker.record('2024-01-01T00:10:00Z'); // 10 minutes later

    const buckets = tracker.getBuckets();
    // The 00:00 bucket should have been pruned
    const nonZero = buckets.filter(b => b.count > 0);
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0].count).toBe(1);
  });

  it('tracks max count correctly', () => {
    tracker.record('2024-01-01T00:00:00Z');
    tracker.record('2024-01-01T00:00:30Z');
    tracker.record('2024-01-01T00:00:45Z');
    tracker.record('2024-01-01T00:01:00Z');

    expect(tracker.getMaxCount()).toBe(3);
  });

  it('ignores invalid timestamps', () => {
    tracker.record('not-a-date');
    expect(tracker.getBuckets()).toEqual([]);
  });

  it('serializes and restores', () => {
    tracker.record('2024-01-01T00:00:00Z');
    tracker.record('2024-01-01T00:00:30Z');
    tracker.record('2024-01-01T00:01:00Z');

    const state = tracker.serialize();
    const restored = new HeatmapTracker(5);
    restored.restore(state);

    expect(restored.getBuckets()).toEqual(tracker.getBuckets());
  });

  it('resets all state', () => {
    tracker.record('2024-01-01T00:00:00Z');
    tracker.reset();
    expect(tracker.getBuckets()).toEqual([]);
    expect(tracker.getMaxCount()).toBe(0);
  });
});
