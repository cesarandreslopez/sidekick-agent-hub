/**
 * Low-level JSONL tail reader for consumers that need raw parsed events plus
 * their own aggregation lifecycle.
 */

import * as fs from 'fs';
import type { ZodType } from 'zod';
import { fileHeadOf, HEAD_BYTES, headMatches, type FileHead } from '../fileHead';
import { JsonlParser } from '../parsers/jsonl';

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_CATCHUP_INTERVAL_MS = 30_000;
/** Default bytes read from the file per chunk. */
export const DEFAULT_JSONL_TAIL_READ_BYTES = 1024 * 1024;
/** Default longest line parsed; longer lines are skipped and reported. */
export const DEFAULT_JSONL_TAIL_MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Skip old complete events while retaining an in-progress final line. */
function lastCompleteLineOffset(filePath: string): number {
  const fd = fs.openSync(filePath, 'r');
  try {
    let end = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(64 * 1024);
    while (end > 0) {
      const start = Math.max(0, end - buffer.length);
      const count = fs.readSync(fd, buffer, 0, end - start, start);
      const newline = buffer.subarray(0, count).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

export interface JsonlTailBatch {
  bytesRead: number;
  eventsRead: number;
  offset: number;
}

/** Where an event's line sits in the file. */
export interface JsonlTailLine {
  /** Byte offset where the line starts. */
  offset: number;
  /** Line length in bytes, without the newline. */
  length: number;
}

export type JsonlTailResetReason = 'truncated' | 'rewritten' | 'replaced';

/** The tail started over from the beginning of the file. */
export interface JsonlTailReset {
  /** `truncated`: the file shrank; `rewritten`: its first bytes or the resume point changed; `replaced`: another file now has the path. */
  reason: JsonlTailResetReason;
  /** The committed offset before the reset. */
  previousOffset: number;
}

export interface JsonlTailOptions<T> {
  path: string;
  schema?: ZodType<T>;
  startOffset?: number;
  startAtEnd?: boolean;
  debounceMs?: number;
  catchupIntervalMs?: number;
  onEvent: (event: T, line: JsonlTailLine) => void;
  onBatchComplete?: (batch: JsonlTailBatch) => void;
  onError?: (error: Error, line?: string) => void;
  /** Called after the tail resets to offset 0; events from the start follow. */
  onReset?: (reset: JsonlTailReset) => void;
  /** Bytes read per chunk (default 1 MiB); one poll reads chunk by chunk to the end. */
  maxReadBytes?: number;
  /** Longest line parsed (default 16 MiB); a longer line is skipped and reported to `onError`. */
  maxLineBytes?: number;
}

export interface JsonlTail {
  readonly isActive: boolean;
  start(): void;
  stop(): void;
  dispose(): void;
  readNow(): void;
  getOffset(): number;
  seekTo(offset: number): void;
}

export function createJsonlTail<T>(options: JsonlTailOptions<T>): JsonlTail {
  return new JsonlTailReader(options);
}

class JsonlTailReader<T> implements JsonlTail {
  private active = false;
  /** Physical byte position already read from the file. */
  private readOffset: number;
  /** Resume-safe byte position ending immediately after a newline. */
  private committedOffset: number;
  private pendingBytes = Buffer.alloc(0);
  /** Inside a line over `maxLineBytes`: drop bytes until its newline. */
  private skippingLine = false;
  private currentLine: JsonlTailLine = { offset: 0, length: 0 };
  /** Identity and prefix of the file the offsets refer to, once read. */
  private identity: { dev: number; ino: number } | null = null;
  private head: FileHead | null = null;
  private lastMtimeMs = -1;
  private readonly maxReadBytes: number;
  private readonly maxLineBytes: number;
  private fsWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private catchupTimer: ReturnType<typeof setInterval> | null = null;
  private eventsInCurrentBatch = 0;
  private readonly parser: JsonlParser<T>;

  constructor(private readonly options: JsonlTailOptions<T>) {
    this.readOffset = options.startOffset ?? 0;
    this.committedOffset = this.readOffset;
    this.maxReadBytes = positiveInteger(options.maxReadBytes, DEFAULT_JSONL_TAIL_READ_BYTES);
    this.maxLineBytes = positiveInteger(options.maxLineBytes, DEFAULT_JSONL_TAIL_MAX_LINE_BYTES);
    this.parser = new JsonlParser<T>(
      {
        onEvent: (event) => {
          this.eventsInCurrentBatch += 1;
          this.options.onEvent(event, this.currentLine);
        },
        onError: (error, line) => this.options.onError?.(error, line),
      },
      { schema: options.schema },
    );
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;

    if (this.options.startAtEnd && this.options.startOffset === undefined) {
      try {
        this.readOffset = lastCompleteLineOffset(this.options.path);
      } catch {
        this.readOffset = 0;
      }
      this.committedOffset = this.readOffset;
    }

    this.readNow();
    this.watchFile();

    const catchupIntervalMs = this.options.catchupIntervalMs ?? DEFAULT_CATCHUP_INTERVAL_MS;
    if (catchupIntervalMs > 0) {
      this.catchupTimer = setInterval(() => this.readNow(), catchupIntervalMs);
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.catchupTimer) {
      clearInterval(this.catchupTimer);
      this.catchupTimer = null;
    }

    this.parser.flush();
  }

  dispose(): void {
    this.stop();
  }

  readNow(): void {
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.options.path, 'r');
      const stat = fs.fstatSync(fd);
      this.checkContinuity(fd, stat);
      if (stat.size <= this.readOffset) return;

      this.eventsInCurrentBatch = 0;
      let bytesRead = 0;
      const chunk = Buffer.alloc(Math.min(this.maxReadBytes, stat.size - this.readOffset));
      while (this.readOffset < stat.size) {
        const want = Math.min(chunk.length, stat.size - this.readOffset);
        const count = fs.readSync(fd, chunk, 0, want, this.readOffset);
        if (count <= 0) break;
        this.consume(chunk.subarray(0, count), this.readOffset);
        this.readOffset += count;
        bytesRead += count;
      }
      if (bytesRead <= 0) return;
      this.options.onBatchComplete?.({
        bytesRead,
        eventsRead: this.eventsInCurrentBatch,
        offset: this.committedOffset,
      });
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore close errors */
        }
      }
    }
  }

  /**
   * Starts over when the path now names another file, the file shrank, its
   * first bytes changed, or the resume point no longer follows a newline.
   */
  private checkContinuity(fd: number, stat: fs.Stats): void {
    let reason: JsonlTailResetReason | null = null;
    if (this.identity && (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)) {
      reason = 'replaced';
    } else if (stat.size < this.readOffset) {
      reason = 'truncated';
    }
    if (reason === null && this.identity && stat.mtimeMs !== this.lastMtimeMs) {
      const prefix = readAt(fd, 0, Math.min(HEAD_BYTES, stat.size));
      const before = this.committedOffset > 0 ? readAt(fd, this.committedOffset - 1, 1) : null;
      if ((this.head && !headMatches(this.head, prefix)) || (before && before[0] !== 0x0a)) {
        reason = 'rewritten';
      }
    }
    if (reason !== null) this.reset(reason);
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.lastMtimeMs = stat.mtimeMs;
    if (!this.head || this.head.bytes < Math.min(HEAD_BYTES, stat.size)) {
      this.head = fileHeadOf(readAt(fd, 0, Math.min(HEAD_BYTES, stat.size)));
    }
  }

  private reset(reason: JsonlTailResetReason): void {
    const previousOffset = this.committedOffset;
    this.readOffset = 0;
    this.committedOffset = 0;
    this.pendingBytes = Buffer.alloc(0);
    this.skippingLine = false;
    this.head = null;
    this.parser.reset();
    this.options.onReset?.({ reason, previousOffset });
  }

  /** Parses the complete lines in `bytes`, which start at file offset `position`. */
  private consume(bytes: Buffer, position: number): void {
    let start = 0;
    if (this.skippingLine) {
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      this.skippingLine = false;
      start = newline + 1;
      this.committedOffset = position + start;
    }
    let lineStart = this.committedOffset;
    let cursor = start;
    for (;;) {
      const newline = bytes.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const piece = bytes.subarray(cursor, newline);
      const line = this.pendingBytes.length > 0 ? Buffer.concat([this.pendingBytes, piece]) : piece;
      this.pendingBytes = Buffer.alloc(0);
      const lineEnd = position + newline + 1;
      if (line.length > this.maxLineBytes) {
        this.reportOversized(lineStart, line.length);
      } else {
        this.currentLine = { offset: lineStart, length: line.length };
        this.parser.processChunk(line.toString('utf8') + '\n');
      }
      this.committedOffset = lineEnd;
      lineStart = lineEnd;
      cursor = newline + 1;
    }
    const rest = bytes.subarray(cursor);
    if (rest.length === 0) return;
    if (this.pendingBytes.length + rest.length > this.maxLineBytes) {
      this.reportOversized(lineStart, this.pendingBytes.length + rest.length);
      this.pendingBytes = Buffer.alloc(0);
      this.skippingLine = true;
      return;
    }
    this.pendingBytes = Buffer.concat([this.pendingBytes, rest]);
  }

  private reportOversized(offset: number, atLeast: number): void {
    this.options.onError?.(
      new Error(
        `JSONL line at byte ${offset} is over ${this.maxLineBytes} bytes (${atLeast} so far); skipped.`,
      ),
    );
  }

  getOffset(): number {
    return this.committedOffset;
  }

  seekTo(offset: number): void {
    this.readOffset = Math.max(0, offset);
    this.committedOffset = this.readOffset;
    this.pendingBytes = Buffer.alloc(0);
    this.skippingLine = false;
    this.parser.reset();
  }

  private watchFile(): void {
    try {
      this.fsWatcher = fs.watch(this.options.path, { persistent: false }, () => {
        this.debouncedRead();
      });
      this.fsWatcher.on('error', (error) => {
        this.fsWatcher?.close();
        this.fsWatcher = null;
        this.options.onError?.(error);
      });
    } catch {
      // Polling still covers filesystems where fs.watch is unavailable.
    }
  }

  private debouncedRead(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const debounceMs = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.debounceTimer = setTimeout(() => this.readNow(), debounceMs);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const count = length > 0 ? fs.readSync(fd, buffer, 0, length, position) : 0;
  return buffer.subarray(0, count);
}
