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
 * Node-only: reads session files and the cache directory.
 *
 * @module usage/usageEvents
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../paths';
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

/** Bump when the cached record shape changes; older files are re-read. */
export const USAGE_CACHE_VERSION = 1;
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
  tokens: TokenTotals & { totalTokens: number };
  costUsd: number | null;
  costProvenance: PricingProvenance;
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
  /** Preview-read concurrency (see `listSessionPreviewsAsync`). */
  concurrency?: number;
  /** Cache directory (default `<configDir>/usage-cache`). */
  cacheDir?: string;
  /** Skip the on-disk cache entirely. */
  noCache?: boolean;
  onDiagnostic?: (diagnostic: SessionProviderDiagnostic) => void;
}

export interface CollectUsageEventsResult {
  /** Events within the window, oldest first. */
  events: UsageEventRecord[];
  sessions: UsageSessionRecord[];
  diagnostics: SessionProviderDiagnostic[];
  cacheHits: number;
  cacheMisses: number;
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
}

interface UsageCacheFile {
  version: number;
  provider: ProviderId;
  sessionId: string;
  fingerprint: string;
  project: string | null;
  events: CachedUsageEvent[];
}

export function getUsageCacheDir(): string {
  return path.join(getConfigDir(), 'usage-cache');
}

function cacheFilePath(dir: string, provider: ProviderId, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `${provider}--${safe}.json`);
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

/** Deletes all but the `keep` most recently used cache files (by mtime). Best-effort. */
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

function cachedEventFromUsage(usage: NormalizedUsage, timestamp: number, model: string) {
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
  return record;
}

/** Price a cached event with the current catalog (or its provider-reported cost). */
function priceCachedEvent(
  cached: CachedUsageEvent,
  provider: ProviderId,
  sessionId: string,
  project: string | null,
): UsageEventRecord {
  const usage: NormalizedUsage = {
    uncachedInputTokens: cached.i,
    cacheReadTokens: cached.cr,
    cacheWriteTokens: cached.cw,
    outputTokens: cached.o,
    reasoningTokens: 0,
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
    },
    costUsd: priced.costUsd,
    costProvenance: priced.source,
  };
}

function readSessionUsage(provider: SessionProviderBase, preview: SessionPreview) {
  const reader = provider.createReader(preview.filePath);
  const events = reader.readAll();
  reader.flush();
  const cached: CachedUsageEvent[] = [];
  for (const event of events) {
    const usage = extractNormalizedUsage(event);
    if (!usage) continue;
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    cached.push(
      cachedEventFromUsage(usage, timestamp, event.message?.model ?? usage.model ?? 'unknown'),
    );
  }
  return cached;
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

  const listed = await listSessionPreviewsAsync(options.providers, {
    since: options.since,
    workspacePath: options.workspacePath,
    limit: Number.MAX_SAFE_INTEGER,
    concurrency: options.concurrency,
  });
  const diagnostics = [...listed.diagnostics];
  for (const diagnostic of listed.diagnostics) options.onDiagnostic?.(diagnostic);
  const providerById = new Map(options.providers.map((provider) => [provider.id, provider]));

  const events: UsageEventRecord[] = [];
  const sessions: UsageSessionRecord[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let wroteCache = false;

  for (const preview of listed.previews) {
    const provider = providerById.get(preview.provider);
    if (!provider) continue;
    const fingerprint = `${preview.sizeBytes}:${preview.modifiedAt}`;
    const filePath = cacheFilePath(cacheDir, preview.provider, preview.sessionId);

    let cachedEvents: CachedUsageEvent[] | null = null;
    let project = preview.workspacePath;
    let fromCache = false;
    if (useCache) {
      const cached = readCache(filePath);
      if (cached && cached.fingerprint === fingerprint && cached.sessionId === preview.sessionId) {
        cachedEvents = cached.events;
        project = project ?? cached.project;
        fromCache = true;
        cacheHits += 1;
        touch(filePath);
      }
    }

    if (!cachedEvents) {
      cacheMisses += 1;
      try {
        cachedEvents = readSessionUsage(provider, preview);
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
      if (useCache) {
        const record: UsageCacheFile = {
          version: USAGE_CACHE_VERSION,
          provider: preview.provider,
          sessionId: preview.sessionId,
          fingerprint,
          project,
          events: cachedEvents,
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
      events.push(priceCachedEvent(cached, preview.provider, preview.sessionId, project));
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
  return { events, sessions, diagnostics, cacheHits, cacheMisses };
}
