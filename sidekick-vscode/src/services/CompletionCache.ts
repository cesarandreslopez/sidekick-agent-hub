/**
 * @fileoverview LRU cache with TTL for completion results.
 *
 * Provides caching for completion responses to avoid redundant API calls
 * when the same context is requested multiple times.
 *
 * @module CompletionCache
 */

import { CompletionContext } from '../types';

/**
 * Internal cache entry structure.
 */
interface CacheEntry {
  /** The cached completion text */
  completion: string;
  /** Timestamp when the entry was created (ms since epoch) */
  timestamp: number;
}

/**
 * LRU cache with TTL expiration for completion results.
 *
 * Uses native Map which preserves insertion order, enabling O(1) LRU eviction.
 * Cache keys are generated from the completion context (language, model,
 * prefix tail, suffix head).
 *
 * @example
 * ```typescript
 * const cache = new CompletionCache(100, 30000); // 100 entries, 30s TTL
 *
 * const context: CompletionContext = { ... };
 * cache.set(context, 'completion text');
 *
 * const cached = cache.get(context); // Returns 'completion text' if not expired
 * ```
 */
export class CompletionCache {
  /** The underlying Map storing cache entries */
  private cache = new Map<string, CacheEntry>();

  /** Maximum number of entries to store */
  private readonly maxSize: number;

  /** Time-to-live in milliseconds */
  private readonly ttlMs: number;

  /**
   * Creates a new CompletionCache.
   *
   * @param maxSize - Maximum number of entries to store (default: 100)
   * @param ttlMs - Time-to-live in milliseconds (default: 30000)
   */
  constructor(maxSize = 100, ttlMs = 30000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Generates a cache key from the completion context.
   *
   * Uses the last 500 characters of prefix and first 200 characters of suffix
   * to create a unique but bounded key.
   *
   * @param context - The completion context
   * @returns Cache key string
   */
  private hashKey(context: CompletionContext): string {
    // Use last 500 chars of prefix and first 200 of suffix
    const prefixTail = context.prefix.slice(-500);
    const suffixHead = context.suffix.slice(0, 200);
    return `${context.language}:${context.model}:${context.multiline ? 'm' : 's'}:${prefixTail}:${suffixHead}`;
  }

  /**
   * Retrieves a cached completion if it exists and is not expired.
   *
   * If found, the entry is moved to the end of the Map to mark it as
   * most recently used.
   *
   * @param context - The completion context to look up
   * @returns The cached completion string, or undefined if not found/expired
   */
  get(context: CompletionContext): string | undefined {
    const key = this.hashKey(context);
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.completion;
  }

  /**
   * Stores a completion in the cache.
   *
   * If the cache is at capacity, the oldest entry (first in Map) is evicted.
   *
   * @param context - The completion context
   * @param completion - The completion text to cache
   */
  set(context: CompletionContext, completion: string): void {
    const key = this.hashKey(context);

    // Evict oldest if at capacity (first entry in Map)
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      completion,
      timestamp: Date.now(),
    });
  }

  /**
   * Clears all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}
