/**
 * Rolling heatmap tracker using a circular buffer of minute-buckets.
 *
 * Records event timestamps into minute-resolution buckets for activity
 * visualization. Older buckets age out as time advances.
 *
 * @module aggregation/HeatmapTracker
 */

const DEFAULT_BUCKET_COUNT = 60;

export interface HeatmapBucket {
  /** ISO timestamp of the minute this bucket represents. */
  timestamp: string;
  /** Number of events in this minute. */
  count: number;
}

export interface SerializedHeatmapState {
  buckets: Array<{ minuteKey: number; count: number }>;
  oldestMinuteKey: number;
}

/** Truncate a Date to minute resolution and return the minute-key (epoch minutes). */
function toMinuteKey(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

export class HeatmapTracker {
  private buckets = new Map<number, number>(); // minuteKey -> count
  private readonly bucketCount: number;

  constructor(bucketCount = DEFAULT_BUCKET_COUNT) {
    this.bucketCount = bucketCount;
  }

  /** Record an event at the given timestamp. */
  record(timestamp: string): void {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return;
    const minuteKey = toMinuteKey(date);
    this.buckets.set(minuteKey, (this.buckets.get(minuteKey) ?? 0) + 1);
    this.prune(minuteKey);
  }

  /** Get the rolling window of buckets, filled with zeros for empty minutes. */
  getBuckets(): HeatmapBucket[] {
    if (this.buckets.size === 0) return [];

    // Find the latest minute key
    let latestKey = 0;
    for (const key of this.buckets.keys()) {
      if (key > latestKey) latestKey = key;
    }

    const result: HeatmapBucket[] = [];
    const startKey = latestKey - this.bucketCount + 1;
    for (let key = startKey; key <= latestKey; key++) {
      result.push({
        timestamp: new Date(key * 60_000).toISOString(),
        count: this.buckets.get(key) ?? 0,
      });
    }
    return result;
  }

  /** Get the maximum count in any bucket (for intensity scaling). */
  getMaxCount(): number {
    let max = 0;
    for (const count of this.buckets.values()) {
      if (count > max) max = count;
    }
    return max;
  }

  /** Reset all tracked data. */
  reset(): void {
    this.buckets.clear();
  }

  /** Serialize for snapshot persistence. */
  serialize(): SerializedHeatmapState {
    let oldest = Infinity;
    const entries: Array<{ minuteKey: number; count: number }> = [];
    for (const [key, count] of this.buckets) {
      entries.push({ minuteKey: key, count });
      if (key < oldest) oldest = key;
    }
    return { buckets: entries, oldestMinuteKey: oldest === Infinity ? 0 : oldest };
  }

  /** Restore from serialized state. */
  restore(state: SerializedHeatmapState): void {
    this.buckets.clear();
    for (const { minuteKey, count } of state.buckets) {
      this.buckets.set(minuteKey, count);
    }
  }

  /** Prune buckets outside the rolling window. */
  private prune(latestKey: number): void {
    const cutoff = latestKey - this.bucketCount;
    for (const key of this.buckets.keys()) {
      if (key <= cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}
