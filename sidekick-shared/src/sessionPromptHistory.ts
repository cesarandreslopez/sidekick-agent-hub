/**
 * Node-only whole-session view of prompt history: every human prompt of a
 * Claude Code or Codex session, grouped by session, for consumers that
 * classify a session as a whole (intent, conflict, issues).
 *
 * Sessions are read from the start with the same scanners as
 * `collectPromptHistory()`, so scope rules, prompt text, first-call model and
 * usage, and ordinals are identical. The replies and interaction signals that
 * the prompt filter leaves out are opt-in through `include`.
 *
 * There is no cursor: each call returns whole sessions. A bound that stops a
 * call lists the sessions it did not read in `unread`; passing them back as
 * `sessionIds` continues. Scope fails closed as in `collectPromptHistory()`,
 * and replies or signals that belong to an out-of-scope prompt are dropped.
 */

import * as fs from 'fs';
import {
  DEFAULT_BOUNDS,
  compareStrings,
  emptyStats,
  listCandidates,
  resolveRoots,
  scanFile,
  type Candidate,
  type FileOutcome,
  type PromptHistoryEntry,
  type PromptHistoryExclusion,
  type PromptHistoryProvider,
  type ScanContext,
} from './promptHistory';
import {
  createSessionRecordExtractor,
  type PromptHistoryReply,
  type PromptHistorySignal,
  type SessionRecordExtraction,
} from './sessionPromptSignals';

export interface SessionPromptHistoryInclude {
  /** Interrupts, rejected and failed tool calls, compactions, API errors, rollbacks. */
  signals?: boolean;
  /** The agent's last text for each prompt's turn. */
  replies?: boolean;
}

export interface SessionPromptHistoryBounds {
  /** Session files read in one call. Default 1000. */
  maxSessions?: number;
  /** Bytes read from one session; a longer session is returned `truncated`. Default 256 MiB. */
  maxSessionBytes?: number;
  /** Bytes read across all sessions in one call. Default 256 MiB. */
  maxTotalBytes?: number;
  /** Largest single log record that is parsed. Default 16 MiB. */
  maxRecordBytes?: number;
  /** Wall-clock budget for the call. Default 60 000 ms. */
  deadlineMs?: number;
}

export interface CollectSessionPromptHistoryOptions {
  /** Absolute workspace roots; realpath-normalized internally. */
  workspacePaths: string[];
  /** Add git worktree siblings of each root. Default true. */
  includeWorktrees?: boolean;
  /** Default both. */
  providers?: PromptHistoryProvider[];
  /** Only these sessions (exact ids). */
  sessionIds?: string[];
  /** Only sessions whose file changed at or after this. Each comes back whole. */
  since?: Date;
  /** Return at most this many sessions, most recently modified first. */
  limit?: number;
  /** Opt-in content beyond the prompts. */
  include?: SessionPromptHistoryInclude;
  bounds?: SessionPromptHistoryBounds;
  signal?: AbortSignal;
}

export interface PromptHistorySessionPrompt extends Omit<
  PromptHistoryEntry,
  'provider' | 'sessionId'
> {
  /** With `include.replies`: the agent's last text for this prompt's turn. */
  reply?: PromptHistoryReply;
}

export interface PromptHistorySession {
  provider: PromptHistoryProvider;
  sessionId: string;
  /** Earliest timestamp in the session log. */
  startedAt: string;
  /** Latest timestamp in the session log. */
  lastActivityAt: string;
  /** Distinct prompt working directories, in order of first use. */
  cwds: string[];
  /** Distinct prompt git branches, in order of first use. */
  gitBranches: string[];
  /** Distinct models that answered a prompt, in order of first use. */
  models: string[];
  /** Every human prompt in scope, by ordinal. */
  prompts: PromptHistorySessionPrompt[];
  /** With `include.signals`: interaction signals in log order. */
  signals?: PromptHistorySignal[];
  /** Read to the end with no dropped prompts and no excluded records. */
  complete: boolean;
  /** `maxSessionBytes` stopped the read; later prompts are missing. */
  truncated: boolean;
  /** Prompts left out because their cwd was out of scope or they had no timestamp. */
  droppedPrompts: number;
  /** Records left out as oversized or malformed (see `exclusions`). */
  excludedRecords: number;
}

export interface PromptHistorySessionRef {
  provider: PromptHistoryProvider;
  sessionId: string;
}

export type SessionPromptHistoryBound =
  | 'maxSessions'
  | 'maxSessionBytes'
  | 'maxTotalBytes'
  | 'deadline'
  | 'aborted';

export interface SessionPromptHistoryStats {
  /** Session files that matched the provider, id, and `since` filters. */
  sessionsMatched: number;
  sessionsScanned: number;
  sessionsReturned: number;
  /** Scanned sessions with no human prompt at all. */
  sessionsWithoutPrompts: number;
  /** Scanned sessions with human prompts but none inside the allowed roots. */
  sessionsOutOfScope: number;
  /** Codex sessions skipped as non-interactive (subagent, fork, unknown source). */
  sessionsNotInteractive: number;
  sessionsTruncated: number;
  recordsOverSizeLimit: number;
  recordsMalformed: number;
  promptsMissingTimestamp: number;
  promptsOutOfScope: number;
}

export interface SessionPromptHistoryResult {
  /** Most recent activity first. */
  sessions: PromptHistorySession[];
  /** Sessions a bound kept this call from reading; pass them as `sessionIds` to continue. */
  unread: PromptHistorySessionRef[];
  boundsHit: SessionPromptHistoryBound[];
  /** Permanent exclusions found in this call (at most 1000; stats count all). */
  exclusions: PromptHistoryExclusion[];
  stats: SessionPromptHistoryStats;
}

const DEFAULT_SESSION_BOUNDS: Required<SessionPromptHistoryBounds> = {
  maxSessions: 1000,
  maxSessionBytes: 256 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRecordBytes: DEFAULT_BOUNDS.maxRecordBytes,
  deadlineMs: 60_000,
};

const MAX_EXCLUSIONS = 1000;

interface StatedCandidate {
  candidate: Candidate;
  stat: fs.Stats;
}

/** Collect every human prompt of each matching session, grouped by session. */
export async function collectSessionPromptHistory(
  options: CollectSessionPromptHistoryOptions,
): Promise<SessionPromptHistoryResult> {
  const bounds = { ...DEFAULT_SESSION_BOUNDS, ...definedBounds(options.bounds) };
  const include = {
    signals: options.include?.signals === true,
    replies: options.include?.replies === true,
  };
  const startedAt = Date.now();
  const sessions: PromptHistorySession[] = [];
  const unread: PromptHistorySessionRef[] = [];
  const boundsHit = new Set<SessionPromptHistoryBound>();
  const exclusions: PromptHistoryExclusion[] = [];
  const scanStats = emptyStats();
  const stats: SessionPromptHistoryStats = {
    sessionsMatched: 0,
    sessionsScanned: 0,
    sessionsReturned: 0,
    sessionsWithoutPrompts: 0,
    sessionsOutOfScope: 0,
    sessionsNotInteractive: 0,
    sessionsTruncated: 0,
    recordsOverSizeLimit: 0,
    recordsMalformed: 0,
    promptsMissingTimestamp: 0,
    promptsOutOfScope: 0,
  };
  const finish = (): SessionPromptHistoryResult => {
    stats.sessionsReturned = sessions.length;
    stats.recordsOverSizeLimit = scanStats.recordsOverSizeLimit;
    stats.recordsMalformed = scanStats.recordsMalformed;
    stats.promptsMissingTimestamp = scanStats.promptsMissingTimestamp;
    stats.promptsOutOfScope = scanStats.promptsOutOfScope;
    return {
      sessions: sessions.sort(compareSessions),
      unread,
      boundsHit: [...boundsHit],
      exclusions,
      stats,
    };
  };

  const realpaths = new Map<string, string | null>();
  const { roots, listingRoots } = resolveRoots(
    options.workspacePaths,
    options.includeWorktrees !== false,
    realpaths,
  );
  if (roots.length === 0) return finish();

  const selected = await selectCandidates(options, listingRoots);
  stats.sessionsMatched = selected.length;
  const limit =
    typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : Infinity;

  const shouldStop = (): 'deadline' | 'aborted' | null => {
    if (options.signal?.aborted) return 'aborted';
    if (Date.now() - startedAt >= bounds.deadlineMs) return 'deadline';
    return null;
  };
  const refOf = ({ candidate }: StatedCandidate): PromptHistorySessionRef => ({
    provider: candidate.provider,
    sessionId: candidate.sessionId,
  });
  let totalBytes = 0;

  for (let index = 0; index < selected.length && sessions.length < limit; index++) {
    const item = selected[index];
    const stopAt = (bound: SessionPromptHistoryBound, fromIndex: number): void => {
      boundsHit.add(bound);
      unread.push(...selected.slice(fromIndex).map(refOf));
    };
    const stop = shouldStop();
    if (stop) {
      stopAt(stop, index);
      break;
    }
    if (stats.sessionsScanned >= bounds.maxSessions) {
      stopAt('maxSessions', index);
      break;
    }
    const remainingTotal = bounds.maxTotalBytes - totalBytes;
    if (stats.sessionsScanned > 0 && remainingTotal <= 0) {
      stopAt('maxTotalBytes', index);
      break;
    }

    let excludedRecords = 0;
    const extractor = createSessionRecordExtractor(item.candidate.provider, include);
    const context: ScanContext = {
      roots,
      // Sessions come back whole: `since` only selects files.
      sinceMs: null,
      stats: scanStats,
      realpaths,
      bounds: {
        ...DEFAULT_BOUNDS,
        maxRecordBytes: bounds.maxRecordBytes,
        maxEntries: Number.MAX_SAFE_INTEGER,
      },
      shouldStop,
      entriesSoFar: () => 0,
      exclude: (exclusion) => {
        excludedRecords++;
        if (exclusions.length < MAX_EXCLUSIONS) exclusions.push(exclusion);
      },
      observe: (record, info) => extractor.observe(record, info),
    };
    const sessionLimited = bounds.maxSessionBytes <= remainingTotal;
    stats.sessionsScanned++;
    let outcome: FileOutcome;
    try {
      outcome = await scanFile(
        item.candidate,
        item.stat,
        undefined,
        {
          bytes: sessionLimited ? bounds.maxSessionBytes : Math.max(0, remainingTotal),
          bound: sessionLimited ? 'maxFileBytes' : 'maxTotalBytes',
          forceProgress: true,
        },
        context,
      );
    } catch {
      // Changed while opening or verifying it: a later call can read it again.
      unread.push(refOf(item));
      continue;
    }
    totalBytes += outcome.bytesRead;

    if (outcome.notInteractive) {
      stats.sessionsNotInteractive++;
      continue;
    }
    const stoppedBy = outcome.stoppedBy;
    if (stoppedBy === 'deadline' || stoppedBy === 'aborted' || stoppedBy === 'maxTotalBytes') {
      // A partial read cannot be resumed without a cursor: read it whole next call.
      stopAt(stoppedBy, index);
      break;
    }
    if (!outcome.session || (outcome.session.backlog && stoppedBy === null)) {
      // Truncated or rewritten while it was being read.
      unread.push(refOf(item));
      continue;
    }
    if (outcome.inScope === 0) {
      if (outcome.outOfScope > 0) stats.sessionsOutOfScope++;
      else stats.sessionsWithoutPrompts++;
      continue;
    }

    const truncated = stoppedBy === 'maxFileBytes';
    if (truncated) {
      boundsHit.add('maxSessionBytes');
      stats.sessionsTruncated++;
    }
    sessions.push(
      buildSession(
        item.candidate,
        outcome.entries,
        outcome.session.lastOrdinal,
        extractor.result(),
        include,
        { truncated, excludedRecords },
      ),
    );
  }

  return finish();
}

function definedBounds(bounds: SessionPromptHistoryBounds | undefined): SessionPromptHistoryBounds {
  const result: SessionPromptHistoryBounds = {};
  if (!bounds) return result;
  for (const key of Object.keys(DEFAULT_SESSION_BOUNDS) as Array<
    keyof SessionPromptHistoryBounds
  >) {
    const value = bounds[key];
    if (typeof value === 'number' && !Number.isNaN(value)) result[key] = Math.max(0, value);
  }
  return result;
}

/** Matching session files, most recently modified first. */
async function selectCandidates(
  options: CollectSessionPromptHistoryOptions,
  listingRoots: string[],
): Promise<StatedCandidate[]> {
  const sinceMs = options.since ? options.since.getTime() : null;
  const providers = options.providers ?? ['claude-code', 'codex'];
  let candidates = await listCandidates(providers, listingRoots, sinceMs);
  if (options.sessionIds) {
    const wanted = new Set(options.sessionIds);
    candidates = candidates.filter((candidate) => wanted.has(candidate.sessionId));
  }
  const selected: StatedCandidate[] = [];
  for (const candidate of candidates) {
    try {
      selected.push({ candidate, stat: await fs.promises.stat(candidate.filePath) });
    } catch {
      // Gone since it was listed.
    }
  }
  return selected.sort(
    (left, right) =>
      right.stat.mtimeMs - left.stat.mtimeMs ||
      compareStrings(left.candidate.key, right.candidate.key),
  );
}

function buildSession(
  candidate: Candidate,
  entries: PromptHistoryEntry[],
  lastOrdinal: number,
  extraction: SessionRecordExtraction,
  include: { signals: boolean; replies: boolean },
  read: { truncated: boolean; excludedRecords: number },
): PromptHistorySession {
  const ordered = [...entries].sort((left, right) => left.ordinal - right.ordinal);
  const returned = new Set(ordered.map((entry) => entry.ordinal));
  const prompts = ordered.map(({ provider: _provider, sessionId: _sessionId, ...prompt }) => {
    const reply = include.replies ? extraction.replies.get(prompt.ordinal) : undefined;
    return reply ? { ...prompt, reply } : prompt;
  });
  const droppedPrompts = Math.max(0, lastOrdinal + 1 - ordered.length);
  const session: PromptHistorySession = {
    provider: candidate.provider,
    sessionId: candidate.sessionId,
    startedAt: extraction.firstTimestamp ?? ordered[0].timestamp,
    lastActivityAt: extraction.lastTimestamp ?? ordered[ordered.length - 1].timestamp,
    cwds: distinct(ordered.map((entry) => entry.cwd)),
    gitBranches: distinct(ordered.map((entry) => entry.gitBranch)),
    models: distinct(ordered.map((entry) => entry.model)),
    prompts,
    complete: !read.truncated && droppedPrompts === 0 && read.excludedRecords === 0,
    truncated: read.truncated,
    droppedPrompts,
    excludedRecords: read.excludedRecords,
  };
  if (include.signals) {
    // Fail closed: nothing that followed an out-of-scope prompt is returned.
    session.signals = extraction.signals.filter(
      (signal) => signal.afterOrdinal === -1 || returned.has(signal.afterOrdinal),
    );
  }
  return session;
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

function compareSessions(left: PromptHistorySession, right: PromptHistorySession): number {
  return (
    Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) ||
    compareStrings(left.provider, right.provider) ||
    compareStrings(left.sessionId, right.sessionId)
  );
}
