/**
 * Low-level JSONL tail reader for consumers that need raw parsed events plus
 * their own aggregation lifecycle.
 */

import * as fs from 'fs';
import type { ZodType } from 'zod';
import { JsonlParser } from '../parsers/jsonl';

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_CATCHUP_INTERVAL_MS = 30_000;

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

export interface JsonlTailOptions<T> {
  path: string;
  schema?: ZodType<T>;
  startOffset?: number;
  startAtEnd?: boolean;
  debounceMs?: number;
  catchupIntervalMs?: number;
  onEvent: (event: T) => void;
  onBatchComplete?: (batch: JsonlTailBatch) => void;
  onError?: (error: Error, line?: string) => void;
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
  private fsWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private catchupTimer: ReturnType<typeof setInterval> | null = null;
  private eventsInCurrentBatch = 0;
  private readonly parser: JsonlParser<T>;

  constructor(private readonly options: JsonlTailOptions<T>) {
    this.readOffset = options.startOffset ?? 0;
    this.committedOffset = this.readOffset;
    this.parser = new JsonlParser<T>(
      {
        onEvent: (event) => {
          this.eventsInCurrentBatch += 1;
          this.options.onEvent(event);
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
      const stat = fs.statSync(this.options.path);

      if (stat.size < this.readOffset) {
        this.readOffset = 0;
        this.committedOffset = 0;
        this.pendingBytes = Buffer.alloc(0);
        this.parser.reset();
      }

      if (stat.size <= this.readOffset) return;

      const bytesToRead = stat.size - this.readOffset;
      const buffer = Buffer.alloc(bytesToRead);
      fd = fs.openSync(this.options.path, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, this.readOffset);
      fs.closeSync(fd);
      fd = null;

      if (bytesRead <= 0) return;

      this.readOffset += bytesRead;
      this.eventsInCurrentBatch = 0;
      const combined = Buffer.concat([this.pendingBytes, buffer.subarray(0, bytesRead)]);
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        const completeLines = combined.subarray(0, lastNewline + 1);
        this.pendingBytes = Buffer.from(combined.subarray(lastNewline + 1));
        this.parser.processChunk(completeLines.toString('utf8'));
      } else {
        this.pendingBytes = combined;
      }
      this.committedOffset = this.readOffset - this.pendingBytes.length;
      this.options.onBatchComplete?.({
        bytesRead,
        eventsRead: this.eventsInCurrentBatch,
        offset: this.committedOffset,
      });
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore close errors */
        }
      }
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getOffset(): number {
    return this.committedOffset;
  }

  seekTo(offset: number): void {
    this.readOffset = Math.max(0, offset);
    this.committedOffset = this.readOffset;
    this.pendingBytes = Buffer.alloc(0);
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
