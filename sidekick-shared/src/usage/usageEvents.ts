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
 * from the rollout's first line.)
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
import { codexRolloutOrigin } from '../parsers/codexRolloutOrigin';
import { getConfigDir } from '../paths';
import { readPromptOrdinalMarks, type PromptOrdinalMark } from '../promptHistory';
import { readFirstLineAsync } from '../providers/codexRollouts';
import type {
  ProviderId,
  SessionProviderBase,
  SessionProviderDiagnostic,
} from '../providers/types';
import { listSessionPreviewsAsync } from '../sessionPreviews';
import type { SessionPreview } from '../sessionPreviews';
import type { TokenTotals } from '../types/historicalData';
import { calculateNormalizedUsageCost, extractNormalizedUsage } from '../usageNormalization';
import type { NormalizedUsage, PricingProvenance } from '../usageNormalization';
import { atomicWriteJson } from '../writers/atomic';
import { resolveWorkspaceRoots, type ResolvedWorkspaceRoots } from '../workspaceRoots';

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
   */
  subagent?: { agentId: string; parentSessionId: string };
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
}

export interface CollectUsageEventsOptions {
  providers: SessionProviderBase[];
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

export interface CollectUsageEventsResult {
  /** Events within the window, oldest first. */
  events: UsageEventRecord[];
  sessions: UsageSessionRecord[];
  diagnostics: SessionProviderDiagnostic[];
  cacheHits: number;
  cacheMisses: number;
  /** Realpaths of the roots listed, after worktree expansion, when the call was scoped. */
  roots?: string[];
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

interface UsageCacheFile {
  version: number;
  provider: ProviderId;
  sessionId: string;
  fingerprint: string;
  project: string | null;
  events: CachedUsageEvent[];
  /** The whole session is a subagent or fork (Codex): applies to events without `sa`. */
  subagent?: { agentId: string; parentSessionId: string };
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
  sessionSubagent: UsageCacheFile['subagent'],
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
  const subagent =
    typeof cached.sa === 'string' && cached.sa
      ? { agentId: cached.sa, parentSessionId: sessionId }
      : sessionSubagent;
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
    ...(subagent ? { subagent: { ...subagent } } : {}),
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

const CLAUDE_AGENT_FILE = /^agent-(.+)\.jsonl$/;

/** Claude Code subagent transcripts of a session, sorted by name. */
function claudeSubagentFiles(preview: SessionPreview): SubagentFile[] {
  if (preview.provider !== 'claude-code') return [];
  const dir = path.join(path.dirname(preview.filePath), preview.sessionId, 'subagents');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => CLAUDE_AGENT_FILE.test(name));
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
        agentId: CLAUDE_AGENT_FILE.exec(name)?.[1] ?? name,
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
): Promise<boolean> {
  if (preview.provider !== 'claude-code' && preview.provider !== 'codex') return true;
  let marks: PromptOrdinalMark[];
  try {
    marks = await readPromptOrdinalMarks(preview.provider, preview.sessionId, preview.filePath);
  } catch {
    return false;
  }
  assignPromptOrdinals(events, marks);
  return true;
}

/** Parent of a Codex rollout that is a fork or a spawned subagent, from its first line only. */
async function codexSessionSubagent(
  preview: SessionPreview,
): Promise<UsageCacheFile['subagent'] | undefined> {
  if (preview.provider !== 'codex') return undefined;
  const { line } = await readFirstLineAsync(preview.filePath);
  if (!line) return undefined;
  let first: unknown;
  try {
    first = JSON.parse(line);
  } catch {
    return undefined;
  }
  const origin = codexRolloutOrigin(first);
  if (!origin.parentId || (!origin.isSubagent && !origin.forkedFromId)) return undefined;
  if (origin.parentId === preview.sessionId) return undefined;
  return { agentId: preview.sessionId, parentSessionId: origin.parentId };
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

  signal?.throwIfAborted();
  const scope = usageScope(options);
  const listed = await listScopedPreviews(options, scope?.listingRoots);
  signal?.throwIfAborted();
  const diagnostics = [...listed.diagnostics];
  for (const diagnostic of listed.diagnostics) options.onDiagnostic?.(diagnostic);
  const providerById = new Map(options.providers.map((provider) => [provider.id, provider]));

  const events: UsageEventRecord[] = [];
  const sessions: UsageSessionRecord[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let wroteCache = false;

  for (const preview of listed.previews) {
    signal?.throwIfAborted();
    const provider = providerById.get(preview.provider);
    if (!provider) continue;
    const subagentFiles = claudeSubagentFiles(preview);
    const fingerprint = sessionFingerprint(preview, subagentFiles);
    const filePath = cacheFilePath(cacheDir, preview.provider, preview.sessionId);

    let cachedEvents: CachedUsageEvent[] | null = null;
    let sessionSubagent: UsageCacheFile['subagent'];
    let project = preview.workspacePath;
    let fromCache = false;
    if (useCache) {
      const cached = readCache(filePath);
      if (cached && cached.fingerprint === fingerprint && cached.sessionId === preview.sessionId) {
        cachedEvents = cached.events;
        sessionSubagent = validSubagent(cached.subagent);
        project = project ?? cached.project;
        fromCache = true;
        cacheHits += 1;
        touch(filePath);
      }
    }

    if (!cachedEvents) {
      cacheMisses += 1;
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
      const ordinalsRead = await addPromptOrdinals(preview, cachedEvents);
      sessionSubagent = await codexSessionSubagent(preview).catch(() => undefined);
      if (useCache && ordinalsRead) {
        const record: UsageCacheFile = {
          version: USAGE_CACHE_VERSION,
          provider: preview.provider,
          sessionId: preview.sessionId,
          fingerprint,
          project,
          events: cachedEvents,
          ...(sessionSubagent ? { subagent: sessionSubagent } : {}),
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

    let first: number | null = null;
    let last: number | null = null;
    let count = 0;
    for (const cached of cachedEvents) {
      if (sinceMs !== null && cached.t < sinceMs) continue;
      if (untilMs !== null && cached.t > untilMs) continue;
      events.push(
        priceCachedEvent(
          cached,
          preview.provider,
          preview.sessionId,
          project,
          preview.filePath,
          sessionSubagent,
        ),
      );
      first = first === null ? cached.t : Math.min(first, cached.t);
      last = last === null ? cached.t : Math.max(last, cached.t);
      count += 1;
    }
    sessions.push({
      provider: preview.provider,
      sessionId: preview.sessionId,
      filePath: preview.filePath,
      project,
      fingerprint,
      firstTimestamp: first,
      lastTimestamp: last,
      eventCount: count,
      fromCache,
    });
  }

  if (wroteCache) pruneUsageCache(MAX_USAGE_CACHE_FILES, cacheDir);

  events.sort((a, b) => a.timestamp - b.timestamp);
  return {
    events,
    sessions,
    diagnostics,
    cacheHits,
    cacheMisses,
    ...(scope ? { roots: scope.roots } : {}),
  };
}

function validSubagent(value: unknown): UsageCacheFile['subagent'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const { agentId, parentSessionId } = value as Record<string, unknown>;
  return typeof agentId === 'string' && typeof parentSessionId === 'string'
    ? { agentId, parentSessionId }
    : undefined;
}

/** The roots to list, or undefined for an unscoped (or legacy single-root) call. */
function usageScope(options: CollectUsageEventsOptions): ResolvedWorkspaceRoots | undefined {
  if (options.workspacePaths) {
    return resolveWorkspaceRoots(options.workspacePaths, {
      includeWorktrees: options.includeWorktrees !== false,
    });
  }
  if (options.workspacePath && options.includeWorktrees === true) {
    return resolveWorkspaceRoots([options.workspacePath], { includeWorktrees: true });
  }
  return undefined;
}

/** Lists previews once per root and keeps each session file once. */
async function listScopedPreviews(
  options: CollectUsageEventsOptions,
  listingRoots: string[] | undefined,
): Promise<{ previews: SessionPreview[]; diagnostics: SessionProviderDiagnostic[] }> {
  const list = (workspacePath: string | undefined) =>
    listSessionPreviewsAsync(options.providers, {
      since: options.since,
      workspacePath,
      limit: Number.MAX_SAFE_INTEGER,
      concurrency: options.concurrency,
    });
  if (!listingRoots) return list(options.workspacePath);
  const byFile = new Map<string, SessionPreview>();
  const diagnostics = new Map<string, SessionProviderDiagnostic>();
  for (const root of listingRoots) {
    options.signal?.throwIfAborted();
    const listed = await list(root);
    // Each root lists every provider again; report each problem once.
    for (const diagnostic of listed.diagnostics) {
      diagnostics.set(JSON.stringify(diagnostic), diagnostic);
    }
    for (const preview of listed.previews) {
      if (!byFile.has(preview.filePath)) byFile.set(preview.filePath, preview);
    }
  }
  const previews = [...byFile.values()].sort(
    (left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt),
  );
  return { previews, diagnostics: [...diagnostics.values()] };
}
