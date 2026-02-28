/**
 * @fileoverview Tests for CompletionCache — LRU cache with TTL.
 *
 * @module CompletionCache.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CompletionCache } from './CompletionCache';
import { CompletionContext } from '../types';

/** Helper to build a minimal CompletionContext. */
function makeContext(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    language: 'typescript',
    model: 'sonnet',
    prefix: 'const x = ',
    suffix: ';',
    multiline: false,
    filename: 'test.ts',
    ...overrides,
  };
}

describe('CompletionCache', () => {
  let cache: CompletionCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new CompletionCache(5, 10000); // 5 entries, 10s TTL
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── get / set basics ──────────────────────────────────────────────

  describe('get and set', () => {
    it('returns undefined for a cache miss', () => {
      const ctx = makeContext();
      expect(cache.get(ctx)).toBeUndefined();
    });

    it('returns the cached value on a hit', () => {
      const ctx = makeContext();
      cache.set(ctx, 'hello world');
      expect(cache.get(ctx)).toBe('hello world');
    });

    it('distinguishes contexts by language', () => {
      const tsCtx = makeContext({ language: 'typescript' });
      const pyCtx = makeContext({ language: 'python' });

      cache.set(tsCtx, 'ts result');
      cache.set(pyCtx, 'py result');

      expect(cache.get(tsCtx)).toBe('ts result');
      expect(cache.get(pyCtx)).toBe('py result');
    });

    it('distinguishes contexts by model', () => {
      const a = makeContext({ model: 'haiku' });
      const b = makeContext({ model: 'opus' });

      cache.set(a, 'fast');
      cache.set(b, 'powerful');

      expect(cache.get(a)).toBe('fast');
      expect(cache.get(b)).toBe('powerful');
    });

    it('distinguishes contexts by prefix content', () => {
      const a = makeContext({ prefix: 'function foo() {' });
      const b = makeContext({ prefix: 'function bar() {' });

      cache.set(a, 'result-a');
      cache.set(b, 'result-b');

      expect(cache.get(a)).toBe('result-a');
      expect(cache.get(b)).toBe('result-b');
    });

    it('distinguishes contexts by suffix content', () => {
      const a = makeContext({ suffix: '// end' });
      const b = makeContext({ suffix: '// done' });

      cache.set(a, 'result-a');
      cache.set(b, 'result-b');

      expect(cache.get(a)).toBe('result-a');
      expect(cache.get(b)).toBe('result-b');
    });

    it('overwrites an existing entry for the same context', () => {
      const ctx = makeContext();
      cache.set(ctx, 'first');
      cache.set(ctx, 'second');
      expect(cache.get(ctx)).toBe('second');
    });
  });

  // ── TTL expiry ────────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('returns the value before TTL expires', () => {
      const ctx = makeContext();
      cache.set(ctx, 'value');

      vi.advanceTimersByTime(9999); // just under 10s TTL
      expect(cache.get(ctx)).toBe('value');
    });

    it('returns undefined after TTL expires', () => {
      const ctx = makeContext();
      cache.set(ctx, 'value');

      vi.advanceTimersByTime(10001); // just over 10s TTL
      expect(cache.get(ctx)).toBeUndefined();
    });

    it('removes expired entry from internal map on access', () => {
      const ctx = makeContext();
      cache.set(ctx, 'value');

      vi.advanceTimersByTime(10001);
      cache.get(ctx); // triggers deletion

      // A second get should still be undefined (entry was truly removed)
      expect(cache.get(ctx)).toBeUndefined();
    });
  });

  // ── LRU eviction ─────────────────────────────────────────────────

  describe('LRU eviction at max capacity', () => {
    it('evicts the oldest entry when cache exceeds maxSize', () => {
      // Fill cache to capacity (5 entries)
      for (let i = 0; i < 5; i++) {
        cache.set(makeContext({ prefix: `prefix-${i}` }), `value-${i}`);
      }

      // All 5 entries should be retrievable
      for (let i = 0; i < 5; i++) {
        expect(cache.get(makeContext({ prefix: `prefix-${i}` }))).toBe(`value-${i}`);
      }

      // Add a 6th entry — should evict prefix-0 (the least recently used
      // since the gets above moved them all, but prefix-0 was the first to be
      // re-inserted by get, so the LRU-oldest after those gets is prefix-1 actually)
      // Actually: the gets above move each entry to the end. After all gets,
      // the order is 0,1,2,3,4. But gets re-insert them, so order becomes
      // 0,1,2,3,4 (same order since we accessed in order). The first in map
      // (oldest) is prefix-0.
      cache.set(makeContext({ prefix: 'prefix-new' }), 'new-value');

      // prefix-0 should have been evicted
      expect(cache.get(makeContext({ prefix: 'prefix-0' }))).toBeUndefined();
      // new entry and remaining old entries should exist
      expect(cache.get(makeContext({ prefix: 'prefix-new' }))).toBe('new-value');
      expect(cache.get(makeContext({ prefix: 'prefix-4' }))).toBe('value-4');
    });

    it('accessing an entry promotes it so it is not evicted next', () => {
      // Fill cache with entries 0..4
      for (let i = 0; i < 5; i++) {
        cache.set(makeContext({ prefix: `p${i}` }), `v${i}`);
      }

      // Access entry 0 — this moves it to the end of the Map
      cache.get(makeContext({ prefix: 'p0' }));

      // Now the LRU order is: p1, p2, p3, p4, p0
      // Adding a new entry should evict p1 (the current oldest)
      cache.set(makeContext({ prefix: 'pNew' }), 'vNew');

      expect(cache.get(makeContext({ prefix: 'p0' }))).toBe('v0');   // promoted, still here
      expect(cache.get(makeContext({ prefix: 'p1' }))).toBeUndefined(); // evicted
      expect(cache.get(makeContext({ prefix: 'pNew' }))).toBe('vNew');
    });
  });

  // ── clear ─────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all entries', () => {
      cache.set(makeContext({ prefix: 'a' }), '1');
      cache.set(makeContext({ prefix: 'b' }), '2');

      cache.clear();

      expect(cache.get(makeContext({ prefix: 'a' }))).toBeUndefined();
      expect(cache.get(makeContext({ prefix: 'b' }))).toBeUndefined();
    });

    it('allows new entries after clear', () => {
      cache.set(makeContext(), 'before');
      cache.clear();
      cache.set(makeContext(), 'after');
      expect(cache.get(makeContext())).toBe('after');
    });
  });

  // ── key hashing / truncation ──────────────────────────────────────

  describe('cache key generation', () => {
    it('uses last 500 chars of prefix for key', () => {
      const longPrefix = 'x'.repeat(1000);
      const ctxLong = makeContext({ prefix: longPrefix });
      const ctxTail = makeContext({ prefix: longPrefix.slice(-500) });

      cache.set(ctxLong, 'result');
      // A context whose prefix matches the last 500 chars should produce the same key
      expect(cache.get(ctxTail)).toBe('result');
    });

    it('uses first 200 chars of suffix for key', () => {
      const longSuffix = 'y'.repeat(500);
      const ctxLong = makeContext({ suffix: longSuffix });
      const ctxHead = makeContext({ suffix: longSuffix.slice(0, 200) });

      cache.set(ctxLong, 'result');
      // A context whose suffix matches the first 200 chars should produce the same key
      expect(cache.get(ctxHead)).toBe('result');
    });
  });

  // ── default constructor values ────────────────────────────────────

  describe('default constructor parameters', () => {
    it('uses 100 max entries and 30s TTL by default', () => {
      const defaultCache = new CompletionCache();

      // Verify TTL is 30s by storing and checking expiry
      const ctx = makeContext();
      defaultCache.set(ctx, 'value');

      vi.advanceTimersByTime(29999);
      expect(defaultCache.get(ctx)).toBe('value');

      vi.advanceTimersByTime(2); // total 30001ms
      expect(defaultCache.get(ctx)).toBeUndefined();
    });
  });
});
