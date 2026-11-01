/**
 * Low-level JSONL tail reader for consumers that need raw parsed events plus
 * their own aggregation lifecycle.
 */

import * as fs from 'fs';
import type { ZodType } from 'zod';
import { fileHeadOf, HEAD_BYTES, headMatches, type FileHead } from '../fileHead';
import { FileContinuity, probeFileContinuity, type FileContinuityProbe } from '../fileContinuity';
import { JsonlParser } from '../parsers/jsonl';

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_CATCHUP_INTERVAL_MS = 30_000;
/** Default bytes read from the file per chunk. */
export const DEFAULT_JSONL_TAIL_READ_BYTES = 1024 * 1024;
/** Default longest line parsed; longer lines are skipped and reported. */
export const DEFAULT_JSONL_TAIL_MAX_LINE_BYTES = 16 * 1024 * 1024;
/** The `version` written into, and accepted from, {@link JsonlTailCheckpoint}. */
export const JSONL_TAIL_CHECKPOINT_VERSION = 1;

const BACKWARD_SCAN_BYTES = 64 * 1024;

/**
 * Skip old complete events while retaining an in-progress final line: the
 * offset just after the last newline in the first `size` bytes, or 0.
 */
function lastCompleteLineOffset(fd: number, size: number): number {
  let end = size;
  const buffer = Buffer.alloc(BACKWARD_SCAN_BYTES);
  while (end > 0) {
    const start = Math.max(0, end - buffer.length);
    const count = fs.readSync(fd, buffer, 0, end - start, start);
    const newline = buffer.subarray(0, count).lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function lastCompleteLineOffsetAsync(
  handle: fs.promises.FileHandle,
  size: number,
): Promise<number> {
  let end = size;
  const buffer = Buffer.alloc(BACKWARD_SCAN_BYTES);
  while (end > 0) {
    const start = Math.max(0, end - buffer.length);
    const { bytesRead } = await handle.read(buffer, 0, end - start, start);
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
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

/**
 * What the tail does when the file it follows shrank, was rewritten, or was
 * replaced: `'restart'` replays it from offset 0; `'end'` continues from its
 * current end, skipping what it already holds.
 */
export type JsonlTailRewritePolicy = 'restart' | 'end';

/** The tail started over from the beginning, or (with `onRewrite: 'end'`) the end, of the file. */
export interface JsonlTailReset {
  /** `truncated`: the file shrank; `rewritten`: its first bytes or the resume point changed; `replaced`: another file now has the path. */
  reason: JsonlTailResetReason;
  /** The committed offset before the reset. */
  previousOffset: number;
  /**
   * Where reading continues. Present only with `onRewrite: 'end'`; with the
   * default `'restart'` policy reading always continues from 0.
   */
  offset?: number;
}

/** An event parsed by {@link JsonlTail.read}, with its line's position. */
export interface JsonlTailEntry<T> {
  event: T;
  line: JsonlTailLine;
}

/** What one {@link JsonlTail.read} call read. */
export interface JsonlTailReadResult<T> extends JsonlTailBatch {
  /** Events from the lines that became complete, in file order: the same ones `onEvent` received. */
  events: JsonlTailEntry<T>[];
  /** Present when the tail reset before reading; `onReset` received the same object. */
  reset?: JsonlTailReset;
}

/**
 * A JSON-serializable resume point from {@link JsonlTail.checkpoint} or
 * {@link captureJsonlCheckpoint}. It identifies the file by device and inode
 * plus a digest of its first bytes, so a new tail (in this or a later
 * process) or {@link verifyJsonlCheckpoint} can confirm the file is still the
 * same, append-only one before anything continues from `offset`.
 */
export interface JsonlTailCheckpoint {
  version: typeof JSONL_TAIL_CHECKPOINT_VERSION;
  /** Resume-safe byte offset: 0, or just after a newline. */
  offset: number;
  /** Device and inode of the file the offset refers to; `null` before the first read. */
  identity: { dev: number; ino: number } | null;
  /**
   * Length (at most 4096) and truncated SHA-256 hex of the file's first
   * bytes when last read; `null` before the first read.
   */
  prefixDigest: { bytes: number; hash: string } | null;
}

/**
 * Reported to `onError` (and nothing is read) when `noFollow` is set and the
 * tailed path is a symbolic link.
 */
export class JsonlTailSymlinkError extends Error {
  readonly code = 'JSONL_TAIL_SYMLINK';

  constructor(readonly path: string) {
    super(`Refusing to follow the symbolic link at ${path} (noFollow is set).`);
    this.name = 'JsonlTailSymlinkError';
  }
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
  /** Called after the tail resets (see `onRewrite`); events from the new position follow. */
  onReset?: (reset: JsonlTailReset) => void;
  /** Bytes read per chunk (default 1 MiB); one poll reads chunk by chunk to the end. */
  maxReadBytes?: number;
  /** Longest line parsed (default 16 MiB); a longer line is skipped and reported to `onError`. */
  maxLineBytes?: number;
  /**
   * Where to continue after the file is truncated, rewritten, or replaced,
   * and after `resumeFrom()` rejects a checkpoint. `'restart'` (default)
   * replays from offset 0. `'end'` continues from the file's current end, or
   * from the start of an unfinished final line as `startAtEnd` does. `onReset`
   * fires either way.
   */
  onRewrite?: JsonlTailRewritePolicy;
  /**
   * Refuse to follow a symbolic link at `path`: the file is opened with
   * `O_NOFOLLOW` where the platform defines it (a no-op where it does not,
   * such as Windows). A symlinked path is reported to `onError` as a
   * {@link JsonlTailSymlinkError} and not read or watched. Only the final
   * path component is checked; symlinked parent directories still resolve.
   */
  noFollow?: boolean;
}

export interface JsonlTail<T = unknown> {
  readonly isActive: boolean;
  start(): void;
  stop(): void;
  dispose(): void;
  /**
   * Reads every newly complete line now, synchronously, through the
   * callbacks. While `read()` calls are queued or running, the call is
   * deferred until the last of them settles.
   */
  readNow(): void;
  /**
   * Reads like `readNow()`, with asynchronous I/O, and resolves with what it
   * read; the callbacks fire as they do for `readNow()`. Never rejects for
   * I/O or parse problems (those go to `onError`). Concurrent calls run one
   * after another.
   */
  read(): Promise<JsonlTailReadResult<T>>;
  getOffset(): number;
  seekTo(offset: number): void;
  /** A JSON-serializable resume point at the committed offset; does no I/O. */
  checkpoint(): JsonlTailCheckpoint;
  /**
   * Validates `checkpoint` (shape, file identity, prefix digest, and that its
   * offset still follows a newline) against the file now at the path. On
   * success reading continues from its offset and this returns true.
   * Otherwise the `onRewrite` policy picks the position (0, or the file's
   * current end) and this returns false; `onReset` is not called. Either way
   * the position overrides `startAtEnd` on a later `start()`.
   */
  resumeFrom(checkpoint: unknown): boolean;
}

export function createJsonlTail<T>(options: JsonlTailOptions<T>): JsonlTail<T> {
  return new JsonlTailReader(options);
}

/**
 * Records a {@link JsonlTailCheckpoint} for byte `offset` of `filePath`
 * without a tail, for readers that keep their own offset (a snapshot that
 * stores a reader position, for example). The checkpoint carries the file's
 * current device and inode and a digest of its first bytes, so
 * {@link verifyJsonlCheckpoint} (or {@link JsonlTail.resumeFrom}) can later
 * tell whether `offset` still refers to the same, append-only content.
 *
 * Returns `null` when the file is missing or unreadable, or when `offset` is
 * not a resume-safe position in it: negative, past the end, or not 0 and not
 * just after a newline. Follows symbolic links.
 */
export function captureJsonlCheckpoint(
  filePath: string,
  offset: number,
): JsonlTailCheckpoint | null {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (offset > stat.size) return null;
    if (offset > 0 && readAt(fd, offset - 1, 1)[0] !== 0x0a) return null;
    return checkpointOf(offset, stat, fileHeadOf(readPrefix(fd, stat)));
  } catch {
    return null;
  } finally {
    closeQuietly(fd);
  }
}

/**
 * Whether `checkpoint` (any value, typically parsed from JSON) is a valid
 * {@link JsonlTailCheckpoint} that still describes `filePath`: same device
 * and inode, the recorded first bytes unchanged, and its offset within the
 * file and just after a newline (or 0). This is the check
 * {@link JsonlTail.resumeFrom} applies. `false` on any error, including a
 * missing file. Follows symbolic links.
 */
export function verifyJsonlCheckpoint(filePath: string, checkpoint: unknown): boolean {
  const parsed = parseCheckpoint(checkpoint);
  if (parsed === null) return false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    return checkpointMatches(parsed, fd, stat, readPrefix(fd, stat));
  } catch {
    return false;
  } finally {
    closeQuietly(fd);
  }
}

class JsonlTailReader<T> implements JsonlTail<T> {
  private active = false;
  /** Physical byte position already read from the file. */
  private readOffset: number;
  /** Resume-safe byte position ending immediately after a newline. */
  private committedOffset: number;
  private pendingBytes = Buffer.alloc(0);
  /** Inside a line over `maxLineBytes`: drop bytes until its newline. */
  private skippingLine = false;
  private currentLine: JsonlTailLine = { offset: 0, length: 0 };
  /** Identity, mtime, and prefix of the file the offsets refer to, once read. */
  private readonly continuity = new FileContinuity();
  private readonly maxReadBytes: number;
  private readonly maxLineBytes: number;
  private readonly rewritePolicy: JsonlTailRewritePolicy;
  private fsWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private catchupTimer: ReturnType<typeof setInterval> | null = null;
  private eventsInCurrentBatch = 0;
  private readonly parser: JsonlParser<T>;
  /** Collects parsed events while a `read()` is running. */
  private collector: JsonlTailEntry<T>[] | null = null;
  /** Serializes `read()` calls. */
  private readChain: Promise<unknown> = Promise.resolve();
  /** `read()` calls queued or running; `readNow()` waits for them. */
  private queuedReads = 0;
  private readNowDeferred = false;
  /** Bumped by repositioning calls so an in-flight `read()` stops early. */
  private generation = 0;
  /** `resumeFrom()` chose the position; `start()` must not move it to the end. */
  private positioned = false;

  constructor(private readonly options: JsonlTailOptions<T>) {
    this.readOffset = options.startOffset ?? 0;
    this.committedOffset = this.readOffset;
    this.maxReadBytes = positiveInteger(options.maxReadBytes, DEFAULT_JSONL_TAIL_READ_BYTES);
    this.maxLineBytes = positiveInteger(options.maxLineBytes, DEFAULT_JSONL_TAIL_MAX_LINE_BYTES);
    this.rewritePolicy = options.onRewrite === 'end' ? 'end' : 'restart';
    this.parser = new JsonlParser<T>(
      {
        onEvent: (event) => {
          this.eventsInCurrentBatch += 1;
          this.collector?.push({ event, line: this.currentLine });
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

    if (this.options.startAtEnd && this.options.startOffset === undefined && !this.positioned) {
      let fd: number | null = null;
      try {
        fd = this.openSync();
        this.readOffset = lastCompleteLineOffset(fd, fs.fstatSync(fd).size);
      } catch {
        this.readOffset = 0;
      } finally {
        closeQuietly(fd);
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
    if (this.queuedReads > 0) {
      this.readNowDeferred = true;
      return;
    }
    let fd: number | null = null;
    try {
      fd = this.openSync();
      const stat = fs.fstatSync(fd);
      const probe = this.probeNeeded(stat) ? this.probeSync(fd, stat) : null;
      const reason = this.resetReason(stat, probe);
      if (reason !== null) {
        this.reset(
          reason,
          this.rewritePolicy === 'end' ? lastCompleteLineOffset(fd, stat.size) : 0,
        );
      }
      this.adoptFile(stat, probe);
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
      this.options.onError?.(toError(error));
    } finally {
      closeQuietly(fd);
    }
  }

  read(): Promise<JsonlTailReadResult<T>> {
    this.queuedReads += 1;
    const run = this.readChain.then(() => this.readAsync());
    this.readChain = run.catch(() => undefined);
    return run;
  }

  private async readAsync(): Promise<JsonlTailReadResult<T>> {
    const generation = this.generation;
    const events: JsonlTailEntry<T>[] = [];
    let reset: JsonlTailReset | undefined;
    let bytesRead = 0;
    let eventsRead = 0;
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await this.openAsync();
      const stat = await handle.stat();
      const probe = this.probeNeeded(stat) ? await this.probeAsync(handle, stat) : null;
      if (generation === this.generation) {
        const reason = this.resetReason(stat, probe);
        const offset =
          reason !== null && this.rewritePolicy === 'end'
            ? await lastCompleteLineOffsetAsync(handle, stat.size)
            : 0;
        if (generation === this.generation) {
          if (reason !== null) reset = this.reset(reason, offset);
          this.adoptFile(stat, probe);
          if (stat.size > this.readOffset) {
            this.eventsInCurrentBatch = 0;
            const chunk = Buffer.alloc(Math.min(this.maxReadBytes, stat.size - this.readOffset));
            while (this.readOffset < stat.size) {
              const want = Math.min(chunk.length, stat.size - this.readOffset);
              const position = this.readOffset;
              const { bytesRead: count } = await handle.read(chunk, 0, want, position);
              if (count <= 0 || generation !== this.generation) break;
              this.collector = events;
              try {
                this.consume(chunk.subarray(0, count), position);
              } finally {
                this.collector = null;
              }
              this.readOffset += count;
              bytesRead += count;
            }
            eventsRead = this.eventsInCurrentBatch;
            if (bytesRead > 0) {
              this.options.onBatchComplete?.({
                bytesRead,
                eventsRead,
                offset: this.committedOffset,
              });
            }
          }
        }
      }
    } catch (error) {
      this.options.onError?.(toError(error));
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      this.queuedReads -= 1;
      if (this.queuedReads === 0 && this.readNowDeferred) {
        this.readNowDeferred = false;
        this.readNow();
      }
    }
    return {
      bytesRead,
      eventsRead,
      offset: this.committedOffset,
      events,
      ...(reset ? { reset } : {}),
    };
  }

  /** Whether the continuity check needs bytes from the file. */
  private probeNeeded(stat: fs.Stats): boolean {
    return this.continuity.needsProbe(stat, this.readOffset);
  }

  private probeSync(fd: number, stat: fs.Stats): FileContinuityProbe {
    return probeFileContinuity(fd, stat, this.committedOffset);
  }

  private async probeAsync(
    handle: fs.promises.FileHandle,
    stat: fs.Stats,
  ): Promise<FileContinuityProbe> {
    const committedOffset = this.committedOffset;
    return {
      prefix: await readAtAsync(handle, 0, Math.min(HEAD_BYTES, stat.size)),
      before:
        committedOffset > 0 && committedOffset <= stat.size
          ? await readAtAsync(handle, committedOffset - 1, 1)
          : null,
    };
  }

  /**
   * Why the tail must reposition: the path now names another file, the file
   * shrank, its first bytes changed, or the resume point no longer follows a
   * newline. `null` when it can continue.
   */
  private resetReason(
    stat: fs.Stats,
    probe: FileContinuityProbe | null,
  ): JsonlTailResetReason | null {
    return this.continuity.reasonFor(stat, this.readOffset, probe);
  }

  /** Records the identity and prefix of the file the offsets now refer to. */
  private adoptFile(stat: fs.Stats, probe: FileContinuityProbe | null): void {
    this.continuity.record(stat, probe);
  }

  private reset(reason: JsonlTailResetReason, offset: number): JsonlTailReset {
    const previousOffset = this.committedOffset;
    this.position(offset);
    this.continuity.discardHead();
    if (reason === 'replaced' && this.active) {
      // fs.watch follows the old inode; watch the file now at the path.
      this.fsWatcher?.close();
      this.fsWatcher = null;
      this.watchFile();
    }
    const reset: JsonlTailReset =
      this.rewritePolicy === 'end'
        ? { reason, previousOffset, offset }
        : { reason, previousOffset };
    this.options.onReset?.(reset);
    return reset;
  }

  /** Moves both offsets to `offset` and drops any partial-line state. */
  private position(offset: number): void {
    this.readOffset = offset;
    this.committedOffset = offset;
    this.pendingBytes = Buffer.alloc(0);
    this.skippingLine = false;
    this.parser.reset();
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
    this.generation += 1;
    this.position(Math.max(0, offset));
  }

  checkpoint(): JsonlTailCheckpoint {
    return checkpointOf(
      this.committedOffset,
      this.continuity.knownIdentity,
      this.continuity.knownHead,
    );
  }

  resumeFrom(checkpoint: unknown): boolean {
    this.generation += 1;
    this.positioned = true;
    const parsed = parseCheckpoint(checkpoint);
    let fd: number | null = null;
    try {
      fd = this.openSync();
      const stat = fs.fstatSync(fd);
      const prefix = readPrefix(fd, stat);
      const matches = parsed !== null && checkpointMatches(parsed, fd, stat, prefix);
      const offset = matches
        ? parsed.offset
        : this.rewritePolicy === 'end'
          ? lastCompleteLineOffset(fd, stat.size)
          : 0;
      this.position(offset);
      this.continuity.adoptPrefix(stat, prefix);
      return matches;
    } catch (error) {
      this.position(0);
      this.continuity.forget();
      this.options.onError?.(toError(error));
      return false;
    } finally {
      closeQuietly(fd);
    }
  }

  private openFlags(): string | number {
    const noFollow = this.options.noFollow ? fs.constants.O_NOFOLLOW : undefined;
    return typeof noFollow === 'number' ? fs.constants.O_RDONLY | noFollow : 'r';
  }

  private openSync(): number {
    try {
      return fs.openSync(this.options.path, this.openFlags());
    } catch (error) {
      throw this.refusedSymlink(error) ?? error;
    }
  }

  private async openAsync(): Promise<fs.promises.FileHandle> {
    try {
      return await fs.promises.open(this.options.path, this.openFlags());
    } catch (error) {
      throw this.refusedSymlink(error) ?? error;
    }
  }

  /** The typed error for an open that `O_NOFOLLOW` refused because the path is a symlink. */
  private refusedSymlink(error: unknown): JsonlTailSymlinkError | null {
    if (!this.options.noFollow) return null;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // ELOOP on Linux and macOS; EMLINK on FreeBSD.
    if (code !== 'ELOOP' && code !== 'EMLINK') return null;
    try {
      return fs.lstatSync(this.options.path).isSymbolicLink()
        ? new JsonlTailSymlinkError(this.options.path)
        : null;
    } catch {
      return null;
    }
  }

  private watchFile(): void {
    if (this.options.noFollow) {
      try {
        // fs.watch follows links; a refused symlink is not watched either.
        if (fs.lstatSync(this.options.path).isSymbolicLink()) return;
      } catch {
        // Missing: fs.watch below fails the same way and polling covers it.
      }
    }
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

/** The checkpoint when `value` has the documented shape, else `null`. */
function parseCheckpoint(value: unknown): JsonlTailCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== JSONL_TAIL_CHECKPOINT_VERSION) return null;
  const { offset, identity, prefixDigest } = candidate;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null;

  let parsedIdentity: JsonlTailCheckpoint['identity'] = null;
  if (identity !== null) {
    if (!identity || typeof identity !== 'object') return null;
    const { dev, ino } = identity as Record<string, unknown>;
    if (!isFiniteNumber(dev) || !isFiniteNumber(ino)) return null;
    parsedIdentity = { dev, ino };
  }

  let parsedDigest: JsonlTailCheckpoint['prefixDigest'] = null;
  if (prefixDigest !== null) {
    if (!prefixDigest || typeof prefixDigest !== 'object') return null;
    const { bytes, hash } = prefixDigest as Record<string, unknown>;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0 || bytes > HEAD_BYTES) {
      return null;
    }
    if (typeof hash !== 'string' || hash.length === 0) return null;
    parsedDigest = { bytes, hash };
  }

  return {
    version: JSONL_TAIL_CHECKPOINT_VERSION,
    offset,
    identity: parsedIdentity,
    prefixDigest: parsedDigest,
  };
}

/** A fresh checkpoint for `offset` in the file with `identity` and recorded `head`. */
function checkpointOf(
  offset: number,
  identity: { dev: number; ino: number } | null,
  head: FileHead | null,
): JsonlTailCheckpoint {
  return {
    version: JSONL_TAIL_CHECKPOINT_VERSION,
    offset,
    identity: identity ? { dev: identity.dev, ino: identity.ino } : null,
    prefixDigest: head ? { bytes: head.bytes, hash: head.hash } : null,
  };
}

/** Whether `checkpoint` still describes the open file. */
function checkpointMatches(
  checkpoint: JsonlTailCheckpoint,
  fd: number,
  stat: fs.Stats,
  prefix: Buffer,
): boolean {
  const { offset, identity, prefixDigest } = checkpoint;
  // Taken before the first read: nothing was consumed, so nothing can be stale.
  if (identity === null && prefixDigest === null) return offset === 0;
  if (identity === null || prefixDigest === null) return false;
  if (identity.dev !== stat.dev || identity.ino !== stat.ino) return false;
  if (!headMatches(prefixDigest, prefix)) return false;
  if (offset > stat.size) return false;
  return offset === 0 || readAt(fd, offset - 1, 1)[0] === 0x0a;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function closeQuietly(fd: number | null): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore close errors */
  }
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const count = length > 0 ? fs.readSync(fd, buffer, 0, length, position) : 0;
  return buffer.subarray(0, count);
}

/** The file's first `min(HEAD_BYTES, size)` bytes: what a checkpoint digests. */
function readPrefix(fd: number, stat: fs.Stats): Buffer {
  return readAt(fd, 0, Math.min(HEAD_BYTES, stat.size));
}

async function readAtAsync(
  handle: fs.promises.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const count = length > 0 ? (await handle.read(buffer, 0, length, position)).bytesRead : 0;
  return buffer.subarray(0, count);
}
