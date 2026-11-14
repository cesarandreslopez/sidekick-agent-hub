/**
 * Internal contract of the built-in readers that read in bounded steps
 * (`SessionReader.readNewBounded`), beyond the public interface: what the
 * async collectors need to finish a drain, and to persist and resume one
 * across calls. Not exported from the package entry points.
 *
 * @module providers/boundedReader
 * @internal
 */

import type { FileContinuityState } from '../fileContinuity';
import type { SessionEvent } from '../types/sessionEvent';
import type { SessionReader } from './types';

/** Bytes per bounded read step in the async collectors. */
export const DEFAULT_READ_CHUNK_BYTES = 1024 * 1024;

/** Largest single `fs.readSync` a built-in reader issues. */
export const READ_SLICE_BYTES = 1024 * 1024;

export interface BoundedReaderInternals {
  /**
   * Work to do off the main thread before the first bounded step (a
   * compressed rollout is decompressed asynchronously here).
   */
  prepareBoundedRead?(): Promise<void>;
  /**
   * Ends a drain: the events of a trailing line with no newline, as
   * `readAll()` followed by `flush()` would have counted them.
   */
  finishBounded(): SessionEvent[];
  /**
   * The read file's continuity, to persist with `getPosition()` and
   * `getResumeState()`. Absent (or `null`) when the reader cannot resume
   * across calls.
   */
  continuityState?(): FileContinuityState | null;
  /** Restores {@link continuityState} after `seekTo()` and `restoreResumeState()`. */
  restoreContinuity?(state: unknown): boolean;
}

export type BoundedSessionReader = SessionReader &
  Required<Pick<SessionReader, 'readNewBounded'>> &
  BoundedReaderInternals;

/** Whether `reader` is a built-in reader that reads in bounded steps. */
export function isBoundedReader(reader: SessionReader): reader is BoundedSessionReader {
  return (
    typeof reader.readNewBounded === 'function' &&
    typeof (reader as Partial<BoundedReaderInternals>).finishBounded === 'function'
  );
}

/** Validates the `maxBytes` of a bounded read: a positive number (`Infinity` reads everything). */
export function boundedReadLimit(maxBytes: number): number {
  if (typeof maxBytes !== 'number' || Number.isNaN(maxBytes) || maxBytes <= 0) {
    throw new RangeError('readNewBounded: `maxBytes` must be a number > 0.');
  }
  return maxBytes === Number.POSITIVE_INFINITY ? maxBytes : Math.max(1, Math.floor(maxBytes));
}

export function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
