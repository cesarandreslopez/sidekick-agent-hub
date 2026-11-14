/**
 * Reads a session through a {@link SessionReader} in bounded steps, yielding
 * to the event loop between them, so an async collector never blocks for a
 * whole file. Readers without `readNewBounded` are read with one
 * `readNew()`.
 *
 * @module providers/readerDrain
 * @internal
 */

import type { SessionEvent } from '../types/sessionEvent';
import { DEFAULT_READ_CHUNK_BYTES, isBoundedReader } from './boundedReader';
import type { SessionReader, SessionReaderReset } from './types';

export interface DrainReaderOptions {
  /** Bytes per step (default 1 MiB). */
  chunkBytes?: number;
  /** Start from offset 0 (`reset()` first), as `readAll()` does. */
  fromStart?: boolean;
  /**
   * End with the reader's final flush, counting a trailing line with no
   * newline the way `readAll()` + `flush()` do; its events join the last
   * batch.
   */
  flush?: boolean;
  /** Checked between steps; an abort rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Checked between steps; true stops the drain (`done: false`). */
  shouldStop?: () => boolean;
  /** A step restarted from offset 0: drop what earlier batches built. */
  onReset?: (reset: SessionReaderReset | null) => void;
  /** Each step's events, in order. */
  onEvents: (events: SessionEvent[]) => void;
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drains `reader` to the end of the file as it was when the drain began.
 * Yields between steps, never before the first or after the last, so a
 * file read in one step completes without a macrotask turn. Resolves
 * `{ done: false }` when `shouldStop` ended it early.
 */
export async function drainReader(
  reader: SessionReader,
  options: DrainReaderOptions,
): Promise<{ done: boolean }> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
  if (options.fromStart) reader.reset();
  if (!isBoundedReader(reader)) {
    options.signal?.throwIfAborted();
    const events = reader.readNew();
    if (options.flush) reader.flush();
    if (reader.wasTruncated()) options.onReset?.(reader.lastReset?.() ?? null);
    options.onEvents(events);
    return { done: true };
  }
  await reader.prepareBoundedRead?.();
  for (;;) {
    options.signal?.throwIfAborted();
    const step = reader.readNewBounded(chunkBytes);
    if (reader.wasTruncated()) options.onReset?.(reader.lastReset?.() ?? null);
    if (step.done) {
      const events = options.flush ? [...step.events, ...reader.finishBounded()] : step.events;
      options.onEvents(events);
      return { done: true };
    }
    options.onEvents(step.events);
    await yieldToEventLoop();
    options.signal?.throwIfAborted();
    if (options.shouldStop?.()) return { done: false };
  }
}
