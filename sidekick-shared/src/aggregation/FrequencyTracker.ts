/**
 * Generic frequency counter with LRU eviction.
 *
 * Tracks word/key frequencies with count, firstSeen, lastSeen metadata.
 * Used for tool name frequency, event type frequency, and summary word frequency.
 *
 * @module aggregation/FrequencyTracker
 */

const DEFAULT_MAX_ENTRIES = 10_000;

export interface FrequencyEntry {
  key: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface SerializedFrequencyState {
  entries: Array<[string, { count: number; firstSeen: string; lastSeen: string }]>;
}

export class FrequencyTracker {
  private entries = new Map<string, { count: number; firstSeen: string; lastSeen: string }>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** Increment frequency for a key. */
  increment(key: string, timestamp?: string): void {
    const ts = timestamp ?? new Date().toISOString();
    const existing = this.entries.get(key);
    if (existing) {
      existing.count++;
      existing.lastSeen = ts;
      // Move to end for LRU ordering (Map preserves insertion order)
      this.entries.delete(key);
      this.entries.set(key, existing);
    } else {
      // Evict oldest if at capacity
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) {
          this.entries.delete(oldest);
        }
      }
      this.entries.set(key, { count: 1, firstSeen: ts, lastSeen: ts });
    }
  }

  /** Get the top N entries by count. */
  getTopN(n: number): FrequencyEntry[] {
    const sorted = Array.from(this.entries.entries())
      .map(([key, data]) => ({ key, ...data }))
      .sort((a, b) => b.count - a.count);
    return sorted.slice(0, n);
  }

  /** Get all entries sorted by count descending. */
  getAll(): FrequencyEntry[] {
    return this.getTopN(this.entries.size);
  }

  /** Get count for a specific key. */
  getCount(key: string): number {
    return this.entries.get(key)?.count ?? 0;
  }

  /** Get total number of tracked keys. */
  get size(): number {
    return this.entries.size;
  }

  /** Reset all tracked frequencies. */
  reset(): void {
    this.entries.clear();
  }

  /** Serialize for snapshot persistence. */
  serialize(): SerializedFrequencyState {
    return { entries: Array.from(this.entries.entries()) };
  }

  /** Restore from serialized state. */
  restore(state: SerializedFrequencyState): void {
    this.entries = new Map(state.entries);
  }
}
