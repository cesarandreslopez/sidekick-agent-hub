/**
 * Low-level JSONL tail reader for consumers that need raw parsed events plus
 * their own aggregation lifecycle.
 */

import * as fs from 'fs';
import type { ZodType } from 'zod';
import { JsonlParser } from '../parsers/jsonl';

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_CATCHUP_INTERVAL_MS = 30_000;

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
  private offset: number;
  private fsWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private catchupTimer: ReturnType<typeof setInterval> | null = null;
  private eventsInCurrentBatch = 0;
  private readonly parser: JsonlParser<T>;

  constructor(private readonly options: JsonlTailOptions<T>) {
    this.offset = options.startOffset ?? 0;
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
        this.offset = fs.statSync(this.options.path).size;
      } catch {
        this.offset = 0;
      }
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

      if (stat.size < this.offset) {
        this.offset = 0;
        this.parser.reset();
      }

      if (stat.size <= this.offset) return;

      const bytesToRead = stat.size - this.offset;
      const buffer = Buffer.alloc(bytesToRead);
      fd = fs.openSync(this.options.path, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, this.offset);
      fs.closeSync(fd);
      fd = null;

      if (bytesRead <= 0) return;

      this.offset += bytesRead;
      this.eventsInCurrentBatch = 0;
      this.parser.processChunk(buffer.toString('utf-8', 0, bytesRead));
      this.options.onBatchComplete?.({
        bytesRead,
        eventsRead: this.eventsInCurrentBatch,
        offset: this.offset,
      });
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore close errors */ }
      }
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getOffset(): number {
    return this.offset;
  }

  seekTo(offset: number): void {
    this.offset = Math.max(0, offset);
    this.parser.reset();
  }

  private watchFile(): void {
    try {
      this.fsWatcher = fs.watch(this.options.path, { persistent: false }, () => {
        this.debouncedRead();
      });
      this.fsWatcher.on('error', (error) => this.options.onError?.(error));
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
