/**
 * Node-only collection of human-typed prompts from Claude Code and Codex
 * session logs, scoped to a set of workspace roots.
 *
 * Parse-only: no redaction and no network I/O. Scope fails closed — a prompt
 * is returned only when the working directory recorded on its log line (or,
 * for Codex, its session/turn context) realpath-resolves to an allowed root
 * or somewhere inside one. Every bound stops cleanly and is reported in
 * `boundsHit`; nothing is silently truncated and no bound throws.
 *
 * Files are streamed in fixed-size chunks and every pass stops at a complete
 * line, so a large or busy log is read across several calls: the cursor holds
 * where each file stopped and the next call continues from there. A single
 * record over `maxRecordBytes` is skipped without being buffered and reported
 * in `exclusions`, the only way a record is permanently left out.
 *
 * A prompt can be written before its answer. The cursor then keeps the byte
 * offset of that prompt's line and its answer-tracking state (never text), and
 * the prompt is returned again under the same identity once its first
 * answering call brings model or usage (`metadataStatus` says how settled).
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
  | 'maxEntries'
  | 'deadline'
  | 'aborted';

export interface PromptHistoryBounds {
  /** Session files read in one call (unchanged files do not count). Default 1000. */
  maxSessions?: number;
  /**
   * Bytes read from one file in one call. Default 16 MiB. A file with more to
   * read stops at a line boundary and continues on the next call.
   */
  maxFileBytes?: number;
  /** Bytes read across all files in this call. Default 256 MiB. */
  maxTotalBytes?: number;
  /**
   * Largest single log record that is parsed. Default 16 MiB. A longer record
   * is skipped without being buffered and reported in `exclusions`.
   */
  maxRecordBytes?: number;
  /** Entries returned by one call. Default 10 000. */
  maxEntries?: number;
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

/** Answer metadata gathered so far for an open prompt; never text. */
export interface PromptHistoryAnswerState {
  status: 'pending' | 'provisional';
  /** Claude message id of the first answering call, once one has been seen. */
  id?: string;
  model?: string;
  usage?: PromptHistoryUsage;
}

/**
 * The last emitted prompt of a file whose answering call is not final yet.
 * Holds a position and answer metadata, never prompt or answer text.
 */
export interface PromptHistoryPendingPrompt {
  ordinal: number;
  /** Byte offset where the prompt's log line starts. */
  offset: number;
  /** Byte length of the prompt's log line, without its newline. */
  lineBytes?: number;
  /** Timestamp of the prompt line, used to verify it when it is read again. */
  timestamp?: string;
  /** Digest of the model, usage, and status last returned for this prompt. */
  emitted: string;
  /** Codex parse state as it was just before the prompt line. */
  state?: PromptHistoryResumeState;
  /**
   * Answer tracking to continue from the session offset. Absent only on a
   * session carried unchanged from a version 2 cursor, which replays from
   * `offset` the next time it is read.
   */
  answer?: PromptHistoryAnswerState;
}

export interface PromptHistoryCursorSession {
  provider: PromptHistoryProvider;
  sessionId: string;
  size: number;
  mtimeMs: number;
  /** Ordinal of the last human prompt seen in this file, or -1 when none. */
  lastOrdinal: number;
  /** Byte offset where the next pass starts reading. */
  offset: number;
  state?: PromptHistoryResumeState;
  pending?: PromptHistoryPendingPrompt;
  /** A bound stopped the last pass before the end of the file. */
  backlog?: true;
  /** `offset` is inside a record over `maxRecordBytes`; skip to its newline. */
  skipping?: true;
  /** Digest of the file's first bytes, used to detect a rewritten file. */
  head?: { bytes: number; hash: string };
}

/**
 * JSON-serializable resume point. Keys are opaque and never contain paths, but
 * values can (Codex `state.cwd`), so treat the cursor as sensitive local state.
 * Version 1 and 2 cursors are accepted as input; output is always version 3.
 */
export interface PromptHistoryCursor {
  version: 3;
  sessions: Record<string, PromptHistoryCursorSession>;
  /** Opaque key of the file the next call starts with, after a call-wide stop. */
  next?: string;
}

/**
 * How settled an entry's `model` / `usage` are:
 * - `pending`: no answering call seen yet.
 * - `provisional`: the first answering call is still being written (Claude
 *   `stop_reason: null`); values may change.
 * - `final`: the first answering call is complete, or the prompt was closed
 *   without one. Missing usage is then unknown, not zero.
 */
export type PromptHistoryMetadataStatus = 'pending' | 'provisional' | 'final';

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
  /**
   * Whether `model` / `usage` can still change. A prompt that is not `final`
   * is returned again, with the same provider, sessionId, ordinal, timestamp,
   * and text, by a later call once its metadata or status changes.
   */
  metadataStatus: PromptHistoryMetadataStatus;
}

/**
 * A log record permanently left out. Records over `maxRecordBytes` and lines
 * that are not valid JSON are never parsed, so any prompt inside is lost, and
 * the ordinals of later prompts in that file do not count it.
 */
export interface PromptHistoryExclusion {
  provider: PromptHistoryProvider;
  sessionId: string;
  reason: 'oversizedRecord' | 'malformedRecord';
  /** Byte offset where the record starts. */
  offset: number;
}

export interface PromptHistoryStats {
  sessionsScanned: number;
  sessionsSkippedUnchanged: number;
  /** Scanned sessions with human prompts but none inside the allowed roots. */
  sessionsOutOfScope: number;
  /** Files whose `maxFileBytes` budget ran out; they continue on the next call. */
  filesOverSizeLimit: number;
  /** Scanned sessions left with unread bytes by any bound; they continue next call. */
  sessionsWithBacklog: number;
  /** Sessions whose file was truncated or rewritten and was read again from the start. */
  sessionsRewritten: number;
  /** Codex sessions skipped as non-interactive (subagent, fork, unknown source). */
  sessionsNotInteractive: number;
  /** Records skipped for exceeding `maxRecordBytes` (see `exclusions`). */
  recordsOverSizeLimit: number;
  /** Complete lines that were not valid JSON (see `exclusions`). */
  recordsMalformed: number;
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
  /** Resumable stops: calling again with the returned cursor continues past them. */
  boundsHit: PromptHistoryBound[];
  /** Permanent exclusions found in this call (at most 1000; stats count all). */
  exclusions: PromptHistoryExclusion[];
  /** A bound left bytes or files unread; call again with the cursor to continue. */
  hasMore: boolean;
}

const DEFAULT_BOUNDS: Required<PromptHistoryBounds> = {
  maxSessions: 1000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRecordBytes: 16 * 1024 * 1024,
  maxEntries: 10_000,
  deadlineMs: 30_000,
};

const DEFAULT_READ_CHUNK_BYTES = 1024 * 1024;
const HEAD_BYTES = 4096;
const MAX_EXCLUSIONS = 1000;
const CHECK_EVERY_LINES = 500;
const ALL_PROVIDERS: PromptHistoryProvider[] = ['claude-code', 'codex'];

let readChunkBytes = DEFAULT_READ_CHUNK_BYTES;

/** Test hooks; not part of the public entry points. */
export const __promptHistoryTesting = {
  setReadChunkBytes(bytes: number | null): void {
    readChunkBytes = bytes === null ? DEFAULT_READ_CHUNK_BYTES : Math.max(1, Math.floor(bytes));
  },
};

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
  bounds: Required<PromptHistoryBounds>;
  shouldStop: () => PromptHistoryBound | null;
  /** Entries already collected from earlier files in this call. */
  entriesSoFar: () => number;
  exclude: (exclusion: PromptHistoryExclusion) => void;
}

interface FileBudget {
  bytes: number;
  /** Which bound `bytes` came from. */
  bound: 'maxFileBytes' | 'maxTotalBytes';
  /** First file of the call: may finish its first record even past the budget. */
  forceProgress: boolean;
}

interface FileOutcome {
  entries: PromptHistoryEntry[];
  /** The pass moved the file's offset forward. */
  progressed: boolean;
  /** New cursor state, or undefined to drop it (rewrite found mid-pass). */
  session: PromptHistoryCursorSession | undefined;
  bytesRead: number;
  stoppedBy: PromptHistoryBound | null;
  notInteractive: boolean;
  inScope: number;
  outOfScope: number;
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
    sessionsWithBacklog: 0,
    sessionsRewritten: 0,
    sessionsNotInteractive: 0,
    recordsOverSizeLimit: 0,
    recordsMalformed: 0,
    promptsMissingTimestamp: 0,
    promptsOutOfScope: 0,
  };
  const { sessions: previous, next: previousNext } = acceptedCursor(options.cursor);
  const cursor: PromptHistoryCursor = { version: 3, sessions: { ...previous } };
  const entries: PromptHistoryEntry[] = [];
  const exclusions: PromptHistoryExclusion[] = [];
  let hasMore = false;

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
    exclusions,
    hasMore,
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
  const candidates = rotate(await listCandidates(providers, listingRoots, sinceMs), previousNext);

  const context: ScanContext = {
    roots,
    sinceMs,
    stats,
    realpaths,
    bounds,
    shouldStop,
    entriesSoFar: () => entries.length,
    exclude: (exclusion) => {
      if (exclusions.length < MAX_EXCLUSIONS) exclusions.push(exclusion);
    },
  };
  let totalBytes = 0;
  let scannedAny = false;

  // A call-wide stop remembers where it stopped so the next call starts there.
  const stopAt = (candidate: Candidate, bound: PromptHistoryBound): void => {
    boundsHit.add(bound);
    cursor.next = candidate.key;
    hasMore = true;
  };

  for (const candidate of candidates) {
    const stop = shouldStop();
    if (stop) {
      stopAt(candidate, stop);
      break;
    }
    if (scannedAny && entries.length >= bounds.maxEntries) {
      stopAt(candidate, 'maxEntries');
      break;
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(candidate.filePath);
    } catch {
      continue;
    }
    const prior = validSession(previous[candidate.key]);
    if (prior && isSettled(prior) && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
      stats.sessionsSkippedUnchanged++;
      continue;
    }
    if (stats.sessionsScanned >= bounds.maxSessions) {
      stopAt(candidate, 'maxSessions');
      break;
    }
    const remainingTotal = bounds.maxTotalBytes - totalBytes;
    if (scannedAny && remainingTotal <= 0) {
      stopAt(candidate, 'maxTotalBytes');
      break;
    }
    const budget: FileBudget =
      bounds.maxFileBytes <= remainingTotal
        ? { bytes: bounds.maxFileBytes, bound: 'maxFileBytes', forceProgress: !scannedAny }
        : {
            bytes: Math.max(0, remainingTotal),
            bound: 'maxTotalBytes',
            forceProgress: !scannedAny,
          };

    stats.sessionsScanned++;
    scannedAny = true;
    let outcome: FileOutcome;
    try {
      outcome = await scanFile(candidate, stat, prior, budget, context);
    } catch {
      continue;
    }
    totalBytes += outcome.bytesRead;
    entries.push(...outcome.entries);
    if (outcome.notInteractive) stats.sessionsNotInteractive++;
    else if (outcome.inScope === 0 && outcome.outOfScope > 0) stats.sessionsOutOfScope++;

    if (outcome.session) {
      cursor.sessions[candidate.key] = outcome.session;
      if (outcome.session.backlog) stats.sessionsWithBacklog++;
    } else {
      // Rewritten under us: forget the file so the next call reads it from the start.
      delete cursor.sessions[candidate.key];
      stats.sessionsRewritten++;
      hasMore = true;
    }

    if (outcome.stoppedBy === 'maxFileBytes' && outcome.progressed) {
      // Per-file budget: move on so one large file cannot starve the others.
      boundsHit.add('maxFileBytes');
      stats.filesOverSizeLimit++;
      hasMore = true;
    } else if (outcome.stoppedBy) {
      // A file that could not move within its budget starts the next call, where
      // the first file may always finish its first record.
      if (outcome.stoppedBy === 'maxFileBytes') stats.filesOverSizeLimit++;
      stopAt(candidate, outcome.stoppedBy);
      break;
    }
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

function acceptedCursor(
  cursor: PromptHistoryCursor | { version: number; sessions?: unknown; next?: unknown } | undefined,
): { sessions: Record<string, PromptHistoryCursorSession>; next?: string } {
  if (!cursor || ![1, 2, 3].includes(cursor.version)) return { sessions: {} };
  const sessions = cursor.sessions;
  return {
    sessions:
      typeof sessions === 'object' && sessions !== null
        ? (sessions as Record<string, PromptHistoryCursorSession>)
        : {},
    ...(typeof cursor.next === 'string' ? { next: cursor.next } : {}),
  };
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validSession(
  session: PromptHistoryCursorSession | undefined,
): PromptHistoryCursorSession | undefined {
  if (!session || typeof session !== 'object') return undefined;
  const valid =
    isOffset(session.offset) &&
    Number.isInteger(session.lastOrdinal) &&
    session.lastOrdinal >= -1 &&
    typeof session.size === 'number' &&
    typeof session.mtimeMs === 'number';
  return valid ? session : undefined;
}

/** A session whose last pass reached the end and needs no migration. */
function isSettled(session: PromptHistoryCursorSession): boolean {
  if (session.backlog || session.skipping) return false;
  if (session.state?.excluded) return true;
  if (!session.head) return false;
  return !session.pending || session.pending.answer !== undefined;
}

type ResumePlan =
  | { kind: 'fresh' }
  | { kind: 'continue'; session: PromptHistoryCursorSession; carried?: PromptHistoryPendingPrompt }
  /** Version 2 pending prompt: replay from its line as 0.27.1 did, but resumably. */
  | { kind: 'replay'; session: PromptHistoryCursorSession; pending: PromptHistoryPendingPrompt };

function resumePlan(session: PromptHistoryCursorSession | undefined): ResumePlan {
  if (!session) return { kind: 'fresh' };
  const pending = session.pending;
  if (!pending) return { kind: 'continue', session };
  const basic =
    Number.isInteger(pending.ordinal) &&
    pending.ordinal === session.lastOrdinal &&
    isOffset(pending.offset) &&
    pending.offset <= session.offset &&
    typeof pending.emitted === 'string';
  if (!basic) return { kind: 'continue', session };
  const answer = pending.answer;
  if (answer === undefined) {
    return session.skipping ? { kind: 'continue', session } : { kind: 'replay', session, pending };
  }
  const carried =
    typeof answer === 'object' &&
    answer !== null &&
    (answer.status === 'pending' || answer.status === 'provisional') &&
    isOffset(pending.lineBytes) &&
    pending.offset + pending.lineBytes < session.offset &&
    typeof pending.timestamp === 'string';
  return carried ? { kind: 'continue', session, carried: pending } : { kind: 'continue', session };
}

/** Digest of what a consumer would store for an entry besides its identity and text. */
function metadataDigest(
  entry: Pick<PromptHistoryEntry, 'model' | 'usage' | 'metadataStatus'>,
): string {
  const usage = entry.usage
    ? [
        entry.usage.inputTokens ?? null,
        entry.usage.outputTokens ?? null,
        entry.usage.cacheReadTokens ?? null,
        entry.usage.cacheWriteTokens ?? null,
      ]
    : null;
  return createHash('sha256')
    .update(JSON.stringify([entry.model ?? null, usage, entry.metadataStatus]))
    .digest('hex')
    .slice(0, 16);
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

function rotate(candidates: Candidate[], nextKey: string | undefined): Candidate[] {
  const index = nextKey ? candidates.findIndex((candidate) => candidate.key === nextKey) : -1;
  return index <= 0 ? candidates : [...candidates.slice(index), ...candidates.slice(0, index)];
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

function hashBytes(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

async function readAt(
  handle: fs.promises.FileHandle,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Checks that the prefix and resume point recorded for a file still hold.
 * Returns the head to store, or null when the file was truncated or rewritten.
 */
async function verifyFile(
  handle: fs.promises.FileHandle,
  size: number,
  session: PromptHistoryCursorSession | undefined,
): Promise<{ head: { bytes: number; hash: string }; bytesRead: number } | null> {
  const headBytes = Math.min(HEAD_BYTES, size);
  const head = await readAt(handle, 0, headBytes);
  let bytesRead = head.length;
  if (head.length !== headBytes) return null;
  if (session) {
    if (session.offset > size) return null;
    const known = session.head;
    if (known) {
      if (!isOffset(known.bytes) || known.bytes > head.length) return null;
      if (hashBytes(head.subarray(0, known.bytes)) !== known.hash) return null;
    }
    if (session.offset > 0 && !session.skipping) {
      const before = await readAt(handle, session.offset - 1, 1);
      bytesRead += before.length;
      if (before.length !== 1 || before[0] !== 0x0a) return null;
    }
  }
  return { head: { bytes: head.length, hash: hashBytes(head) }, bytesRead };
}

async function scanFile(
  candidate: Candidate,
  stat: fs.Stats,
  prior: PromptHistoryCursorSession | undefined,
  budget: FileBudget,
  context: ScanContext,
): Promise<FileOutcome> {
  const handle = await fs.promises.open(candidate.filePath, 'r');
  try {
    let bytesRead = 0;
    const verified = await verifyFile(handle, stat.size, prior);
    let plan = resumePlan(prior);
    let head = verified?.head;
    if (verified) {
      bytesRead += verified.bytesRead;
    } else {
      // Offsets and ordinals of a rewritten file are meaningless: start over.
      if (prior) context.stats.sessionsRewritten++;
      plan = { kind: 'fresh' };
      const fresh = await verifyFile(handle, stat.size, undefined);
      if (!fresh) throw new Error('file changed while reading');
      bytesRead += fresh.bytesRead;
      head = fresh.head;
    }
    const session = plan.kind === 'fresh' ? undefined : plan.session;

    if (session?.state?.excluded) {
      return {
        entries: [],
        progressed: true,
        session: {
          provider: candidate.provider,
          sessionId: candidate.sessionId,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          lastOrdinal: session.lastOrdinal,
          offset: stat.size,
          state: session.state,
          ...(head ? { head } : {}),
        },
        bytesRead,
        stoppedBy: null,
        notInteractive: true,
        inScope: 0,
        outOfScope: 0,
      };
    }

    const scanner =
      candidate.provider === 'claude-code'
        ? new ClaudeLineScanner(candidate, plan, context)
        : new CodexLineScanner(candidate, plan, context);
    const startOffset =
      plan.kind === 'fresh'
        ? 0
        : plan.kind === 'replay'
          ? plan.pending.offset
          : plan.session.offset;
    const stream = await streamLines(
      handle,
      startOffset,
      stat.size,
      plan.kind === 'continue' && plan.session.skipping === true,
      budget,
      context,
      candidate,
      scanner,
    );
    bytesRead += stream.bytesRead;

    if (stream.excluded) {
      return {
        entries: [],
        progressed: true,
        session: {
          provider: candidate.provider,
          sessionId: candidate.sessionId,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          lastOrdinal: scanner.lastOrdinal(),
          offset: stat.size,
          state: scanner.resumeState() ?? { excluded: true },
          ...(head ? { head } : {}),
        },
        bytesRead,
        stoppedBy: null,
        notInteractive: true,
        inScope: 0,
        outOfScope: 0,
      };
    }

    const update = await scanner.carriedUpdate(handle);
    bytesRead += update.bytesRead;
    if (update.rewritten) {
      return {
        entries: [],
        progressed: false,
        session: undefined,
        bytesRead,
        stoppedBy: null,
        notInteractive: false,
        inScope: 0,
        outOfScope: 0,
      };
    }

    const entries = scanner.returnedEntries();
    if (update.entry) entries.push(update.entry);
    const state = scanner.resumeState();
    const pending = scanner.pendingPrompt();
    // A truncated read also keeps a backlog, so the next call re-verifies the file.
    const backlog = stream.offset < stat.size && (stream.stoppedBy !== null || stream.truncated);
    return {
      entries,
      progressed: stream.offset > startOffset || stream.skipping,
      session: {
        provider: candidate.provider,
        sessionId: candidate.sessionId,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        lastOrdinal: scanner.lastOrdinal(),
        offset: stream.offset,
        ...(state ? { state } : {}),
        ...(pending ? { pending } : {}),
        ...(backlog ? { backlog: true as const } : {}),
        ...(stream.skipping ? { skipping: true as const } : {}),
        ...(head ? { head } : {}),
      },
      bytesRead,
      stoppedBy: backlog ? stream.stoppedBy : null,
      notInteractive: false,
      inScope: scanner.inScopeCount(),
      outOfScope: scanner.outOfScopeCount(),
    };
  } finally {
    await handle.close();
  }
}

interface StreamResult {
  /** Where the next pass starts: after the last complete line, or inside a skipped record. */
  offset: number;
  skipping: boolean;
  bytesRead: number;
  stoppedBy: PromptHistoryBound | null;
  /** The file ended before the size it had when the pass began. */
  truncated: boolean;
  excluded: boolean;
}

/**
 * Feeds complete JSONL lines from `[start, end)` to the scanner in fixed-size
 * chunks. Lines split only at `\n`, which never occurs inside a multi-byte
 * UTF-8 sequence, so decoding whole lines is exact whatever the chunk edges.
 * A line longer than `maxRecordBytes` is dropped as it streams past.
 */
async function streamLines(
  handle: fs.promises.FileHandle,
  start: number,
  end: number,
  resumeSkipping: boolean,
  budget: FileBudget,
  context: ScanContext,
  candidate: Candidate,
  scanner: LineScanner,
): Promise<StreamResult> {
  const { maxRecordBytes, maxEntries } = context.bounds;
  const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(readChunkBytes, end - start || 1)));
  let position = start;
  let committed = start;
  let lineStart = start;
  let skipping = resumeSkipping;
  let pieces: Buffer[] = [];
  let pieceBytes = 0;
  let bytesRead = 0;
  let lines = 0;
  let stoppedBy: PromptHistoryBound | null = null;
  let truncated = false;
  // The first file of a call always finishes its first record, so no budget can stall it.
  const mayStop = (): boolean => !(budget.forceProgress && committed === start && !skipping);
  const result = (excluded = false): StreamResult => ({
    offset: skipping ? position : committed,
    skipping,
    bytesRead,
    stoppedBy,
    truncated,
    excluded,
  });

  while (position < end) {
    const stop = context.shouldStop();
    if (stop) {
      stoppedBy = stop;
      break;
    }
    const allowance = budget.bytes - bytesRead;
    if (allowance <= 0 && mayStop()) {
      stoppedBy = budget.bound;
      break;
    }
    const want = Math.min(chunk.length, end - position, allowance > 0 ? allowance : chunk.length);
    const { bytesRead: got } = await handle.read(chunk, 0, want, position);
    if (got === 0) {
      // Truncated while reading; the next call's verification sees the rewrite.
      truncated = true;
      break;
    }
    bytesRead += got;
    const view = chunk.subarray(0, got);
    let index = 0;
    while (index < got) {
      const newline = view.indexOf(0x0a, index);
      const segmentEnd = newline === -1 ? got : newline;
      if (!skipping) {
        const segmentBytes = segmentEnd - index;
        if (pieceBytes + segmentBytes > maxRecordBytes) {
          skipping = true;
          pieces = [];
          pieceBytes = 0;
          context.stats.recordsOverSizeLimit++;
          context.exclude({
            provider: candidate.provider,
            sessionId: candidate.sessionId,
            reason: 'oversizedRecord',
            offset: lineStart,
          });
        } else if (newline === -1 && segmentBytes > 0) {
          // The chunk buffer is reused, so a partial line keeps a copy.
          pieces.push(Buffer.from(view.subarray(index, segmentEnd)));
          pieceBytes += segmentBytes;
        }
      }
      if (newline === -1) break;

      if (skipping) {
        skipping = false;
      } else {
        let line: string;
        if (pieces.length === 0) {
          line = view.toString('utf8', index, newline);
        } else {
          pieces.push(view.subarray(index, newline));
          line = Buffer.concat(pieces).toString('utf8');
        }
        const lineOffset = lineStart;
        const lineBytes = position + newline - lineStart;
        if (acceptLine(line, lineOffset, lineBytes, scanner, context, candidate) === 'excluded') {
          committed = position + newline + 1;
          return result(true);
        }
      }
      pieces = [];
      pieceBytes = 0;
      index = newline + 1;
      committed = position + index;
      lineStart = committed;
      lines++;

      if (mayStop() && context.entriesSoFar() + scanner.entryCount() >= maxEntries) {
        stoppedBy = 'maxEntries';
        position += index;
        return result();
      }
      if (lines % CHECK_EVERY_LINES === 0) {
        await yieldToEventLoop();
        const stop = context.shouldStop();
        if (stop) {
          stoppedBy = stop;
          position += index;
          return result();
        }
      }
    }
    position += got;
  }
  return result();
}

function acceptLine(
  line: string,
  lineOffset: number,
  lineBytes: number,
  scanner: LineScanner,
  context: ScanContext,
  candidate: Candidate,
): 'ok' | 'excluded' {
  if (!line.trim()) return 'ok';
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    context.stats.recordsMalformed++;
    context.exclude({
      provider: candidate.provider,
      sessionId: candidate.sessionId,
      reason: 'malformedRecord',
      offset: lineOffset,
    });
    return 'ok';
  }
  if (typeof record !== 'object' || record === null) return 'ok';
  return scanner.accept(record as Record<string, unknown>, lineOffset, lineBytes);
}

/** An emitted prompt whose first answering call is not final yet. */
interface OpenPrompt {
  entry: PromptHistoryEntry;
  lineOffset: number;
  lineBytes: number;
  stateBefore?: PromptHistoryResumeState;
  /** Claude message id of the first answering call. */
  answerId: string | null;
  /** Set when the prompt was emitted by an earlier call; its text is not in memory. */
  carried?: { emitted: string };
}

interface CarriedUpdate {
  entry?: PromptHistoryEntry;
  bytesRead: number;
  /** The carried prompt's line no longer matches: the file was rewritten. */
  rewritten: boolean;
}

/** Shared per-file prompt bookkeeping for both providers. */
abstract class LineScanner {
  protected readonly entries: PromptHistoryEntry[] = [];
  protected nextOrdinal: number;
  protected inScope = 0;
  protected outOfScope = 0;
  /** Latest emitted prompt still collecting answer metadata. */
  protected open: OpenPrompt | null = null;
  /** The carried prompt once it has been closed during this pass. */
  private closedCarried: OpenPrompt | null = null;
  /** Version 2 replay: the prompt already returned with this digest is not returned again. */
  private readonly suppress: { ordinal: number; emitted: string } | null = null;

  constructor(
    protected readonly candidate: Candidate,
    plan: ResumePlan,
    protected readonly context: ScanContext,
  ) {
    if (plan.kind === 'fresh') {
      this.nextOrdinal = 0;
    } else if (plan.kind === 'replay') {
      this.nextOrdinal = plan.pending.ordinal;
      this.suppress = { ordinal: plan.pending.ordinal, emitted: plan.pending.emitted };
    } else {
      this.nextOrdinal = plan.session.lastOrdinal + 1;
      const carried = plan.carried;
      if (
        carried?.answer &&
        carried.lineBytes !== undefined &&
        carried.lineBytes <= context.bounds.maxRecordBytes &&
        carried.timestamp !== undefined
      ) {
        const answer = carried.answer;
        const usage = answer.usage ? compactUsage(answer.usage) : undefined;
        this.open = {
          entry: {
            provider: candidate.provider,
            sessionId: candidate.sessionId,
            ordinal: carried.ordinal,
            timestamp: carried.timestamp,
            text: '',
            cwd: '',
            ...(typeof answer.model === 'string' ? { model: answer.model } : {}),
            ...(usage ? { usage } : {}),
            metadataStatus: answer.status,
          },
          lineOffset: carried.offset,
          lineBytes: carried.lineBytes,
          ...(carried.state ? { stateBefore: { ...carried.state } } : {}),
          answerId: typeof answer.id === 'string' ? answer.id : null,
          carried: { emitted: carried.emitted },
        };
      }
    }
  }

  abstract accept(
    record: Record<string, unknown>,
    lineOffset: number,
    lineBytes: number,
  ): 'ok' | 'excluded';

  /** The prompt text of a record read back from a carried prompt's line, or null. */
  protected abstract promptTextOf(record: Record<string, unknown>): string | null;

  /** Recorded cwd and branch for a carried prompt's record. */
  protected abstract promptPlaceOf(
    record: Record<string, unknown>,
    stateBefore: PromptHistoryResumeState | undefined,
  ): { cwd: unknown; gitBranch?: string };

  resumeState(): PromptHistoryResumeState | undefined {
    return undefined;
  }

  lastOrdinal(): number {
    return this.nextOrdinal - 1;
  }

  entryCount(): number {
    return this.entries.length;
  }

  inScopeCount(): number {
    return this.inScope;
  }

  outOfScopeCount(): number {
    return this.outOfScope;
  }

  returnedEntries(): PromptHistoryEntry[] {
    const suppress = this.suppress;
    if (!suppress) return [...this.entries];
    // A replayed prompt is returned again only when its metadata changed.
    return this.entries.filter(
      (entry) => entry.ordinal !== suppress.ordinal || metadataDigest(entry) !== suppress.emitted,
    );
  }

  pendingPrompt(): PromptHistoryPendingPrompt | undefined {
    const open = this.open;
    if (!open) return undefined;
    const entry = open.entry;
    const status = entry.metadataStatus === 'provisional' ? 'provisional' : 'pending';
    const answer: PromptHistoryAnswerState = {
      status,
      ...(open.answerId !== null ? { id: open.answerId } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.usage ? { usage: { ...entry.usage } } : {}),
    };
    return {
      ordinal: entry.ordinal,
      offset: open.lineOffset,
      lineBytes: open.lineBytes,
      timestamp: entry.timestamp,
      emitted: metadataDigest(entry),
      ...(open.stateBefore ? { state: { ...open.stateBefore } } : {}),
      answer,
    };
  }

  /**
   * The carried prompt returned again when its metadata changed in this pass.
   * Its text is re-read from its own line, which must still match exactly.
   */
  async carriedUpdate(handle: fs.promises.FileHandle): Promise<CarriedUpdate> {
    const carried = this.closedCarried ?? (this.open?.carried ? this.open : null);
    if (!carried?.carried) return { bytesRead: 0, rewritten: false };
    const entry = carried.entry;
    if (metadataDigest(entry) === carried.carried.emitted)
      return { bytesRead: 0, rewritten: false };

    const raw = await readAt(handle, carried.lineOffset, carried.lineBytes + 1);
    const rewritten = { bytesRead: raw.length, rewritten: true };
    if (raw.length !== carried.lineBytes + 1 || raw[carried.lineBytes] !== 0x0a) return rewritten;
    let record: unknown;
    try {
      record = JSON.parse(raw.toString('utf8', 0, carried.lineBytes));
    } catch {
      return rewritten;
    }
    if (typeof record !== 'object' || record === null) return rewritten;
    const row = record as Record<string, unknown>;
    const text = this.promptTextOf(row);
    if (text === null || row.timestamp !== entry.timestamp) return rewritten;

    const place = this.promptPlaceOf(row, carried.stateBefore);
    const scoped = scopedCwd(place.cwd, this.context.roots, this.context.realpaths);
    if (!scoped) {
      // The directory no longer resolves inside the roots: fail closed.
      this.context.stats.promptsOutOfScope++;
      return { bytesRead: raw.length, rewritten: false };
    }
    if (carried === this.open) carried.carried = { emitted: metadataDigest(entry) };
    return {
      entry: {
        ...entry,
        text,
        cwd: scoped,
        ...(place.gitBranch ? { gitBranch: place.gitBranch } : {}),
        ...(entry.usage ? { usage: { ...entry.usage } } : {}),
      },
      bytesRead: raw.length,
      rewritten: false,
    };
  }

  /** The open prompt's answer is complete, or will never arrive. */
  protected closeOpen(): void {
    const open = this.open;
    if (!open) return;
    open.entry.metadataStatus = 'final';
    if (open.carried) this.closedCarried = open;
    this.open = null;
  }

  /** Assign an ordinal to a human prompt and emit it when in scope. */
  protected recordPrompt(
    text: string,
    timestamp: unknown,
    cwd: unknown,
    gitBranch: string | undefined,
    lineOffset: number,
    lineBytes: number,
    stateBefore?: PromptHistoryResumeState,
  ): void {
    const ordinal = this.nextOrdinal++;
    this.closeOpen();
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
      metadataStatus: 'pending',
    };
    this.entries.push(entry);
    this.open = {
      entry,
      lineOffset,
      lineBytes,
      answerId: null,
      ...(stateBefore ? { stateBefore } : {}),
    };
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

function claudeUserText(
  candidate: Candidate,
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  blocks: CanonicalTranscriptBlock[],
  eventIndex: number,
): string | null {
  const origin = record.origin as { kind?: unknown } | undefined;
  const canonical = transcriptMessage(
    candidate,
    record,
    typeof message.role === 'string' ? message.role : 'user',
    blocks,
    {
      entrypoint: stringField(record.entrypoint),
      isMeta: record.isMeta === true ? true : undefined,
      isSidechain: record.isSidechain === true ? true : undefined,
      isCompactSummary: record.isCompactSummary === true ? true : undefined,
      originKind: origin && typeof origin.kind === 'string' ? (origin.kind as string) : undefined,
      promptSource: stringField(record.promptSource),
    },
    eventIndex,
  );
  return humanPromptText(canonical, 'claude-code');
}

class ClaudeLineScanner extends LineScanner {
  private lineIndex = 0;

  protected override promptTextOf(record: Record<string, unknown>): string | null {
    const message = record.message as Record<string, unknown> | undefined;
    if (record.type !== 'user' || typeof message !== 'object' || message === null) return null;
    return claudeUserText(this.candidate, record, message, claudeBlocks(message.content), 0);
  }

  protected override promptPlaceOf(record: Record<string, unknown>): {
    cwd: unknown;
    gitBranch?: string;
  } {
    return { cwd: record.cwd, gitBranch: stringField(record.gitBranch) };
  }

  accept(record: Record<string, unknown>, lineOffset: number, lineBytes: number): 'ok' {
    const index = this.lineIndex++;
    const message = record.message as Record<string, unknown> | undefined;
    if (typeof message !== 'object' || message === null) return 'ok';

    if (record.type === 'user') {
      const blocks = claudeBlocks(message.content);
      const text = claudeUserText(this.candidate, record, message, blocks, index);
      if (text === null) {
        // A tool result means the first answering call already finished.
        if (
          this.open !== null &&
          this.open.answerId !== null &&
          record.isSidechain !== true &&
          blocks.some((block) => block.type === 'tool_result')
        ) {
          this.closeOpen();
        }
        return 'ok';
      }
      this.recordPrompt(
        text,
        record.timestamp,
        record.cwd,
        stringField(record.gitBranch),
        lineOffset,
        lineBytes,
      );
      return 'ok';
    }

    const open = this.open;
    if (record.type !== 'assistant' || !open || record.isSidechain === true) return 'ok';
    // Synthetic records (API errors, interrupts) are not model calls.
    if (message.model === '<synthetic>') return 'ok';
    const id = stringField(message.id) ?? `line:${lineOffset}`;
    if (open.answerId === null) open.answerId = id;
    if (id !== open.answerId) {
      // A later tool-loop call: the first answering call is over and keeps its attribution.
      this.closeOpen();
      return 'ok';
    }
    const entry = open.entry;
    const model = stringField(message.model);
    if (model) entry.model = model;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === 'object') {
      // Split records of one call repeat its usage; the latest replaces, never adds.
      const mapped = compactUsage({
        inputTokens: tokenCount(usage.input_tokens),
        outputTokens: tokenCount(usage.output_tokens),
        cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
        cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
      });
      if (mapped) entry.usage = mapped;
    }
    // Claude Code writes the call's final stop_reason and usage on every split record.
    if (stringField(message.stop_reason)) this.closeOpen();
    else entry.metadataStatus = 'provisional';
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
  private readonly state: PromptHistoryResumeState;

  constructor(candidate: Candidate, plan: ResumePlan, context: ScanContext) {
    super(candidate, plan, context);
    // A replay restarts at the open prompt's line, so it needs the state from just before it.
    const initial =
      plan.kind === 'replay'
        ? plan.pending.state
        : plan.kind === 'continue'
          ? plan.session.state
          : undefined;
    this.state = { ...(initial ?? {}) };
  }

  override resumeState(): PromptHistoryResumeState {
    return { ...this.state };
  }

  protected override promptTextOf(record: Record<string, unknown>): string | null {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!isCodexUserMessage(record, payload)) return null;
    const canonical = transcriptMessage(
      this.candidate,
      record,
      'user',
      codexBlocks((payload as Record<string, unknown>).content),
      {},
      0,
    );
    return humanPromptText(canonical, 'codex');
  }

  protected override promptPlaceOf(
    _record: Record<string, unknown>,
    stateBefore: PromptHistoryResumeState | undefined,
  ): { cwd: unknown; gitBranch?: string } {
    return { cwd: stateBefore?.cwd, gitBranch: stateBefore?.gitBranch };
  }

  accept(
    record: Record<string, unknown>,
    lineOffset: number,
    lineBytes: number,
  ): 'ok' | 'excluded' {
    const index = this.lineIndex++;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (typeof payload !== 'object' || payload === null) return 'ok';
    const state = this.state;

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

    if (isCodexUserMessage(record, payload)) {
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
      this.recordPrompt(text, record.timestamp, state.cwd, state.gitBranch, lineOffset, lineBytes, {
        ...state,
      });
      return 'ok';
    }

    const open = this.open;
    if (record.type === 'event_msg' && payload.type === 'token_count' && open) {
      // The first token_count after the prompt is the first answering call, complete.
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
      if (mapped) open.entry.usage = mapped;
      if (state.model) open.entry.model = state.model;
      this.closeOpen();
    }
    return 'ok';
  }
}

function isCodexUserMessage(
  record: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
): boolean {
  return (
    record.type === 'response_item' &&
    typeof payload === 'object' &&
    payload !== null &&
    payload.type === 'message' &&
    payload.role === 'user'
  );
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
