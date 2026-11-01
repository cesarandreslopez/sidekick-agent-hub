/**
 * Continuity of a file read incrementally by byte offset: whether the file
 * now at a path is still the content earlier reads consumed, or was
 * truncated, rewritten, or replaced since.
 *
 * {@link FileContinuity} holds the rules `createJsonlTail` applies, so every
 * incremental reader detects the same cases the same way:
 *
 * - `replaced`: another file (by device and inode, read from the open
 *   descriptor, so a rename between a stat and an open cannot mix two files)
 *   now has the path.
 * - `truncated`: the file is shorter than the read position.
 * - `rewritten`: the mtime changed and either the first {@link HEAD_BYTES}
 *   bytes differ from those recorded, or the byte before the committed
 *   (resume-safe) offset is no longer a newline.
 *
 * Replacement and truncation are checked on every read; the content probe
 * only when the mtime changed or the recorded head is still short.
 *
 * Known limits: a rewrite that leaves the mtime unchanged (coarse mtime
 * resolution, or an mtime restored on purpose) or that changes only bytes
 * past the first 4 KiB while the resume point still follows a newline goes
 * unnoticed; on filesystems without stable inode numbers (some SMB mounts,
 * Windows) an unchanged file can read as replaced, which costs a replay.
 *
 * @module fileContinuity
 */

import * as fs from 'fs';
import { fileHeadOf, HEAD_BYTES, headMatches, type FileHead } from './fileHead';
import type { JsonlTailResetReason } from './watchers/jsonlTail';

/** The fields of `fs.Stats` the continuity rules read. */
export type FileContinuityStat = Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>;

/** The bytes the continuity check needs, read before any state changes. */
export interface FileContinuityProbe {
  /** The file's first `min(HEAD_BYTES, size)` bytes. */
  prefix: Buffer;
  /** The byte before the committed offset, when there is one. */
  before: Buffer | null;
}

/**
 * What one reader knows about the file its offsets refer to: identity,
 * mtime, and a digest of the first bytes, recorded by {@link adopt} after
 * each read.
 *
 * Synchronous readers call {@link check} on the open descriptor, restart
 * from offset 0 when it returns a reason, then call {@link adopt}. A reader
 * that repositions without reading (a seek to a stored offset, a reset)
 * calls {@link forget}, so its next read adopts the file instead of
 * comparing it with the old one. The lower-level methods ({@link needsProbe},
 * {@link reasonFor}, {@link record}) serve asynchronous readers that probe
 * on their own.
 */
export class FileContinuity {
  private identity: { dev: number; ino: number } | null = null;
  private head: FileHead | null = null;
  private lastMtimeMs = -1;
  /** What the last {@link check} probed and decided, for {@link adopt}. */
  private checked: { probe: FileContinuityProbe | null; reset: boolean } | null = null;

  /** Device and inode of the adopted file; `null` before the first read and after {@link forget}. */
  get knownIdentity(): { dev: number; ino: number } | null {
    return this.identity;
  }

  /** Length and digest of the adopted file's first bytes, once probed. */
  get knownHead(): FileHead | null {
    return this.head;
  }

  /** Whether {@link reasonFor} needs bytes from the file to decide. */
  needsProbe(stat: FileContinuityStat, readOffset: number): boolean {
    return (
      this.identity === null ||
      stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino ||
      stat.size < readOffset ||
      stat.mtimeMs !== this.lastMtimeMs ||
      this.head === null ||
      this.head.bytes < Math.min(HEAD_BYTES, stat.size)
    );
  }

  /**
   * Why the reader must start over: the path now names another file, the
   * file shrank below `readOffset`, its first bytes changed, or the resume
   * point no longer follows a newline. `null` when it can continue.
   */
  reasonFor(
    stat: FileContinuityStat,
    readOffset: number,
    probe: FileContinuityProbe | null,
  ): JsonlTailResetReason | null {
    if (this.identity && (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)) {
      return 'replaced';
    }
    if (stat.size < readOffset) return 'truncated';
    if (this.identity && stat.mtimeMs !== this.lastMtimeMs && probe) {
      if (this.head && !headMatches(this.head, probe.prefix)) return 'rewritten';
      if (probe.before && probe.before[0] !== 0x0a) return 'rewritten';
    }
    return null;
  }

  /** Records the identity, mtime, and (from `probe`) first bytes of the file the offsets now refer to. */
  record(stat: FileContinuityStat, probe: FileContinuityProbe | null): void {
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.lastMtimeMs = stat.mtimeMs;
    if (probe && (!this.head || this.head.bytes < Math.min(HEAD_BYTES, stat.size))) {
      this.head = fileHeadOf(probe.prefix);
    }
  }

  /** Drops the recorded first bytes (the reader restarted); the next {@link record} with a probe sets them again. */
  discardHead(): void {
    this.head = null;
  }

  /** Records the file as known from `prefix`, its first `min(HEAD_BYTES, size)` bytes. */
  adoptPrefix(stat: FileContinuityStat, prefix: Buffer): void {
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.lastMtimeMs = stat.mtimeMs;
    this.head = fileHeadOf(prefix);
  }

  /** Forgets the file, so the next {@link check} adopts whatever file has the path. */
  forget(): void {
    this.identity = null;
    this.head = null;
    this.lastMtimeMs = -1;
    this.checked = null;
  }

  /**
   * Applies the rules to the file open on `fd` (`stat` from `fstat` on that
   * descriptor), reading the bytes they need. `readOffset` is how far the
   * reader has read; `committedOffset` (default `readOffset`) is its
   * resume-safe position just after a newline. Returns why the reader must
   * restart from offset 0, or `null`. Call {@link adopt} with the same
   * `stat` once the reader has acted on the answer.
   */
  check(
    fd: number,
    stat: FileContinuityStat,
    readOffset: number,
    committedOffset: number = readOffset,
  ): JsonlTailResetReason | null {
    const probe = this.needsProbe(stat, readOffset)
      ? probeFileContinuity(fd, stat, committedOffset)
      : null;
    const reason = this.reasonFor(stat, readOffset, probe);
    this.checked = { probe, reset: reason !== null };
    return reason;
  }

  /** Records the file just checked as the one the reader's offsets now refer to. */
  adopt(stat: FileContinuityStat): void {
    const checked = this.checked;
    this.checked = null;
    if (checked?.reset) this.head = null;
    this.record(stat, checked?.probe ?? null);
  }
}

/** Reads the bytes {@link FileContinuity.reasonFor} compares, from the file open on `fd`. */
export function probeFileContinuity(
  fd: number,
  stat: FileContinuityStat,
  committedOffset: number,
): FileContinuityProbe {
  return {
    prefix: readAt(fd, 0, Math.min(HEAD_BYTES, stat.size)),
    before:
      committedOffset > 0 && committedOffset <= stat.size
        ? readAt(fd, committedOffset - 1, 1)
        : null,
  };
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const count = length > 0 ? fs.readSync(fd, buffer, 0, length, position) : 0;
  return buffer.subarray(0, count);
}
