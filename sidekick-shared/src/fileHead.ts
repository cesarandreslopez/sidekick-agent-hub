/**
 * Rewrite detection shared by the incremental JSONL readers: a file whose
 * first bytes changed, or whose resume point no longer follows a newline,
 * was rewritten rather than appended to.
 *
 * @module fileHead
 */

import { createHash } from 'crypto';

/** How many leading bytes identify a file's content. */
export const HEAD_BYTES = 4096;

/** The recorded prefix of a file: its length and a hash of it. */
export interface FileHead {
  bytes: number;
  hash: string;
}

export function hashHead(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

/** Records the prefix just read (at most `HEAD_BYTES`). */
export function fileHeadOf(prefix: Buffer): FileHead {
  return { bytes: prefix.length, hash: hashHead(prefix) };
}

/**
 * True when `prefix` (the file's current first bytes) still starts with the
 * recorded head. A file that grew past a short head still matches.
 */
export function headMatches(known: FileHead, prefix: Buffer): boolean {
  if (!Number.isInteger(known.bytes) || known.bytes < 0 || known.bytes > prefix.length) {
    return false;
  }
  return hashHead(prefix.subarray(0, known.bytes)) === known.hash;
}
