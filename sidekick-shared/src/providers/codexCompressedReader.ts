/**
 * Session reader for a compressed Codex rollout (`rollout-…jsonl.zst`).
 *
 * Codex compresses only rollouts it no longer writes, so the content is
 * decompressed and parsed whole on the first read; later reads cost one
 * stat and return nothing until the file changes (then the rollout is read
 * again from the start, reported as `replaced`). Positions are offsets in
 * the decompressed content. Live tailing stays with the `.jsonl` reader.
 *
 * Node-only: reads files.
 *
 * @module providers/codexCompressedReader
 */

import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { CodexRolloutParser, type CodexRolloutResumeState } from '../parsers/codexParser';
import { splitLines } from '../parsers/lineSplitter';
import type { CodexRateLimits, CodexRolloutLine, CodexSessionMeta } from '../types/codex';
import type { SessionEvent, TokenUsage } from '../types/sessionEvent';
import { normalizeProviderUsage } from '../usageNormalization';
import {
  readRolloutBuffer,
  readRolloutBufferAsync,
  type ReadRolloutOptions,
} from './compressedRollouts';
import { boundedReadLimit, type BoundedReaderInternals } from './boundedReader';
import type { SessionReader } from './types';

type ReaderReset = NonNullable<ReturnType<NonNullable<SessionReader['lastReset']>>>;

export interface CompressedCodexReaderCallbacks {
  onContextWindowLimit?: (limit: number, modelId?: string) => void;
  onRateLimits?: (limits: CodexRateLimits) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
  onDiagnostic?: ReadRolloutOptions['onDiagnostic'];
}

type SourceStamp = { size: number; mtimeMs: number };

function sameSource(left: SourceStamp | null, right: SourceStamp): boolean {
  return left !== null && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** A bounded drain over decompressed content (see `readNewBounded`). */
interface ContentDrain {
  content: Buffer;
  source: SourceStamp;
  /** Offset consumed so far (may sit inside a line). */
  offset: number;
  carry: string;
  decoder: StringDecoder;
}

/**
 * Reads a `.jsonl.zst` rollout through a {@link CodexRolloutParser}.
 *
 * Bounded reads (`readNewBounded`) parse the decompressed content in steps;
 * `prepareBoundedRead()` decompresses it off the main thread first. A
 * compressed rollout is complete, so a drain never resumes in a later call.
 */
export class CompressedCodexRolloutReader implements SessionReader, BoundedReaderInternals {
  private parser = new CodexRolloutParser({
    includeSubagentActivity: true,
    includeTurnLifecycle: true,
  });
  /** Offset after the last line parsed (the content is complete, so its end). */
  private position = 0;
  /** Size and mtime of the compressed file the position refers to. */
  private source: { size: number; mtimeMs: number } | null = null;
  private reset_: ReaderReset | null = null;
  /** Position from `seekTo()` whose prefix still has to be parsed for context. */
  private pendingSeek: number | null = null;
  /** Content decompressed by `prepareBoundedRead()` for the next drain. */
  private prepared: { content: Buffer; source: SourceStamp } | null = null;
  /** The bounded drain in progress, if any. */
  private drain: ContentDrain | null = null;

  constructor(
    private readonly rolloutPath: string,
    private readonly callbacks: CompressedCodexReaderCallbacks = {},
  ) {}

  getSessionMeta(): CodexSessionMeta | null {
    this.settleSeek();
    return this.parser.getSessionMeta();
  }

  readNew(): SessionEvent[] {
    this.settleSeek();
    this.reset_ = null;
    this.endDrain();
    return this.readFrom(true);
  }

  async prepareBoundedRead(): Promise<void> {
    if (this.drain || this.pendingSeek !== null) return;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.rolloutPath);
    } catch {
      return;
    }
    const current = { size: stat.size, mtimeMs: stat.mtimeMs };
    // Already read whole and unchanged, or already prepared.
    if (sameSource(this.source, current) || sameSource(this.prepared?.source ?? null, current)) {
      return;
    }
    const content = await readRolloutBufferAsync(this.rolloutPath, {
      onDiagnostic: this.callbacks.onDiagnostic,
    });
    if (content) this.prepared = { content, source: current };
  }

  readNewBounded(maxBytes: number): { events: SessionEvent[]; done: boolean } {
    const limit = boundedReadLimit(maxBytes);
    this.settleSeek();
    this.reset_ = null;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.rolloutPath);
    } catch {
      this.endDrain();
      return { events: [], done: true };
    }
    const current = { size: stat.size, mtimeMs: stat.mtimeMs };
    if (this.drain && !sameSource(this.drain.source, current)) {
      // Another file has the path mid-drain: start over on it.
      this.reset_ = { reason: 'replaced', previousPosition: this.position } as ReaderReset;
      this.parser.reset();
      this.position = 0;
      this.source = null;
      this.endDrain();
    } else if (!this.drain && this.source) {
      if (sameSource(this.source, current)) return { events: [], done: true };
      // Another file has the path: what was read no longer describes it.
      this.reset_ = { reason: 'replaced', previousPosition: this.position } as ReaderReset;
      this.parser.reset();
      this.position = 0;
      this.source = null;
    }

    if (!this.drain) {
      const content = sameSource(this.prepared?.source ?? null, current)
        ? this.prepared!.content
        : readRolloutBuffer(this.rolloutPath, { onDiagnostic: this.callbacks.onDiagnostic });
      this.prepared = null;
      if (!content) return { events: [], done: true };
      if (this.position > content.length) {
        // The position sought lies past this content: start over.
        this.reset_ = { reason: 'truncated', previousPosition: this.position } as ReaderReset;
        this.parser.reset();
        this.position = 0;
      }
      this.drain = {
        content,
        source: current,
        offset: this.position,
        carry: '',
        decoder: new StringDecoder('utf8'),
      };
    }

    const drain = this.drain;
    const events: SessionEvent[] = [];
    const onLine = (line: string) => this.parseLine(line, events);
    const end = Math.min(drain.content.length, drain.offset + limit);
    const bytes = drain.content.subarray(drain.offset, end);
    drain.carry = splitLines(drain.carry, drain.decoder.write(bytes), onLine);
    const newline = bytes.lastIndexOf(0x0a);
    if (newline >= 0) this.position = drain.offset + newline + 1;
    drain.offset = end;
    if (end < drain.content.length) return { events, done: false };

    // The content is complete: its last line needs no newline (as in readNew()).
    const rest = drain.carry + drain.decoder.end();
    if (rest) onLine(rest);
    this.position = drain.content.length;
    this.source = drain.source;
    this.drain = null;
    this.propagateParserState();
    return { events, done: true };
  }

  finishBounded(): SessionEvent[] {
    // The last bounded step already parsed the content through its end.
    return [];
  }

  private parseLine(line: string, events: SessionEvent[] | null): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const converted = this.parser.convertLine(JSON.parse(trimmed) as CodexRolloutLine);
      if (events) {
        for (const event of converted) events.push(event);
      }
    } catch {
      // Skip malformed lines.
    }
  }

  private endDrain(): void {
    this.drain = null;
    this.prepared = null;
  }

  readAll(): SessionEvent[] {
    this.reset();
    return this.readNew();
  }

  reset(): void {
    this.parser.reset();
    this.position = 0;
    this.source = null;
    this.reset_ = null;
    this.pendingSeek = null;
    this.endDrain();
  }

  exists(): boolean {
    return fs.existsSync(this.rolloutPath);
  }

  flush(): void {
    // Nothing is buffered: each read parses through the end of the content.
  }

  getPosition(): number {
    return this.position;
  }

  seekTo(position: number): void {
    this.reset();
    this.position = Math.max(0, position);
    if (this.position > 0) this.pendingSeek = this.position;
  }

  wasTruncated(): boolean {
    return this.reset_ !== null;
  }

  lastReset(): ReaderReset | null {
    return this.reset_ ? { ...this.reset_ } : null;
  }

  getResumeState(): CodexRolloutResumeState {
    this.settleSeek();
    return this.parser.exportResumeState();
  }

  restoreResumeState(state: unknown): boolean {
    if (!this.parser.importResumeState(state)) return false;
    this.pendingSeek = null;
    this.propagateParserState();
    return true;
  }

  /** Parses the content past `position`; `emit` false only rebuilds parser state. */
  private readFrom(emit: boolean, endPosition?: number): SessionEvent[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.rolloutPath);
    } catch {
      return [];
    }
    const current = { size: stat.size, mtimeMs: stat.mtimeMs };
    if (
      this.source &&
      (this.source.size !== current.size || this.source.mtimeMs !== current.mtimeMs)
    ) {
      // Another file has the path: what was read no longer describes it.
      this.reset_ = { reason: 'replaced', previousPosition: this.position } as ReaderReset;
      this.parser.reset();
      this.position = 0;
    } else if (this.source) {
      return [];
    }

    const content = readRolloutBuffer(this.rolloutPath, {
      onDiagnostic: this.callbacks.onDiagnostic,
    });
    if (!content) return [];
    this.source = current;
    const end = Math.min(content.length, endPosition ?? content.length);
    if (this.position > end) {
      // The position sought lies past this content: start over.
      this.reset_ = { reason: 'truncated', previousPosition: this.position } as ReaderReset;
      this.parser.reset();
      this.position = 0;
    }

    const events: SessionEvent[] = [];
    const text = content.toString('utf8', this.position, end);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const converted = this.parser.convertLine(JSON.parse(trimmed) as CodexRolloutLine);
        if (emit) events.push(...converted);
      } catch {
        // Skip malformed lines.
      }
    }
    this.position = end;
    if (end < content.length) this.source = null;
    this.propagateParserState();
    return events;
  }

  /** Rebuilds parser context for a pending `seekTo()` position. */
  private settleSeek(): void {
    const position = this.pendingSeek;
    if (position === null) return;
    this.pendingSeek = null;
    this.parser.reset();
    this.position = 0;
    this.source = null;
    this.readFrom(false, position);
  }

  /** Hands the parser's context window, rate limits, and last usage to the provider. */
  private propagateParserState(): void {
    const { onContextWindowLimit, onRateLimits, onTokenUsage } = this.callbacks;
    const window = this.parser.getModelContextWindow();
    if (window && onContextWindowLimit) {
      onContextWindowLimit(window, this.parser.getCurrentModel() ?? undefined);
    }
    const rateLimits = this.parser.getLastRateLimits();
    if (rateLimits && onRateLimits) onRateLimits(rateLimits);
    const lastUsage = this.parser.getLastTokenUsage();
    if (lastUsage && onTokenUsage) {
      const normalized = normalizeProviderUsage({
        semantics: 'openai',
        provider: 'openai',
        source: 'codex-reader-snapshot',
        model: this.parser.getCurrentModel() || undefined,
        inputTokens: lastUsage.input_tokens,
        outputTokens: lastUsage.output_tokens,
        cacheReadTokens: lastUsage.cached_input_tokens,
        cacheWriteTokens: lastUsage.cache_write_input_tokens,
        reasoningTokens: lastUsage.reasoning_output_tokens,
      });
      onTokenUsage({
        inputTokens: normalized.uncachedInputTokens,
        outputTokens: normalized.outputTokens,
        cacheWriteTokens: normalized.cacheWriteTokens,
        cacheReadTokens: normalized.cacheReadTokens,
        reasoningTokens: normalized.reasoningTokens,
        model: this.parser.getCurrentModel() || 'unknown',
        timestamp: new Date(),
      });
    }
  }
}
