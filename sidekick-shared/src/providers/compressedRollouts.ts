/**
 * Reads Codex rollouts that Codex compressed.
 *
 * Codex compresses older rollouts in place to `rollout-<ts>-<id>.jsonl.zst`
 * (one Zstandard frame), while its state database keeps the `.jsonl` path.
 * Node ships `zlib.zstdDecompressSync` from 22.15 / 23.8; on older runtimes
 * (Node 20, older VS Code Electron builds) compressed rollouts cannot be read
 * and are skipped, reported once as a `read_failed` diagnostic.
 *
 * Every reader here takes either form: a `.jsonl` path reads as before, a
 * `.jsonl.zst` path is decompressed. Compressed rollouts are complete (Codex
 * only compresses rollouts it no longer writes), so they are read whole and
 * never tailed.
 *
 * Node-only: reads files.
 *
 * @module providers/compressedRollouts
 */

import * as fs from 'fs';
import * as zlib from 'zlib';
import type { SessionProviderDiagnostic } from './types';

/** File-name suffix of a compressed rollout. */
export const COMPRESSED_ROLLOUT_SUFFIX = '.jsonl.zst';

type ZstdDecompressSync = (input: Buffer) => Buffer;

/** `undefined`: use the runtime's; `null`: behave as if the runtime lacked it. */
let decompressOverride: ZstdDecompressSync | null | undefined;

function zstdDecompressSync(): ZstdDecompressSync | null {
  if (decompressOverride !== undefined) return decompressOverride;
  const fn = (zlib as unknown as { zstdDecompressSync?: ZstdDecompressSync }).zstdDecompressSync;
  return typeof fn === 'function' ? fn.bind(zlib) : null;
}

/** Test hooks; not part of the public entry points. */
export const __compressedRolloutTesting = {
  /** Replace the runtime's `zstdDecompressSync` (`null` = unavailable, `undefined` = restore). */
  setDecompress(fn: ZstdDecompressSync | null | undefined): void {
    decompressOverride = fn;
  },
};

/** Whether a path (or file name) names a compressed rollout (`*.jsonl.zst`). */
export function isCompressedRolloutPath(filePath: string): boolean {
  return filePath.endsWith(COMPRESSED_ROLLOUT_SUFFIX);
}

/** Whether this runtime can decompress Zstandard (`zlib.zstdDecompressSync`). */
export function isZstdDecompressionAvailable(): boolean {
  return zstdDecompressSync() !== null;
}

export interface ReadRolloutOptions {
  /**
   * Receives a content-safe `read_failed` diagnostic when a compressed
   * rollout cannot be read (no Zstandard support, or a corrupt frame).
   */
  onDiagnostic?: (diagnostic: SessionProviderDiagnostic) => void;
}

const UNAVAILABLE_MESSAGE =
  'Compressed Codex rollouts (.jsonl.zst) were skipped: this Node.js runtime has no zlib.zstdDecompressSync (Node 22.15 or later).';

/** The runtime-limit diagnostic is reported once per process unless asked again. */
let reportedUnavailable = false;

function reportUnavailable(options: ReadRolloutOptions | undefined): void {
  if (!options?.onDiagnostic || reportedUnavailable) return;
  reportedUnavailable = true;
  options.onDiagnostic({
    providerId: 'codex',
    kind: 'read_failed',
    severity: 'info',
    phase: 'read',
    message: UNAVAILABLE_MESSAGE,
  });
}

function reportCorrupt(options: ReadRolloutOptions | undefined, error: unknown): void {
  options?.onDiagnostic?.({
    providerId: 'codex',
    kind: 'read_failed',
    severity: 'warning',
    phase: 'read',
    message: `A compressed Codex rollout could not be decompressed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  });
}

/**
 * Whether compressed rollouts can be read here; when they cannot, reports
 * the runtime limit through `onDiagnostic` (once per process). Callers that
 * list rollouts use it to leave `.jsonl.zst` files out instead of listing
 * sessions they cannot read.
 */
export function canReadCompressedRollouts(options?: ReadRolloutOptions): boolean {
  if (zstdDecompressSync()) return true;
  reportUnavailable(options);
  return false;
}

/** @internal Test hook: report the runtime limit again. */
export function resetCompressedRolloutDiagnostics(): void {
  reportedUnavailable = false;
}

function decompress(input: Buffer, options: ReadRolloutOptions | undefined): Buffer | null {
  const fn = zstdDecompressSync();
  if (!fn) {
    reportUnavailable(options);
    return null;
  }
  try {
    return fn(input);
  } catch (error) {
    reportCorrupt(options, error);
    return null;
  }
}

/**
 * The whole content of a rollout: a `.jsonl` file as stored, a `.jsonl.zst`
 * file decompressed. `null` when the file cannot be read or decompressed
 * (the latter reported through `onDiagnostic`).
 */
export function readRolloutBuffer(filePath: string, options?: ReadRolloutOptions): Buffer | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  return isCompressedRolloutPath(filePath) ? decompress(raw, options) : raw;
}

/** {@link readRolloutBuffer} decoded as UTF-8. */
export function readRolloutText(filePath: string, options?: ReadRolloutOptions): string | null {
  return readRolloutBuffer(filePath, options)?.toString('utf8') ?? null;
}

/** Async twin of {@link readRolloutBuffer}; decompression itself is synchronous. */
export async function readRolloutBufferAsync(
  filePath: string,
  options?: ReadRolloutOptions,
): Promise<Buffer | null> {
  let raw: Buffer;
  try {
    raw = await fs.promises.readFile(filePath);
  } catch {
    return null;
  }
  return isCompressedRolloutPath(filePath) ? decompress(raw, options) : raw;
}

/** Compressed bytes read per step while looking for a decompressed prefix. */
const HEAD_STEP_BYTES = 64 * 1024;

/**
 * Decompresses only as much of a compressed prefix as is needed for
 * `maxBytes` of content: a truncated Zstandard frame decompresses to the
 * content of its complete blocks.
 */
function decompressHead(
  readCompressed: (length: number) => Buffer,
  compressedSize: number,
  maxBytes: number,
  options: ReadRolloutOptions | undefined,
): Buffer | null {
  const fn = zstdDecompressSync();
  if (!fn) {
    reportUnavailable(options);
    return null;
  }
  let length = Math.min(compressedSize, HEAD_STEP_BYTES);
  for (;;) {
    let out: Buffer;
    try {
      out = fn(readCompressed(length));
    } catch (error) {
      if (length >= compressedSize) {
        reportCorrupt(options, error);
        return null;
      }
      out = Buffer.alloc(0);
    }
    if (out.length >= maxBytes || length >= compressedSize) return out.subarray(0, maxBytes);
    length = Math.min(compressedSize, length * 4);
  }
}

/**
 * Up to `maxBytes` of a rollout's content from its start (decompressed for
 * a `.jsonl.zst`). An empty buffer when the file cannot be read.
 */
export function readRolloutHead(
  filePath: string,
  maxBytes: number,
  options?: ReadRolloutOptions,
): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = fs.fstatSync(fd).size;
    const readPrefix = (length: number): Buffer => {
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    };
    if (!isCompressedRolloutPath(filePath))
      return readPrefix(Math.min(size, Math.max(0, maxBytes)));
    return decompressHead(readPrefix, size, Math.max(0, maxBytes), options) ?? Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  } finally {
    fs.closeSync(fd);
  }
}

/** Async twin of {@link readRolloutHead}. */
export async function readRolloutHeadAsync(
  filePath: string,
  maxBytes: number,
  options?: ReadRolloutOptions,
): Promise<Buffer> {
  if (!isCompressedRolloutPath(filePath)) {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const size = (await handle.stat()).size;
      const length = Math.min(size, Math.max(0, maxBytes));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } catch {
      return Buffer.alloc(0);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  // Compressed prefixes are small; one synchronous read keeps it simple.
  return readRolloutHead(filePath, maxBytes, options);
}

/**
 * The first `maxLines` complete lines of a rollout (decompressed for a
 * `.jsonl.zst`) within `maxBytes` of content; a trailing line without a
 * newline counts when the whole content fit.
 */
export function readRolloutFirstLines(
  filePath: string,
  maxLines: number,
  maxBytes = 256 * 1024,
  options?: ReadRolloutOptions,
): string[] {
  const head = readRolloutHead(filePath, maxBytes + 1, options);
  const complete = head.length <= maxBytes;
  const text = head.subarray(0, maxBytes).toString('utf8');
  const parts = text.split('\n');
  const tail = parts.pop() ?? '';
  const lines = parts.slice(0, maxLines);
  if (lines.length < maxLines && complete && tail.trim()) lines.push(tail);
  return lines;
}

/**
 * The content size a Zstandard frame header declares (`Frame_Content_Size`),
 * or `null` when the header omits it or is not a Zstandard frame. Skippable
 * frames before it are not followed.
 */
export function zstdFrameContentSize(header: Buffer): number | null {
  if (header.length < 5 || header.readUInt32LE(0) !== 0xfd2fb528) return null;
  const descriptor = header[4];
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const dictionaryIdFlag = descriptor & 3;
  const offset = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][dictionaryIdFlag];
  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  if (fcsBytes === 0 || header.length < offset + fcsBytes) return null;
  switch (fcsBytes) {
    case 1:
      return header[offset];
    case 2:
      return header.readUInt16LE(offset) + 256;
    case 4:
      return header.readUInt32LE(offset);
    default: {
      const value = header.readBigUInt64LE(offset);
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    }
  }
}

/** Size and mtime of a rollout's content (a compressed rollout: decompressed size). */
export interface RolloutContentStat {
  size: number;
  mtimeMs: number;
}

/**
 * Stat of a rollout's content: the file's own for a `.jsonl`; for a
 * `.jsonl.zst`, the decompressed size (from the frame header, else by
 * decompressing) with the compressed file's mtime. Rejects like `fs.stat`
 * when the file is missing; a compressed rollout that cannot be read
 * rejects too.
 */
export async function statRolloutContent(
  filePath: string,
  options?: ReadRolloutOptions,
): Promise<RolloutContentStat> {
  const stat = await fs.promises.stat(filePath);
  if (!isCompressedRolloutPath(filePath)) return { size: stat.size, mtimeMs: stat.mtimeMs };
  let declared: number | null = null;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const header = Buffer.alloc(18);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    declared = zstdFrameContentSize(header.subarray(0, bytesRead));
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (declared !== null && isZstdDecompressionAvailable()) {
    return { size: declared, mtimeMs: stat.mtimeMs };
  }
  const content = await readRolloutBufferAsync(filePath, options);
  if (!content) throw new Error('compressed rollout could not be read');
  return { size: content.length, mtimeMs: stat.mtimeMs };
}

/** The read and close calls of a file handle that the rollout scanners use. */
export interface RolloutReadHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** A read-only handle over a buffer, for scanning decompressed content. */
function bufferHandle(content: Buffer): RolloutReadHandle {
  return {
    async read(buffer, offset, length, position) {
      if (position >= content.length || length <= 0) return { bytesRead: 0 };
      const bytesRead = content.copy(
        buffer,
        offset,
        position,
        Math.min(content.length, position + length),
      );
      return { bytesRead };
    },
    async close() {},
  };
}

/**
 * Opens a rollout for positional reads over its content: a file handle for
 * a `.jsonl`, the decompressed content for a `.jsonl.zst` (with `size`, the
 * content length). Rejects when the file cannot be opened or decompressed.
 */
export async function openRolloutReadHandle(
  filePath: string,
  options?: ReadRolloutOptions,
): Promise<{ handle: RolloutReadHandle; size: number | null }> {
  if (!isCompressedRolloutPath(filePath)) {
    return { handle: await fs.promises.open(filePath, 'r'), size: null };
  }
  const content = await readRolloutBufferAsync(filePath, options);
  if (!content) throw new Error('compressed rollout could not be read');
  return { handle: bufferHandle(content), size: content.length };
}

/**
 * The path of a rollout as stored now: `filePath` when it exists, else its
 * compressed sibling (`<filePath>.zst`) when `includeCompressed` is set and
 * that exists. `null` when neither does.
 */
export function resolveRolloutPath(
  filePath: string,
  options: { includeCompressed?: boolean } = {},
): string | null {
  if (!filePath) return null;
  if (fs.existsSync(filePath)) return filePath;
  if (options.includeCompressed && !isCompressedRolloutPath(filePath)) {
    const compressed = `${filePath}.zst`;
    if (filePath.endsWith('.jsonl') && fs.existsSync(compressed)) return compressed;
  }
  return null;
}
