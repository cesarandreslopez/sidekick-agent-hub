/**
 * Node-only collection of human-typed prompts from Claude Code and Codex
 * session logs, scoped to a set of workspace roots.
 *
 * Parse-only: no redaction and no network I/O. Scope fails closed — a prompt
 * is returned only when the working directory recorded on its log line (or,
 * for Codex, its session/turn context) realpath-resolves to an allowed root
 * or somewhere inside one. Every bound stops cleanly and is reported in
 * `boundsHit`; nothing is silently truncated and no bound throws.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { HUMAN_CODEX_SOURCES, humanPromptText, type HumanPromptProvider } from './humanPrompt';
import { discoverWorktreeSiblings, resolveWorktreeMainRepo } from './parsers/sessionPathResolver';
import { ClaudeCodeProvider } from './providers/claudeCode';
import { CodexProvider } from './providers/codex';
import type { SessionFileInfo } from './providers/types';
import type { CanonicalTranscriptBlock, CanonicalTranscriptMessage } from './transcript';

export type PromptHistoryProvider = HumanPromptProvider;

export type PromptHistoryBound =
  | 'maxSessions'
  | 'maxFileBytes'
  | 'maxTotalBytes'
  | 'deadline'
  | 'aborted';

export interface PromptHistoryBounds {
  /** Session files read in one call (unchanged files do not count). Default 1000. */
  maxSessions?: number;
  /** Bytes a single file may need read in this pass. Default 16 MiB. */
  maxFileBytes?: number;
  /** Bytes read across all files in this call. Default 256 MiB. */
  maxTotalBytes?: number;
  /** Wall-clock budget for the call. Default 30 000 ms. */
  deadlineMs?: number;
}

/** Codex parse state carried across resumes (Claude lines are self-describing). */
export interface PromptHistoryResumeState {
  cwd?: string;
  gitBranch?: string;
  model?: string;
  /** Session is not interactive (non-human source, fork, or missing metadata). */
  excluded?: boolean;
  /** `session_meta` has been seen. */
  meta?: boolean;
}

export interface PromptHistoryCursorSession {
  provider: PromptHistoryProvider;
  sessionId: string;
  size: number;
  mtimeMs: number;
  /** Ordinal of the last human prompt seen in this file, or -1 when none. */
  lastOrdinal: number;
  /** Byte offset just past the last complete line processed. */
  offset: number;
  state?: PromptHistoryResumeState;
}

/** JSON-serializable resume point. Keys are opaque; they never contain paths. */
export interface PromptHistoryCursor {
  version: 1;
  sessions: Record<string, PromptHistoryCursorSession>;
}

export interface PromptHistoryUsage {
  /** Uncached input tokens. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface PromptHistoryEntry {
  provider: PromptHistoryProvider;
  sessionId: string;
  /** Stable index of this prompt among the session's human prompts (0-based). */
  ordinal: number;
  /** ISO timestamp from the log line; never synthesized. */
  timestamp: string;
  /** Full prompt text, untruncated. */
  text: string;
  /** Realpath of the working directory; always inside an allowed root. */
  cwd: string;
  gitBranch?: string;
  /** Model of the first assistant response to this prompt, when known. */
  model?: string;
  /** Usage of that first answering model call, when known. */
  usage?: PromptHistoryUsage;
}

export interface PromptHistoryStats {
  sessionsScanned: number;
  sessionsSkippedUnchanged: number;
  /** Scanned sessions with human prompts but none inside the allowed roots. */
  sessionsOutOfScope: number;
  filesOverSizeLimit: number;
  /** Codex sessions skipped as non-interactive (subagent, fork, unknown source). */
  sessionsNotInteractive: number;
  /** Human prompts dropped because the log line had no usable timestamp. */
  promptsMissingTimestamp: number;
  /** Human prompts dropped because their cwd was missing or outside the roots. */
  promptsOutOfScope: number;
}

export interface CollectPromptHistoryOptions {
  /** Absolute workspace roots; realpath-normalized internally. */
  workspacePaths: string[];
  /** Add git worktree siblings of each root. Default true. */
  includeWorktrees?: boolean;
  /** Default both. */
  providers?: PromptHistoryProvider[];
  /** Drop prompts older than this (and skip files not modified since). */
  since?: Date;
  cursor?: PromptHistoryCursor;
  bounds?: PromptHistoryBounds;
  signal?: AbortSignal;
}

export interface PromptHistoryResult {
  /** Ordered by provider, session, then ordinal. */
  entries: PromptHistoryEntry[];
  cursor: PromptHistoryCursor;
  stats: PromptHistoryStats;
  boundsHit: PromptHistoryBound[];
}

const DEFAULT_BOUNDS: Required<PromptHistoryBounds> = {
  maxSessions: 1000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  deadlineMs: 30_000,
};

const CHECK_EVERY_LINES = 500;
const ALL_PROVIDERS: PromptHistoryProvider[] = ['claude-code', 'codex'];

interface Candidate {
  provider: PromptHistoryProvider;
  sessionId: string;
  filePath: string;
  key: string;
}

interface ScanContext {
  roots: string[];
  sinceMs: number | null;
  stats: PromptHistoryStats;
  realpaths: Map<string, string | null>;
  shouldStop: () => PromptHistoryBound | null;
}

interface ScanOutcome {
  entries: PromptHistoryEntry[];
  lastOrdinal: number;
  offset: number;
  state?: PromptHistoryResumeState;
  inScope: number;
  outOfScope: number;
  notInteractive: boolean;
  stoppedBy: PromptHistoryBound | null;
}

/** Collect human-typed prompts from Claude Code and Codex logs under the given roots. */
export async function collectPromptHistory(
  options: CollectPromptHistoryOptions,
): Promise<PromptHistoryResult> {
  const bounds = { ...DEFAULT_BOUNDS, ...definedBounds(options.bounds) };
  const startedAt = Date.now();
  const boundsHit = new Set<PromptHistoryBound>();
  const stats: PromptHistoryStats = {
    sessionsScanned: 0,
    sessionsSkippedUnchanged: 0,
    sessionsOutOfScope: 0,
    filesOverSizeLimit: 0,
    sessionsNotInteractive: 0,
    promptsMissingTimestamp: 0,
    promptsOutOfScope: 0,
  };
  const previous = options.cursor?.version === 1 ? options.cursor.sessions : {};
  const cursor: PromptHistoryCursor = { version: 1, sessions: { ...previous } };
  const entries: PromptHistoryEntry[] = [];

  const shouldStop = (): PromptHistoryBound | null => {
    if (options.signal?.aborted) return 'aborted';
    if (Date.now() - startedAt >= bounds.deadlineMs) return 'deadline';
    return null;
  };
  const finish = (): PromptHistoryResult => ({
    entries: entries.sort(compareEntries),
    cursor,
    stats,
    boundsHit: [...boundsHit],
  });

  const realpaths = new Map<string, string | null>();
  const { roots, listingRoots } = resolveRoots(
    options.workspacePaths,
    options.includeWorktrees !== false,
    realpaths,
  );
  if (roots.length === 0) return finish();

  const sinceMs = options.since ? options.since.getTime() : null;
  const providers = options.providers ?? ALL_PROVIDERS;
  const candidates = await listCandidates(providers, listingRoots, sinceMs);

  const context: ScanContext = { roots, sinceMs, stats, realpaths, shouldStop };
  let totalBytes = 0;

  for (const candidate of candidates) {
    const stop = shouldStop();
    if (stop) {
      boundsHit.add(stop);
      break;
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(candidate.filePath);
    } catch {
      continue;
    }
    const prior = previous[candidate.key];
    if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
      stats.sessionsSkippedUnchanged++;
      continue;
    }
    // A file that shrank was rewritten; its old offsets and ordinals are meaningless.
    const resume = prior && prior.offset <= stat.size ? prior : undefined;
    const offset = resume?.offset ?? 0;
    const bytesToRead = stat.size - offset;

    if (resume?.state?.excluded) {
      cursor.sessions[candidate.key] = {
        ...resume,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset: stat.size,
      };
      stats.sessionsNotInteractive++;
      continue;
    }
    if (bytesToRead > bounds.maxFileBytes) {
      stats.filesOverSizeLimit++;
      boundsHit.add('maxFileBytes');
      continue;
    }
    if (stats.sessionsScanned >= bounds.maxSessions) {
      boundsHit.add('maxSessions');
      break;
    }
    if (totalBytes + bytesToRead > bounds.maxTotalBytes) {
      boundsHit.add('maxTotalBytes');
      break;
    }

    let buffer: Buffer;
    try {
      buffer = await readRange(candidate.filePath, offset, bytesToRead);
    } catch {
      continue;
    }
    totalBytes += buffer.length;
    stats.sessionsScanned++;

    const outcome = await scanBuffer(candidate, buffer, offset, resume, context);
    if (outcome.stoppedBy) {
      // Partially processed file: drop its entries and leave its cursor untouched.
      boundsHit.add(outcome.stoppedBy);
      break;
    }
    if (outcome.notInteractive) stats.sessionsNotInteractive++;
    else if (outcome.inScope === 0 && outcome.outOfScope > 0) stats.sessionsOutOfScope++;
    entries.push(...outcome.entries);
    cursor.sessions[candidate.key] = {
      provider: candidate.provider,
      sessionId: candidate.sessionId,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lastOrdinal: outcome.lastOrdinal,
      offset: outcome.offset,
      ...(outcome.state ? { state: outcome.state } : {}),
    };
    await yieldToEventLoop();
  }

  return finish();
}

function definedBounds(bounds: PromptHistoryBounds | undefined): PromptHistoryBounds {
  const result: PromptHistoryBounds = {};
  if (!bounds) return result;
  for (const key of Object.keys(DEFAULT_BOUNDS) as Array<keyof PromptHistoryBounds>) {
    const value = bounds[key];
    if (typeof value === 'number' && !Number.isNaN(value)) result[key] = Math.max(0, value);
  }
  return result;
}

function compareEntries(left: PromptHistoryEntry, right: PromptHistoryEntry): number {
  return (
    compareStrings(left.provider, right.provider) ||
    compareStrings(left.sessionId, right.sessionId) ||
    left.ordinal - right.ordinal
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function realpathOrNull(input: string, cache: Map<string, string | null>): string | null {
  const cached = cache.get(input);
  if (cached !== undefined) return cached;
  let resolved: string | null = null;
  try {
    resolved = path.isAbsolute(input) ? fs.realpathSync.native(input) : null;
  } catch {
    resolved = null;
  }
  cache.set(input, resolved);
  return resolved;
}

function resolveRoots(
  workspacePaths: string[],
  includeWorktrees: boolean,
  realpaths: Map<string, string | null>,
): { roots: string[]; listingRoots: string[] } {
  const roots = new Set<string>();
  const listingRoots = new Set<string>();
  const add = (candidate: string): void => {
    const real = realpathOrNull(candidate, realpaths);
    if (!real) return;
    roots.add(real);
    listingRoots.add(real);
    listingRoots.add(path.resolve(candidate));
  };
  for (const workspacePath of workspacePaths) {
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) continue;
    add(workspacePath);
    if (!includeWorktrees) continue;
    const real = realpathOrNull(workspacePath, realpaths);
    if (!real) continue;
    const mainRepo = resolveWorktreeMainRepo(real) ?? real;
    add(mainRepo);
    for (const sibling of discoverWorktreeSiblings(mainRepo)) add(sibling);
  }
  return { roots: [...roots], listingRoots: [...listingRoots] };
}

/** Fail-closed scope check on a recorded working directory. */
function scopedCwd(
  cwd: unknown,
  roots: string[],
  realpaths: Map<string, string | null>,
): string | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const real = realpathOrNull(cwd, realpaths);
  if (!real) return null;
  for (const root of roots) {
    if (real === root) return real;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (real.startsWith(prefix)) return real;
  }
  return null;
}

async function listCandidates(
  providers: PromptHistoryProvider[],
  listingRoots: string[],
  sinceMs: number | null,
): Promise<Candidate[]> {
  const byPath = new Map<string, Candidate>();
  const listOptions = sinceMs !== null ? { since: sinceMs } : {};
  for (const provider of [...new Set(providers)]) {
    if (!ALL_PROVIDERS.includes(provider)) continue;
    // Listings are only candidate supersets; scope is re-checked per prompt.
    const source = provider === 'claude-code' ? new ClaudeCodeProvider() : new CodexProvider();
    for (const root of listingRoots) {
      let files: SessionFileInfo[];
      try {
        files = (await source.listSessionFilesAsync?.(root, listOptions)) ?? [];
      } catch {
        files = [];
      }
      for (const file of files) {
        if (byPath.has(file.path)) continue;
        const sessionId = file.sessionId ?? path.basename(file.path, '.jsonl');
        byPath.set(file.path, {
          provider,
          sessionId,
          filePath: file.path,
          key: `${provider}:${sessionId}:${hashPath(file.path)}`,
        });
      }
    }
    source.dispose();
  }
  return [...byPath.values()].sort(
    (left, right) =>
      compareStrings(left.provider, right.provider) ||
      compareStrings(left.sessionId, right.sessionId) ||
      compareStrings(left.key, right.key),
  );
}

function hashPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 12);
}

async function readRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function scanBuffer(
  candidate: Candidate,
  buffer: Buffer,
  startOffset: number,
  resume: PromptHistoryCursorSession | undefined,
  context: ScanContext,
): Promise<ScanOutcome> {
  const lastNewline = buffer.lastIndexOf(0x0a);
  const complete = lastNewline >= 0 ? buffer.subarray(0, lastNewline + 1) : Buffer.alloc(0);
  const lines = complete.toString('utf8').split('\n');
  const scanner =
    candidate.provider === 'claude-code'
      ? new ClaudeLineScanner(candidate, resume, context)
      : new CodexLineScanner(candidate, resume, context);

  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && index % CHECK_EVERY_LINES === 0) {
      await yieldToEventLoop();
      const stop = context.shouldStop();
      if (stop) return { ...scanner.outcome(startOffset), stoppedBy: stop };
    }
    const line = lines[index];
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    if (scanner.accept(record as Record<string, unknown>) === 'excluded') {
      // Non-interactive Codex session: nothing in it will ever count.
      return {
        ...scanner.outcome(startOffset + buffer.length),
        entries: [],
        notInteractive: true,
        stoppedBy: null,
      };
    }
  }
  return { ...scanner.outcome(startOffset + complete.length), stoppedBy: null };
}

/** Shared per-file prompt bookkeeping for both providers. */
abstract class LineScanner {
  protected readonly entries: PromptHistoryEntry[] = [];
  protected nextOrdinal: number;
  protected inScope = 0;
  protected outOfScope = 0;
  protected pending: PromptHistoryEntry | null = null;

  constructor(
    protected readonly candidate: Candidate,
    resume: PromptHistoryCursorSession | undefined,
    protected readonly context: ScanContext,
  ) {
    this.nextOrdinal = (resume?.lastOrdinal ?? -1) + 1;
  }

  abstract accept(record: Record<string, unknown>): 'ok' | 'excluded';

  protected state(): PromptHistoryResumeState | undefined {
    return undefined;
  }

  outcome(offset: number): Omit<ScanOutcome, 'stoppedBy'> {
    const state = this.state();
    return {
      entries: this.entries,
      lastOrdinal: this.nextOrdinal - 1,
      offset,
      ...(state ? { state } : {}),
      inScope: this.inScope,
      outOfScope: this.outOfScope,
      notInteractive: false,
    };
  }

  /** Assign an ordinal to a human prompt and emit it when in scope. */
  protected recordPrompt(
    text: string,
    timestamp: unknown,
    cwd: unknown,
    gitBranch: string | undefined,
  ): void {
    const ordinal = this.nextOrdinal++;
    this.pending = null;
    if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
      this.context.stats.promptsMissingTimestamp++;
      return;
    }
    const scoped = scopedCwd(cwd, this.context.roots, this.context.realpaths);
    if (!scoped) {
      this.outOfScope++;
      this.context.stats.promptsOutOfScope++;
      return;
    }
    this.inScope++;
    if (this.context.sinceMs !== null && Date.parse(timestamp) < this.context.sinceMs) return;
    const entry: PromptHistoryEntry = {
      provider: this.candidate.provider,
      sessionId: this.candidate.sessionId,
      ordinal,
      timestamp,
      text,
      cwd: scoped,
      ...(gitBranch ? { gitBranch } : {}),
    };
    this.entries.push(entry);
    this.pending = entry;
  }
}

function transcriptMessage(
  candidate: Candidate,
  record: Record<string, unknown>,
  role: string,
  content: CanonicalTranscriptBlock[],
  extra: Partial<CanonicalTranscriptMessage['source']>,
  eventIndex: number,
): CanonicalTranscriptMessage {
  return {
    role: 'user',
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
    content,
    text: content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n'),
    tools: [],
    commands: [],
    source: {
      provider: candidate.provider,
      sessionId: candidate.sessionId,
      originalRole: role,
      eventIndex,
      eventType: 'user',
      ...extra,
    },
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compactUsage(usage: PromptHistoryUsage): PromptHistoryUsage | undefined {
  const result: PromptHistoryUsage = {};
  for (const [key, value] of Object.entries(usage) as Array<[keyof PromptHistoryUsage, unknown]>) {
    if (typeof value === 'number') result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

class ClaudeLineScanner extends LineScanner {
  private lineIndex = 0;
  private answerId: string | null = null;

  accept(record: Record<string, unknown>): 'ok' {
    const index = this.lineIndex++;
    const message = record.message as Record<string, unknown> | undefined;
    if (typeof message !== 'object' || message === null) return 'ok';

    if (record.type === 'user') {
      const origin = record.origin as { kind?: unknown } | undefined;
      const canonical = transcriptMessage(
        this.candidate,
        record,
        typeof message.role === 'string' ? message.role : 'user',
        claudeBlocks(message.content),
        {
          entrypoint: stringField(record.entrypoint),
          isMeta: record.isMeta === true ? true : undefined,
          isSidechain: record.isSidechain === true ? true : undefined,
          isCompactSummary: record.isCompactSummary === true ? true : undefined,
          originKind:
            origin && typeof origin.kind === 'string' ? (origin.kind as string) : undefined,
          promptSource: stringField(record.promptSource),
        },
        index,
      );
      const text = humanPromptText(canonical, 'claude-code');
      if (text === null) return 'ok';
      this.answerId = null;
      this.recordPrompt(text, record.timestamp, record.cwd, stringField(record.gitBranch));
      return 'ok';
    }

    if (record.type === 'assistant' && this.pending && record.isSidechain !== true) {
      const id = stringField(message.id) ?? `line:${index}`;
      if (this.answerId === null) this.answerId = id;
      if (id !== this.answerId) {
        this.pending = null;
        return 'ok';
      }
      const model = stringField(message.model);
      if (model && model !== '<synthetic>') this.pending.model = model;
      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        const mapped = compactUsage({
          inputTokens: tokenCount(usage.input_tokens),
          outputTokens: tokenCount(usage.output_tokens),
          cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
          cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
        });
        if (mapped) this.pending.usage = mapped;
      }
    }
    return 'ok';
  }
}

function claudeBlocks(content: unknown): CanonicalTranscriptBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: CanonicalTranscriptBlock[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_result') {
      blocks.push({ type: 'tool_result' });
    } else if (block.type === 'image') {
      blocks.push({ type: 'image' });
    } else {
      blocks.push({ type: 'unknown' });
    }
  }
  return blocks;
}

class CodexLineScanner extends LineScanner {
  private lineIndex = 0;
  private readonly resumeState: PromptHistoryResumeState;

  constructor(
    candidate: Candidate,
    resume: PromptHistoryCursorSession | undefined,
    context: ScanContext,
  ) {
    super(candidate, resume, context);
    this.resumeState = { ...(resume?.state ?? {}) };
  }

  protected override state(): PromptHistoryResumeState {
    return { ...this.resumeState };
  }

  accept(record: Record<string, unknown>): 'ok' | 'excluded' {
    const index = this.lineIndex++;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (typeof payload !== 'object' || payload === null) return 'ok';
    const state = this.resumeState;

    if (record.type === 'session_meta') {
      // Forked sessions embed their parent's session_meta after their own; only the first counts.
      if (state.meta) return 'ok';
      state.meta = true;
      const source = typeof payload.source === 'string' ? payload.source : null;
      if (!source || !HUMAN_CODEX_SOURCES.includes(source) || stringField(payload.forked_from_id)) {
        state.excluded = true;
        return 'excluded';
      }
      state.cwd = stringField(payload.cwd);
      const git = payload.git as { branch?: unknown } | undefined;
      state.gitBranch = git && typeof git === 'object' ? stringField(git.branch) : undefined;
      return 'ok';
    }

    if (record.type === 'turn_context') {
      const cwd = stringField(payload.cwd);
      if (cwd) state.cwd = cwd;
      const model = stringField(payload.model);
      if (model) state.model = model;
      return 'ok';
    }

    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      // Without session metadata the source (and thus interactivity) is unknown: fail closed.
      if (!state.meta) {
        state.excluded = true;
        return 'excluded';
      }
      const canonical = transcriptMessage(
        this.candidate,
        record,
        'user',
        codexBlocks(payload.content),
        {},
        index,
      );
      const text = humanPromptText(canonical, 'codex');
      if (text === null) return 'ok';
      this.recordPrompt(text, record.timestamp, state.cwd, state.gitBranch);
      return 'ok';
    }

    if (record.type === 'event_msg' && payload.type === 'token_count' && this.pending) {
      const info = payload.info as { last_token_usage?: Record<string, unknown> } | null;
      const last = info && typeof info === 'object' ? info.last_token_usage : undefined;
      if (!last || typeof last !== 'object') return 'ok';
      const input = tokenCount(last.input_tokens);
      const cached = tokenCount(last.cached_input_tokens);
      const mapped = compactUsage({
        inputTokens: input !== undefined ? Math.max(0, input - (cached ?? 0)) : undefined,
        outputTokens: tokenCount(last.output_tokens),
        cacheReadTokens: cached,
        cacheWriteTokens: tokenCount(last.cache_write_input_tokens),
      });
      if (mapped) this.pending.usage = mapped;
      if (state.model) this.pending.model = state.model;
      this.pending = null;
    }
    return 'ok';
  }
}

function codexBlocks(content: unknown): CanonicalTranscriptBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: CanonicalTranscriptBlock[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const block = item as Record<string, unknown>;
    if ((block.type === 'input_text' || block.type === 'text') && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'input_image') {
      blocks.push({ type: 'image' });
    } else {
      blocks.push({ type: 'unknown' });
    }
  }
  return blocks;
}
