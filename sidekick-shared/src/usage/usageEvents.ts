/**
 * Usage events collected from session logs, cached per session.
 *
 * Feeds the billing-block view and the log-derived daily/weekly/monthly
 * reports, so CLI-only users get numbers without the extension's history
 * store. Each session is read once through its provider reader; the
 * extracted usage is cached under `<configDir>/usage-cache/` keyed by the
 * session's size and mtime, so a repeat run only re-reads sessions that
 * changed. Token counts are cached raw and priced at load time, so a pricing
 * catalog refresh never leaves stale costs behind. Cache files are touched on
 * every hit and pruned least-recently-used, once per collection.
 *
 * A Claude Code session's subagents write their own transcripts under
 * `<sessionId>/subagents/`; their usage is attributed to the parent session,
 * tagged with the subagent, and their sizes and mtimes join the fingerprint.
 * (Codex spawned subagents and forks are top-level rollouts, already listed
 * as sessions of their own; their events are tagged with the parent read
 * from the rollout's first line; the parent history a forked child embeds
 * is not counted (it carries no token usage). Compressed rollouts
 * (`….jsonl.zst`) are read when a Codex provider was created with
 * `includeCompressedRollouts`.)
 *
 * Each event also carries the ordinal of the human prompt it answered, from
 * the same scanner as `collectPromptHistory()`, so usage joins prompt history
 * on `(provider, sessionId, ordinal)`.
 *
 * Cache files are named per cache version (`<provider>--<session>.v3.json`)
 * so readers of different versions sharing the directory never overwrite each
 * other's files; pruning ages out every version's files alike.
 *
 * Node-only: reads session files and the cache directory.
 *
 * @module usage/usageEvents
 */

import * as fs from 'fs';
import * as path from 'path';
import { getClaudeSubagentsDir, parseClaudeSubagentFileName } from '../claudePaths';
import { getConfigDir } from '../paths';
import { readPromptOrdinalMarks, type PromptOrdinalMark } from '../promptHistory';
import type {
  ProviderId,
  SessionProviderBase,
  SessionProviderDiagnostic,
} from '../providers/types';
import { listSessionPreviewsAsync } from '../sessionPreviews';
import type { SessionPreview, SessionScopeMode } from '../sessionPreviews';
import { SYNTHETIC_MODEL } from './claudeUsageDedupe';
import {
  ordinalAtOrBefore,
  readCodexRolloutHead,
  readFirstRecordTimestamp,
  resolveCodexRoot,
  type CodexRolloutHead,
} from './subagentLineage';
import { pathWithinRoots } from '../workspaceRoots';
import { getPricingCatalogInfo } from '../modelInfo';
import { computeSessionKey } from '../sessionKey';
import { assertListingAlone, isSessionListing, type SessionListing } from '../sessionListing';
import type { TokenTotals } from '../types/historicalData';
import { calculateNormalizedUsageCost, extractNormalizedUsage } from '../usageNormalization';
import type { NormalizedUsage, PricingProvenance } from '../usageNormalization';
import { atomicWriteJson } from '../writers/atomic';
import type { SessionHomesOptions } from '../agentHomes';
import { claudeCodeProviderFactory } from '../providers/claudeCode';
import { codexProviderFactory } from '../providers/codex';
import { createSessionProvidersFrom } from '../providers/sessionProviderRegistry';

/**
 * Bump when the cached record shape or the counting rules change; older files
 * are re-read. v2: Claude split lines and duplicate Codex `token_count` events
 * are counted once, and Claude subagent transcripts are included. v3: events
 * keep reasoning tokens, prompt ordinal, message id, and subagent, and files
 * move to a versioned name (`<provider>--<session>.v3.json`).
 */
export const USAGE_CACHE_VERSION = 3;
/**
 * Most-recently-used cache files kept on disk. Sized for a busy month of
 * sessions (files are a few KB each); a collection larger than this still
 * completes, it just re-reads what was evicted. Pruning runs once after a
 * collection, never during one, so a working set is never evicted mid-run.
 */
export const MAX_USAGE_CACHE_FILES = 5000;

/** One priced usage event from a session log. */
export interface UsageEventRecord {
  /** Event time in ms since epoch. */
  timestamp: number;
  provider: ProviderId;
  sessionId: string;
  /** Workspace path recorded in the session, when known. */
  project: string | null;
  model: string;
  /** Four buckets plus the provider-semantics-aware total. */
  tokens: TokenTotals & {
    totalTokens: number;
    /**
     * Reasoning tokens the provider reported, when any. Informational, never
     * added to a total: Codex counts them inside `outputTokens`; OpenCode
     * reports them apart, inside `totalTokens` but not `outputTokens`.
     */
    reasoningTokens?: number;
  };
  costUsd: number | null;
  costProvenance: PricingProvenance;
  /** Session file the event came from; tells apart two files with one session id. */
  filePath?: string;
  /** Key of that file, as prompt history and `listAgentSessions()` report it. */
  sessionKey?: string;
  /**
   * Ordinal of the human prompt this call followed: the highest ordinal among
   * the session's prompts timestamped at or before the event, as
   * `collectPromptHistory()` numbers them with default bounds. Claude Code
   * subagent calls map to the parent session's prompts. `null` when no prompt
   * precedes the call, or the session has none (a Codex subagent or fork is a
   * session of its own without human prompts). Absent when
   * unknown: a provider without prompt history (OpenCode), or a cache entry
   * written before prompt ordinals were recorded.
   */
  promptOrdinal?: number | null;
  /**
   * The provider's message id for the call (Claude Code, OpenCode). Absent for
   * Codex, whose `token_count` lines carry no request id (the reader's
   * timestamp-derived placeholder is not passed through).
   */
  requestId?: string;
  /**
   * Set when a subagent made the call. Claude Code: the agent id from its
   * transcript name (`agent-<id>.jsonl`), parent = this session. Codex: the
   * forked or spawned rollout's own session id and the session it came from.
   * `rootSessionId` is the session at the top of the chain when known (a
   * Claude Code subagent's root is its session; a Codex one's is
   * `session_meta.session_id`, else the end of its parent chain). `kind` is
   * `subagent` for an agent-spawned one and `fork` for a person's fork.
   */
  subagent?: {
    agentId: string;
    parentSessionId: string;
    rootSessionId?: string;
    kind?: 'subagent' | 'fork';
  };
  /**
   * Subagent calls only: the ordinal of the root session's prompt in effect
   * when the subagent started (its transcript's first record for Claude
   * Code, `session_meta.payload.timestamp` for Codex), so a background agent
   * that keeps working after the next prompt still counts toward the prompt
   * that started it (`promptOrdinal` follows the call's own time). `null`
   * when the root was not found, is out of scope, or no prompt precedes the
   * start. Absent for human forks, OpenCode, and calls that are not a
   * subagent's.
   */
  parentPromptOrdinal?: number | null;
}

/** One session that contributed events. */
export interface UsageSessionRecord {
  provider: ProviderId;
  sessionId: string;
  filePath: string;
  project: string | null;
  fingerprint: string;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  eventCount: number;
  fromCache: boolean;
  /** Key of the session file, as prompt history and `listAgentSessions()` report it. */
  sessionKey?: string;
}

export interface CollectUsageEventsOptions {
  /**
   * Providers to read. Omit to read Claude Code and Codex through providers
   * built for this call from `homes` (OpenCode is read only when passed
   * here). Passing both `providers` and `homes` is a `TypeError`.
   */
  providers?: SessionProviderBase[];
  /**
   * Claude Code and Codex homes for the providers this call builds (see
   * `SessionHomesOptions`; `[]` skips that provider). A relative or blank
   * explicit entry throws `RangeError`.
   */
  homes?: SessionHomesOptions;
  /** Only sessions modified after this instant, and only events at or after it. */
  since?: Date | string;
  /** Only events at or before this instant. */
  until?: Date | string;
  /** Restrict to one workspace's sessions. */
  workspacePath?: string;
  /**
   * Restrict to the sessions of several workspaces, listed once each and
   * counted once even when roots overlap. Takes precedence over
   * `workspacePath`. Roots that do not resolve are dropped; when none
   * resolves, no session is read.
   */
  workspacePaths?: string[];
  /**
   * Also list each root's main checkout and git worktree siblings. Default
   * true with `workspacePaths`, false with `workspacePath`.
   */
  includeWorktrees?: boolean;
  /**
   * `contained` (the default with `workspacePaths`): a session counts only
   * when the cwd it recorded resolves inside one of the roots, checked per
   * session before it is read; a session with no cwd, or one whose directory
   * no longer exists, is left out and counted in `stats.sessionsOutOfScope`.
   * Claude Code subagent transcripts follow their parent session.
   * `listed` (the default with the legacy `workspacePath`): whatever the
   * providers' workspace filters list, which can include look-alike
   * projects (`/a/app` and `/b/app`, or a Codex session in a parent folder).
   */
  scope?: SessionScopeMode;
  /**
   * Leave out Claude Code's `<synthetic>` placeholder messages (never
   * billed), counting them in `stats.syntheticEventsExcluded`. Default false.
   */
  excludeSynthetic?: boolean;
  /**
   * A listing from `listAgentSessions()` to read instead of listing again
   * (its roots scope the call; `scope` still applies). Passing
   * `workspacePath`, `workspacePaths`, `includeWorktrees` or `homes` with it
   * is a `TypeError`. Without `providers`, Claude Code and Codex providers
   * are built for the listing's homes.
   */
  listing?: SessionListing;
  /**
   * Per-call limits on the sessions read from disk (cache hits are free and
   * never counted). A session is never split: the call stops before the
   * session that would pass a bound, returns `hasMore: true`, and the
   * returned `cursor` continues from there. The first read of a call always
   * proceeds. Without `bounds` (and `cursor`) every session is read.
   */
  bounds?: UsageEventsBounds;
  /**
   * The `cursor` of an earlier result. Sessions whose fingerprint it already
   * records are skipped (counted in `stats.sessionsSkippedUnchanged`);
   * changed and new ones come back whole, listed in `changed`. When prices
   * changed since (`pricingChanged`), every session comes back. Cannot be
   * combined with `until` (`TypeError`).
   */
  cursor?: UsageEventsCursor;
  /** Preview-read concurrency (see `listSessionPreviewsAsync`). */
  concurrency?: number;
  /** Cache directory (default `<configDir>/usage-cache`). */
  cacheDir?: string;
  /** Skip the on-disk cache entirely. */
  noCache?: boolean;
  onDiagnostic?: (diagnostic: SessionProviderDiagnostic) => void;
  /**
   * Stops the collection before listing and between sessions; the promise
   * rejects with the signal's reason (an `AbortError` by default). Sessions
   * read before the abort keep their cache entries; no partial session is
   * cached.
   */
  signal?: AbortSignal;
}

export interface CollectUsageEventsStats {
  /** Sessions a `contained` scope left out (no recorded cwd, or one outside the roots). */
  sessionsOutOfScope: number;
  /** `<synthetic>` events left out by `excludeSynthetic`. */
  syntheticEventsExcluded: number;
  /** Sessions skipped because the `cursor` already had them unchanged. */
  sessionsSkippedUnchanged: number;
}

/** Per-call bounds on the sessions `collectUsageEvents` reads from disk. */
export interface UsageEventsBounds {
  /** Sessions read from disk (cache misses). */
  maxSessions?: number;
  /** Bytes of the session files (and Claude Code subagent transcripts) read from disk. */
  maxTotalBytes?: number;
  /** Events in the window from the sessions read from disk. */
  maxEvents?: number;
  /** Wall-clock budget, checked before each read from disk. */
  deadlineMs?: number;
}

export type UsageEventsBound = 'maxSessions' | 'maxTotalBytes' | 'maxEvents' | 'deadline';

/**
 * Where an incremental collection stands: the fingerprint each session was
 * delivered at, the session key the next call starts from, and the pricing
 * digest the events were priced with. Plain JSON; store it as is.
 */
export interface UsageEventsCursor {
  version: 1;
  /** Session key → fingerprint delivered. */
  sessions: Record<string, string>;
  /** Session key the next call starts at, after a bound stopped this one. */
  next?: string;
  /** `getPricingCatalogInfo().digest` when the events were priced. */
  pricing?: string;
}

/** A session a result returned because it was new or changed. */
export interface UsageSessionRef {
  provider: ProviderId;
  sessionId: string;
  sessionKey: string;
}

export interface CollectUsageEventsResult {
  /** Events within the window, oldest first. */
  events: UsageEventRecord[];
  sessions: UsageSessionRecord[];
  diagnostics: SessionProviderDiagnostic[];
  cacheHits: number;
  cacheMisses: number;
  /** Realpaths of the roots listed, after worktree expansion, when the call was scoped. */
  roots?: string[];
  stats: CollectUsageEventsStats;
  /** Pass to the next call to receive only what changed (see `cursor`). */
  cursor: UsageEventsCursor;
  /** A bound stopped the call; call again with `cursor` to continue. */
  hasMore: boolean;
  /** The bounds that stopped this call. */
  boundsHit: UsageEventsBound[];
  /** Sessions returned whose fingerprint differed from the given cursor (all, without one). */
  changed: UsageSessionRef[];
  /** Prices changed since the given cursor, so every session was returned again. */
  pricingChanged: boolean;
}

/** Compact on-disk event: raw counts only, priced when loaded. */
interface CachedUsageEvent {
  t: number;
  m: string;
  i: number;
  o: number;
  cw: number;
  cr: number;
  bo: number;
  tt: number;
  rc?: number;
  /** Reasoning tokens, when nonzero. */
  rt?: number;
  /** Prompt ordinal; null before the first prompt, absent when unknown. */
  po?: number | null;
  /** Message id. */
  rid?: string;
  /** Claude subagent agent id; the parent is the cache file's session. */
  sa?: string;
}

/** A Codex session that is a subagent or fork, as cached. */
interface CachedSessionSubagent {
  agentId: string;
  parentSessionId: string;
  /** Start (`session_meta.payload.timestamp`, ms); null when unrecorded. */
  s?: number | null;
  /** Kind; absent only in entries written before parent prompts were recorded. */
  k?: 'subagent' | 'fork';
  /** `session_meta.session_id` when it names another session (the root). */
  r?: string;
}

interface UsageCacheFile {
  version: number;
  provider: ProviderId;
  sessionId: string;
  fingerprint: string;
  project: string | null;
  events: CachedUsageEvent[];
  /** The whole session is a subagent or fork (Codex): applies to events without `sa`. */
  subagent?: CachedSessionSubagent;
  /** Prompt marks of the main transcript as `[ordinal, timestampMs]`. */
  pm?: Array<[number, number]>;
  /** Claude Code: start (first record, ms) of each subagent transcript, by agent id. */
  as?: Record<string, number | null>;
}

export function getUsageCacheDir(): string {
  return path.join(getConfigDir(), 'usage-cache');
}

/**
 * Cache file of one session. The name carries the cache version, so a reader
 * of another version sharing the directory (which rejects this version, and
 * versions before 3 use the unversioned `<provider>--<session>.json`) never
 * overwrites it, and this version never overwrites theirs.
 */
function cacheFilePath(dir: string, provider: ProviderId, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `${provider}--${safe}.v${USAGE_CACHE_VERSION}.json`);
}

function toMs(value: Date | string | undefined, label: string): number | null {
  if (value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid \`${label}\` value: ${String(value)}`);
  return ms;
}

/** Mark a cache file as recently used so LRU pruning keeps it. Best-effort. */
function touch(filePath: string): void {
  try {
    const now = new Date();
    fs.utimesSync(filePath, now, now);
  } catch {
    // Read-only cache or vanished file; the next miss rewrites it.
  }
}

function readCache(filePath: string): UsageCacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as UsageCacheFile;
    if (parsed?.version !== USAGE_CACHE_VERSION || !Array.isArray(parsed.events)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Deletes all but the `keep` most recently used cache files (by mtime), of
 * every cache version alike, so files no reader touches any more age out.
 * Best-effort.
 */
export function pruneUsageCache(keep = MAX_USAGE_CACHE_FILES, dir = getUsageCacheDir()): number {
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(dir, name);
        try {
          return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let removed = 0;
    for (const entry of entries.slice(Math.max(0, keep))) {
      try {
        fs.unlinkSync(entry.filePath);
        removed += 1;
      } catch {
        // Already gone; skip.
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

function cachedEventFromUsage(
  usage: NormalizedUsage,
  timestamp: number,
  model: string,
  messageId: string | undefined,
  agentId: string | undefined,
) {
  const record: CachedUsageEvent = {
    t: timestamp,
    m: model,
    i: usage.uncachedInputTokens,
    o: usage.outputTokens,
    cw: usage.cacheWriteTokens,
    cr: usage.cacheReadTokens,
    bo: usage.billableOutputTokens,
    tt: usage.totalTokens,
  };
  if (usage.reportedCostUsd !== undefined) record.rc = usage.reportedCostUsd;
  if (usage.reasoningTokens > 0) record.rt = usage.reasoningTokens;
  if (messageId && !messageId.startsWith('token-count-')) record.rid = messageId;
  if (agentId) record.sa = agentId;
  return record;
}

/**
 * Price a cached event with the current catalog (or its provider-reported
 * cost). Output is priced from the billable output (`bo`), which already
 * holds reasoning however the provider reports it, so restoring the reasoning
 * count never changes the cost.
 */
function priceCachedEvent(
  cached: CachedUsageEvent,
  provider: ProviderId,
  sessionId: string,
  project: string | null,
  sessionFile: string,
): UsageEventRecord {
  const reasoningTokens = typeof cached.rt === 'number' && cached.rt > 0 ? cached.rt : 0;
  const usage: NormalizedUsage = {
    uncachedInputTokens: cached.i,
    cacheReadTokens: cached.cr,
    cacheWriteTokens: cached.cw,
    outputTokens: cached.o,
    reasoningTokens,
    // `bo` is already the billable output; nothing is added to it.
    reasoningIncludedInOutput: true,
    cacheInclusiveInputTokens: cached.i + cached.cr + cached.cw,
    billableOutputTokens: cached.bo,
    totalTokens: cached.tt,
    ...(cached.rc !== undefined ? { reportedCostUsd: cached.rc } : {}),
    provenance: { semantics: 'sidekick-disjoint' },
  };
  const priced = calculateNormalizedUsageCost({
    usage,
    modelId: cached.m === 'unknown' ? undefined : cached.m,
  });
  return {
    timestamp: cached.t,
    provider,
    sessionId,
    project,
    model: cached.m,
    tokens: {
      inputTokens: cached.i,
      outputTokens: cached.o,
      cacheWriteTokens: cached.cw,
      cacheReadTokens: cached.cr,
      totalTokens: cached.tt,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    },
    costUsd: priced.costUsd,
    costProvenance: priced.source,
    filePath: sessionFile,
    ...(cached.po === null || (typeof cached.po === 'number' && Number.isInteger(cached.po))
      ? { promptOrdinal: cached.po }
      : {}),
    ...(typeof cached.rid === 'string' ? { requestId: cached.rid } : {}),
  };
}

interface SubagentFile {
  path: string;
  name: string;
  /** Agent id from the file name: `agent-<id>.jsonl` → `<id>`. */
  agentId: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** Claude Code subagent transcripts of a session, sorted by name. */
function claudeSubagentFiles(preview: SessionPreview): SubagentFile[] {
  if (preview.provider !== 'claude-code') return [];
  const dir = getClaudeSubagentsDir(preview.filePath);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => parseClaudeSubagentFileName(name) !== null);
  } catch {
    return [];
  }
  const files: SubagentFile[] = [];
  for (const name of names.sort()) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      files.push({
        path: path.join(dir, name),
        name,
        agentId: parseClaudeSubagentFileName(name) ?? name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    } catch {
      // Removed between listing and stat; the next collection re-reads.
    }
  }
  return files;
}

function sessionFingerprint(preview: SessionPreview, subagents: readonly SubagentFile[]): string {
  const base = `${preview.sizeBytes}:${preview.modifiedAt}`;
  if (subagents.length === 0) return base;
  return `${base}|${subagents.map((f) => `${f.name}:${f.sizeBytes}:${f.modifiedAt}`).join(',')}`;
}

function readTranscriptUsage(
  provider: SessionProviderBase,
  filePath: string,
  cached: CachedUsageEvent[],
  agentId?: string,
): void {
  const reader = provider.createReader(filePath);
  const events = reader.readAll();
  reader.flush();
  // A correction tops up the call its message already recorded, so it merges
  // into that record instead of counting as another call.
  const byMessageId = new Map<string, CachedUsageEvent>();
  for (const event of events) {
    const usage = extractNormalizedUsage(event);
    if (!usage) continue;
    const messageId = event.message?.id;
    const target =
      event.message?.usageKind === 'correction' && messageId
        ? byMessageId.get(messageId)
        : undefined;
    if (target) {
      target.i += usage.uncachedInputTokens;
      target.o += usage.outputTokens;
      target.cw += usage.cacheWriteTokens;
      target.cr += usage.cacheReadTokens;
      target.bo += usage.billableOutputTokens;
      target.tt += usage.totalTokens;
      if (usage.reasoningTokens > 0) target.rt = (target.rt ?? 0) + usage.reasoningTokens;
      continue;
    }
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const record = cachedEventFromUsage(
      usage,
      timestamp,
      event.message?.model ?? usage.model ?? 'unknown',
      messageId,
      agentId,
    );
    cached.push(record);
    if (messageId) byMessageId.set(messageId, record);
  }
}

function readSessionUsage(
  provider: SessionProviderBase,
  preview: SessionPreview,
  subagents: readonly SubagentFile[],
): CachedUsageEvent[] {
  const cached: CachedUsageEvent[] = [];
  readTranscriptUsage(provider, preview.filePath, cached);
  for (const file of subagents) readTranscriptUsage(provider, file.path, cached, file.agentId);
  cached.sort((a, b) => a.t - b.t);
  return cached;
}

/**
 * Sets each event's `po` to the highest ordinal among the prompts timestamped
 * at or before it, or null when none is. With prompts in time order (the
 * usual case) that is the last prompt before the event.
 */
function assignPromptOrdinals(
  events: CachedUsageEvent[],
  marks: readonly PromptOrdinalMark[],
): void {
  const sorted = [...marks].sort((a, b) => a.timestampMs - b.timestampMs || a.ordinal - b.ordinal);
  const highest: number[] = [];
  let max = -1;
  for (const mark of sorted) {
    max = Math.max(max, mark.ordinal);
    highest.push(max);
  }
  for (const event of events) {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle].timestampMs <= event.t) low = middle + 1;
      else high = middle;
    }
    event.po = low === 0 ? null : highest[low - 1];
  }
}

/**
 * Prompt ordinals for a freshly read session, from its main transcript.
 * Returns false when the transcript could not be scanned (the events then
 * keep no ordinal and the session is not cached, so the next run retries).
 */
async function addPromptOrdinals(
  preview: SessionPreview,
  events: CachedUsageEvent[],
): Promise<{ ok: boolean; marks?: PromptOrdinalMark[] }> {
  if (preview.provider !== 'claude-code' && preview.provider !== 'codex') return { ok: true };
  let marks: PromptOrdinalMark[];
  try {
    marks = await readPromptOrdinalMarks(preview.provider, preview.sessionId, preview.filePath);
  } catch {
    return { ok: false };
  }
  assignPromptOrdinals(events, marks);
  return { ok: true, marks };
}

function packMarks(marks: readonly PromptOrdinalMark[]): Array<[number, number]> {
  return marks.map((mark) => [mark.ordinal, mark.timestampMs]);
}

function unpackMarks(value: unknown): PromptOrdinalMark[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const marks: PromptOrdinalMark[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || typeof item[0] !== 'number' || typeof item[1] !== 'number') {
      return undefined;
    }
    marks.push({ ordinal: item[0], timestampMs: item[1] });
  }
  return marks;
}

function validAgentStarts(value: unknown): Record<string, number | null> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const starts: Record<string, number | null> = {};
  for (const [agentId, start] of Object.entries(value as Record<string, unknown>)) {
    if (start !== null && (typeof start !== 'number' || !Number.isFinite(start))) return undefined;
    starts[agentId] = start;
  }
  return starts;
}

/**
 * An entry written before parent prompts were recorded lacks what this
 * version needs to attribute subagent calls; it is read again (once: the
 * new entry has the fields).
 */
function cacheEntryComplete(entry: UsageCacheFile): boolean {
  if (
    entry.provider === 'claude-code' &&
    entry.events.some((event) => typeof event.sa === 'string')
  ) {
    return validAgentStarts(entry.as) !== undefined && unpackMarks(entry.pm) !== undefined;
  }
  if (entry.provider === 'codex' && entry.subagent) {
    return entry.subagent.k === 'subagent' || entry.subagent.k === 'fork';
  }
  return true;
}

/** Start of each Claude Code subagent transcript: its first record's time. */
async function claudeAgentStarts(
  subagents: readonly SubagentFile[],
): Promise<Record<string, number | null>> {
  const starts: Record<string, number | null> = {};
  for (const file of subagents) starts[file.agentId] = await readFirstRecordTimestamp(file.path);
  return starts;
}

/** Parent of a Codex rollout that is a fork or a spawned subagent, from its first line only. */
async function codexSessionSubagent(
  preview: SessionPreview,
): Promise<CachedSessionSubagent | undefined> {
  if (preview.provider !== 'codex') return undefined;
  const head = await readCodexRolloutHead(preview.sessionId, preview.filePath);
  if (!head?.parentId || !head.kind) return undefined;
  return {
    agentId: preview.sessionId,
    parentSessionId: head.parentId,
    s: head.startMs,
    k: head.kind,
    ...(head.recordedRootId ? { r: head.recordedRootId } : {}),
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Collect priced usage events for every session touched in the window.
 *
 * Sessions are enumerated with `listSessionPreviewsAsync` (the `since`
 * cutoff applies to the session mtime there and to the event timestamp
 * here), read once each unless the cache already holds their fingerprint,
 * and yielded between reads so long-lived hosts stay responsive.
 */
export async function collectUsageEvents(
  options: CollectUsageEventsOptions,
): Promise<CollectUsageEventsResult> {
  const sinceMs = toMs(options.since, 'since');
  const untilMs = toMs(options.until, 'until');
  const cacheDir = options.cacheDir ?? getUsageCacheDir();
  const useCache = !options.noCache;
  const signal = options.signal;

  if (options.providers && options.homes) {
    throw new TypeError('collectUsageEvents: pass either `providers` or `homes`, not both.');
  }
  if (options.cursor !== undefined && options.until !== undefined) {
    throw new TypeError(
      'collectUsageEvents: `until` cannot be combined with `cursor` (a cursor records whole sessions).',
    );
  }
  if (options.listing !== undefined) {
    if (!isSessionListing(options.listing)) {
      throw new TypeError('collectUsageEvents: `listing` must come from listAgentSessions().');
    }
    assertListingAlone('collectUsageEvents', options as unknown as Record<string, unknown>, [
      'workspacePath',
      'workspacePaths',
      'includeWorktrees',
      'homes',
    ]);
  }
  const bounds = validBounds(options.bounds);
  const owned = options.providers ? [] : createUsageProviders(options.homes, options.listing);
  try {
    return await collectWithProviders(
      { ...options, providers: options.providers ?? owned },
      { sinceMs, untilMs, cacheDir, useCache, signal, bounds },
    );
  } finally {
    for (const provider of owned) provider.dispose?.();
  }
}

/**
 * Claude Code and Codex providers for a call that passed homes, a listing,
 * or nothing (OpenCode is read only when passed in `providers`).
 */
function createUsageProviders(
  homes: SessionHomesOptions | undefined,
  listing: SessionListing | undefined,
): SessionProviderBase[] {
  const factories = [claudeCodeProviderFactory, codexProviderFactory];
  if (listing) {
    return createSessionProvidersFrom(factories, {
      providerIds: listing.providers,
      homes: { claudeHomes: listing.homes.claude, codexHomes: listing.homes.codex },
      includeCompressedRollouts: listing.includeCompressedRollouts,
    }).providers;
  }
  return createSessionProvidersFrom(factories, homes ? { homes } : {}).providers;
}

function validBounds(bounds: UsageEventsBounds | undefined): UsageEventsBounds | undefined {
  if (bounds === undefined) return undefined;
  const checked: UsageEventsBounds = {};
  for (const name of ['maxSessions', 'maxTotalBytes', 'maxEvents', 'deadlineMs'] as const) {
    const value = bounds[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
      throw new RangeError(`collectUsageEvents: \`bounds.${name}\` must be a number >= 0.`);
    }
    checked[name] = value;
  }
  return checked;
}

interface CollectContext {
  sinceMs: number | null;
  untilMs: number | null;
  cacheDir: string;
  useCache: boolean;
  signal: AbortSignal | undefined;
  bounds: UsageEventsBounds | undefined;
}

/** A listed session in collection order. */
interface OrderedPreview {
  preview: SessionPreview;
  key: string;
  /** Position in the listing (newest first), the order `sessions` keeps. */
  index: number;
}

/** One session read (or loaded from cache) in this call. */
interface LoadedSession extends OrderedPreview {
  provider: SessionProviderBase;
  cachedEvents: CachedUsageEvent[];
  sessionSubagent: CachedSessionSubagent | undefined;
  /** Prompt marks of the main transcript, when known. */
  marks?: PromptOrdinalMark[];
  /** Claude Code: start of each subagent transcript. */
  agentStarts?: Record<string, number | null>;
  project: string | null;
  fingerprint: string;
  fromCache: boolean;
  /** Read from disk in this call (a cache miss). */
  missed: boolean;
}

function rotateOrdered(ordered: OrderedPreview[], next: string | undefined): OrderedPreview[] {
  if (!next) return ordered;
  const index = ordered.findIndex((item) => item.key >= next);
  return index <= 0 ? ordered : [...ordered.slice(index), ...ordered.slice(0, index)];
}

async function collectWithProviders(
  options: CollectUsageEventsOptions & { providers: SessionProviderBase[] },
  context: CollectContext,
): Promise<CollectUsageEventsResult> {
  const { sinceMs, untilMs, cacheDir, useCache, signal, bounds } = context;
  const startedAt = Date.now();
  signal?.throwIfAborted();
  const cursorIn =
    options.cursor === undefined ? undefined : parseUsageEventsCursor(options.cursor);
  const pricing = getPricingCatalogInfo().digest;
  const pricingChanged = cursorIn?.pricing !== undefined && cursorIn.pricing !== pricing;

  const listed = await listSessionPreviewsAsync(options.providers, {
    since: options.since,
    ...(options.listing
      ? { listing: options.listing }
      : {
          workspacePath: options.workspacePath,
          workspacePaths: options.workspacePaths,
          includeWorktrees: options.includeWorktrees,
        }),
    scope: options.scope,
    limit: Number.MAX_SAFE_INTEGER,
    concurrency: options.concurrency,
  });
  signal?.throwIfAborted();
  const stats: CollectUsageEventsStats = {
    sessionsOutOfScope: listed.stats?.sessionsOutOfScope ?? 0,
    syntheticEventsExcluded: 0,
    sessionsSkippedUnchanged: 0,
  };
  const diagnostics = [...listed.diagnostics];
  for (const diagnostic of listed.diagnostics) options.onDiagnostic?.(diagnostic);
  const providerById = new Map(options.providers.map((provider) => [provider.id, provider]));

  // Deterministic order (by session key), resumed where the cursor stopped.
  const ordered = rotateOrdered(
    listed.previews
      .map((preview, index) => ({
        preview,
        key: computeSessionKey(preview.provider, preview.sessionId, preview.filePath),
        index,
      }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    cursorIn?.next,
  );

  const cursorOut: UsageEventsCursor = { version: 1, sessions: {}, pricing };
  const boundsHit = new Set<UsageEventsBound>();
  const loaded: LoadedSession[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let missBytes = 0;
  let missEvents = 0;
  let wroteCache = false;
  let stoppedAt: number | null = null;

  const boundReached = (sessionBytes: number): UsageEventsBound | null => {
    // The first miss of a call always proceeds, so every call makes progress.
    if (!bounds || cacheMisses === 0) return null;
    if (bounds.deadlineMs !== undefined && Date.now() - startedAt >= bounds.deadlineMs) {
      return 'deadline';
    }
    if (bounds.maxSessions !== undefined && cacheMisses >= bounds.maxSessions) return 'maxSessions';
    if (bounds.maxEvents !== undefined && missEvents >= bounds.maxEvents) return 'maxEvents';
    if (bounds.maxTotalBytes !== undefined && missBytes + sessionBytes > bounds.maxTotalBytes) {
      return 'maxTotalBytes';
    }
    return null;
  };

  for (let position = 0; position < ordered.length; position++) {
    const item = ordered[position];
    const { preview, key } = item;
    signal?.throwIfAborted();
    const provider = providerById.get(preview.provider);
    if (!provider) continue;
    const subagentFiles = claudeSubagentFiles(preview);
    const fingerprint = sessionFingerprint(preview, subagentFiles);
    if (cursorIn && !pricingChanged && cursorIn.sessions[key] === fingerprint) {
      // Delivered whole by an earlier call and unchanged since.
      cursorOut.sessions[key] = fingerprint;
      stats.sessionsSkippedUnchanged += 1;
      continue;
    }
    const filePath = cacheFilePath(cacheDir, preview.provider, preview.sessionId);

    let cachedEvents: CachedUsageEvent[] | null = null;
    let sessionSubagent: CachedSessionSubagent | undefined;
    let marks: PromptOrdinalMark[] | undefined;
    let agentStarts: Record<string, number | null> | undefined;
    let project = preview.workspacePath;
    let fromCache = false;
    if (useCache) {
      const cached = readCache(filePath);
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        cached.sessionId === preview.sessionId &&
        cacheEntryComplete(cached)
      ) {
        cachedEvents = cached.events;
        sessionSubagent = validSubagent(cached.subagent);
        marks = unpackMarks(cached.pm);
        agentStarts = validAgentStarts(cached.as);
        project = project ?? cached.project;
        fromCache = true;
        cacheHits += 1;
        touch(filePath);
      }
    }

    if (!cachedEvents) {
      const sessionBytes =
        preview.sizeBytes + subagentFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
      const stop = boundReached(sessionBytes);
      if (stop) {
        boundsHit.add(stop);
        stoppedAt = position;
        break;
      }
      cacheMisses += 1;
      missBytes += sessionBytes;
      try {
        cachedEvents = readSessionUsage(provider, preview, subagentFiles);
      } catch (error) {
        const diagnostic: SessionProviderDiagnostic = {
          providerId: preview.provider,
          kind: 'read_failed',
          severity: 'warning',
          phase: 'read',
          message: `Could not read usage for ${preview.provider} session ${preview.sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
        diagnostics.push(diagnostic);
        options.onDiagnostic?.(diagnostic);
        continue;
      }
      // Ordinals and origin are best-effort: a failure costs only the cache write.
      const ordinals = await addPromptOrdinals(preview, cachedEvents);
      marks = ordinals.marks;
      sessionSubagent = await codexSessionSubagent(preview).catch(() => undefined);
      if (subagentFiles.length > 0) agentStarts = await claudeAgentStarts(subagentFiles);
      if (useCache && ordinals.ok) {
        const record: UsageCacheFile = {
          version: USAGE_CACHE_VERSION,
          provider: preview.provider,
          sessionId: preview.sessionId,
          fingerprint,
          project,
          events: cachedEvents,
          ...(sessionSubagent ? { subagent: sessionSubagent } : {}),
          ...(marks ? { pm: packMarks(marks) } : {}),
          ...(agentStarts ? { as: agentStarts } : {}),
        };
        try {
          await atomicWriteJson(filePath, record);
          wroteCache = true;
        } catch {
          // The cache is an accelerator; a failed write only costs a re-read.
        }
      }
      await yieldToEventLoop();
    }

    const session: LoadedSession = {
      ...item,
      provider,
      cachedEvents,
      sessionSubagent,
      ...(marks ? { marks } : {}),
      ...(agentStarts ? { agentStarts } : {}),
      project,
      fingerprint,
      fromCache,
      missed: !fromCache,
    };
    loaded.push(session);
    cursorOut.sessions[key] = fingerprint;
    if (session.missed) missEvents += countWindowEvents(cachedEvents, sinceMs, untilMs);
  }

  if (stoppedAt !== null) {
    // Sessions after the stop keep what an earlier call delivered.
    for (const { key } of ordered.slice(stoppedAt)) {
      const previous = cursorIn?.sessions[key];
      if (previous !== undefined) cursorOut.sessions[key] = previous;
    }
    cursorOut.next = ordered[stoppedAt].key;
  }

  if (wroteCache) pruneUsageCache(MAX_USAGE_CACHE_FILES, cacheDir);

  const lineage = await codexLineage(loaded, listed.previews, listed.roots, providerById);

  const events: UsageEventRecord[] = [];
  const sessions: UsageSessionRecord[] = [];
  const changed: UsageSessionRef[] = [];
  for (const session of [...loaded].sort((left, right) => left.index - right.index)) {
    const { preview, key } = session;
    const codex = lineage.get(session);
    let first: number | null = null;
    let last: number | null = null;
    let count = 0;
    for (const cached of session.cachedEvents) {
      if (sinceMs !== null && cached.t < sinceMs) continue;
      if (untilMs !== null && cached.t > untilMs) continue;
      if (options.excludeSynthetic && cached.m === SYNTHETIC_MODEL) {
        stats.syntheticEventsExcluded += 1;
        continue;
      }
      events.push({
        ...priceCachedEvent(
          cached,
          preview.provider,
          preview.sessionId,
          session.project,
          preview.filePath,
        ),
        sessionKey: key,
        ...eventSubagent(session, cached, codex),
      });
      first = first === null ? cached.t : Math.min(first, cached.t);
      last = last === null ? cached.t : Math.max(last, cached.t);
      count += 1;
    }
    sessions.push({
      provider: preview.provider,
      sessionId: preview.sessionId,
      filePath: preview.filePath,
      project: session.project,
      fingerprint: session.fingerprint,
      firstTimestamp: first,
      lastTimestamp: last,
      eventCount: count,
      fromCache: session.fromCache,
      sessionKey: key,
    });
    if (pricingChanged || cursorIn?.sessions[key] !== session.fingerprint) {
      changed.push({ provider: preview.provider, sessionId: preview.sessionId, sessionKey: key });
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp);
  return {
    events,
    sessions,
    diagnostics,
    cacheHits,
    cacheMisses,
    ...(listed.roots ? { roots: listed.roots } : {}),
    stats,
    cursor: cursorOut,
    hasMore: stoppedAt !== null,
    boundsHit: [...boundsHit],
    changed,
    pricingChanged,
  };
}

function countWindowEvents(
  events: readonly CachedUsageEvent[],
  sinceMs: number | null,
  untilMs: number | null,
): number {
  let count = 0;
  for (const event of events) {
    if (sinceMs !== null && event.t < sinceMs) continue;
    if (untilMs !== null && event.t > untilMs) continue;
    count += 1;
  }
  return count;
}

/**
 * A usage cursor from storage or the wire, checked; undefined when it is not
 * one this version wrote (callers then start over).
 */
export function parseUsageEventsCursor(value: unknown): UsageEventsCursor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return undefined;
  const sessions = candidate.sessions;
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) {
    return undefined;
  }
  const parsed: UsageEventsCursor = { version: 1, sessions: {} };
  for (const [key, fingerprint] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof fingerprint !== 'string') return undefined;
    parsed.sessions[key] = fingerprint;
  }
  if (candidate.next !== undefined) {
    if (typeof candidate.next !== 'string') return undefined;
    parsed.next = candidate.next;
  }
  if (candidate.pricing !== undefined) {
    if (typeof candidate.pricing !== 'string') return undefined;
    parsed.pricing = candidate.pricing;
  }
  return parsed;
}

/** What a Codex subagent or fork's events carry: its root and parent prompt. */
interface CodexLineage {
  rootSessionId?: string;
  /** Subagents only; null when the root or its prompts are unknown. */
  parentPromptOrdinal?: number | null;
}

/**
 * Root and parent prompt of every Codex subagent or fork that was loaded.
 * Roots are looked up among the loaded and listed sessions first, then by
 * id through the Codex provider; a root found that way must be inside the
 * call's roots when the call was scoped.
 */
async function codexLineage(
  loaded: readonly LoadedSession[],
  previews: readonly SessionPreview[],
  roots: readonly string[] | undefined,
  providerById: ReadonlyMap<ProviderId, SessionProviderBase>,
): Promise<Map<LoadedSession, CodexLineage>> {
  const result = new Map<LoadedSession, CodexLineage>();
  const children = loaded.filter(
    (session) => session.preview.provider === 'codex' && session.sessionSubagent,
  );
  if (children.length === 0) return result;

  const loadedById = new Map<string, LoadedSession>();
  for (const session of loaded) {
    if (session.preview.provider === 'codex') loadedById.set(session.preview.sessionId, session);
  }
  const listedById = new Map<string, SessionPreview>();
  for (const preview of previews) {
    if (preview.provider === 'codex') listedById.set(preview.sessionId, preview);
  }
  const codexProvider = providerById.get('codex');
  const heads = new Map<string, Promise<{ head: CodexRolloutHead; filePath: string } | null>>();
  const realpaths = new Map<string, string | null>();

  const locate = (sessionId: string) => {
    let found = heads.get(sessionId);
    if (!found) {
      found = (async () => {
        const known = loadedById.get(sessionId);
        if (known) {
          const sub = known.sessionSubagent;
          return {
            filePath: known.preview.filePath,
            head: {
              sessionId,
              ...(sub?.k ? { parentId: sub.parentSessionId, kind: sub.k } : {}),
              ...(sub?.r ? { recordedRootId: sub.r } : {}),
              startMs: sub?.s ?? null,
              cwd: known.project,
            },
          };
        }
        const listed = listedById.get(sessionId);
        let filePath = listed?.filePath ?? null;
        if (!filePath) {
          try {
            filePath = codexProvider?.findSessionById?.('', sessionId) ?? null;
          } catch {
            filePath = null;
          }
        }
        if (!filePath) return null;
        const head = await readCodexRolloutHead(sessionId, filePath);
        if (!head) return null;
        // A root found outside the listing must still be in scope.
        if (!listed && roots && !pathWithinRoots(head.cwd, roots, realpaths)) return null;
        return { head, filePath };
      })();
      heads.set(sessionId, found);
    }
    return found;
  };

  const marksCache = new Map<string, Promise<PromptOrdinalMark[] | null>>();
  const marksOf = (sessionId: string, filePath: string) => {
    let marks = marksCache.get(sessionId);
    if (!marks) {
      const known = loadedById.get(sessionId)?.marks;
      marks = known
        ? Promise.resolve(known)
        : readPromptOrdinalMarks('codex', sessionId, filePath).catch(() => null);
      marksCache.set(sessionId, marks);
    }
    return marks;
  };

  for (const child of children) {
    const sub = child.sessionSubagent!;
    const head: CodexRolloutHead = {
      sessionId: child.preview.sessionId,
      parentId: sub.parentSessionId,
      ...(sub.k ? { kind: sub.k } : {}),
      ...(sub.r ? { recordedRootId: sub.r } : {}),
      startMs: sub.s ?? null,
      cwd: child.project,
    };
    const resolved = await resolveCodexRoot(head, async (id) => (await locate(id))?.head ?? null);
    const lineage: CodexLineage = {
      ...(resolved.rootSessionId ? { rootSessionId: resolved.rootSessionId } : {}),
    };
    if (sub.k === 'subagent') {
      let ordinal: number | null = null;
      if (resolved.rootSessionId && resolved.root) {
        const located = await locate(resolved.rootSessionId);
        const marks = located ? await marksOf(resolved.rootSessionId, located.filePath) : null;
        ordinal = marks ? ordinalAtOrBefore(marks, sub.s) : null;
      }
      lineage.parentPromptOrdinal = ordinal;
    }
    result.set(child, lineage);
  }
  return result;
}

/** The subagent tag (and parent prompt) of one event. */
function eventSubagent(
  session: LoadedSession,
  cached: CachedUsageEvent,
  codex: CodexLineage | undefined,
): Pick<UsageEventRecord, 'subagent' | 'parentPromptOrdinal'> {
  const sessionId = session.preview.sessionId;
  if (typeof cached.sa === 'string' && cached.sa) {
    const start = session.agentStarts?.[cached.sa];
    return {
      subagent: {
        agentId: cached.sa,
        parentSessionId: sessionId,
        rootSessionId: sessionId,
        kind: 'subagent',
      },
      ...(session.marks ? { parentPromptOrdinal: ordinalAtOrBefore(session.marks, start) } : {}),
    };
  }
  const sub = session.sessionSubagent;
  if (!sub) return {};
  return {
    subagent: {
      agentId: sub.agentId,
      parentSessionId: sub.parentSessionId,
      ...(codex?.rootSessionId ? { rootSessionId: codex.rootSessionId } : {}),
      ...(sub.k ? { kind: sub.k } : {}),
    },
    ...(codex && codex.parentPromptOrdinal !== undefined
      ? { parentPromptOrdinal: codex.parentPromptOrdinal }
      : {}),
  };
}

function validSubagent(value: unknown): CachedSessionSubagent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { agentId, parentSessionId, s, k, r } = value as Record<string, unknown>;
  if (typeof agentId !== 'string' || typeof parentSessionId !== 'string') return undefined;
  return {
    agentId,
    parentSessionId,
    ...(s === null || (typeof s === 'number' && Number.isFinite(s)) ? { s } : {}),
    ...(k === 'subagent' || k === 'fork' ? { k } : {}),
    ...(typeof r === 'string' && r ? { r } : {}),
  };
}
