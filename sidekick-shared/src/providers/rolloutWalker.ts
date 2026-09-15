/**
 * One capped walker for Codex rollout files.
 *
 * Codex writes `<home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
 * Six recursive, uncapped walkers used to exist across the provider and the
 * quota resolver; this module replaces them with a single walk that caps
 * depth and file count, visits the newest-dated directories first so a
 * `limit` can stop early, stats each file exactly once, and returns results
 * newest first with the size and session id already attached.
 *
 * With `limit` or `since`, the early exit is by directory date: a rollout
 * that was created days ago but is still being written lands in its creation
 * day's directory, so a very small limit (or a recent `since`) can miss it in
 * favour of newer-dated, older-modified files. Callers that need exact mtime
 * order over the whole history omit both (the `maxFiles` cap still applies);
 * a live session missed this way is picked up by its next watch event.
 *
 * The async walker accepts a {@link DirectoryListingCache}: unchanged
 * directories are then one stat each instead of a readdir plus a stat per
 * file, which is what makes repeated discovery over a large history cheap.
 *
 * @module providers/rolloutWalker
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DirectoryListingCache, DirectoryListingCounters } from './directoryListingCache';

export interface RolloutFileInfo {
  path: string;
  mtime: Date;
  sizeBytes: number;
  /** Session id parsed from the file name. */
  sessionId: string;
}

export interface WalkRolloutFilesOptions {
  /** Directory depth below each root to descend into (default 6; the dated tree is 3). */
  maxDepth?: number;
  /** Upper bound on files returned across all roots (default 20 000). */
  maxFiles?: number;
  /** Stop once this many files are collected, visiting newest-dated directories first. */
  limit?: number;
  /**
   * Skip files modified before this epoch-ms, and skip dated directories
   * whose whole day, month, or year ended more than a day before it.
   */
  since?: number;
  /** Only files whose name carries this session id (case-insensitive). */
  sessionId?: string;
  /** Include zero-byte files (default false). */
  includeEmpty?: boolean;
  /** Reuse directory listings across walks (async walker only). */
  cache?: DirectoryListingCache;
  /** With `cache`: re-stat recently modified files even in unchanged directories. */
  revalidateRecent?: boolean;
  /** Payload-free counters of what the walk cost. */
  stats?: DirectoryListingCounters;
}

export const DEFAULT_ROLLOUT_WALK_MAX_DEPTH = 6;
export const DEFAULT_ROLLOUT_WALK_MAX_FILES = 20_000;

/** Test if a filename is a Codex rollout file. */
export function isRolloutFile(filename: string): boolean {
  return filename.startsWith('rollout-') && filename.endsWith('.jsonl');
}

/**
 * Extract the session UUID from a rollout filename.
 * Format: rollout-<timestamp>-<uuid>.jsonl -> <uuid>
 */
export function extractRolloutSessionId(filename: string): string {
  const base = path.basename(filename, '.jsonl');
  // rollout-YYYYMMDD-HHMMSS-<uuid> or rollout-<timestamp>-<uuid>
  const parts = base.split('-');
  // The UUID is typically the last 5 segments (8-4-4-4-12)
  if (parts.length >= 6) {
    const possibleUuid = parts.slice(-5).join('-');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(possibleUuid)) {
      return possibleUuid;
    }
  }
  // Fallback: use everything after "rollout-"
  return base.replace(/^rollout-/, '');
}

interface WalkState {
  results: RolloutFileInfo[];
  seen: Set<string>;
  cap: number;
  maxDepth: number;
  since: number | null;
  sessionId: string | null;
  includeEmpty: boolean;
  cache: DirectoryListingCache | null;
  revalidateRecent: boolean;
  stats: DirectoryListingCounters | undefined;
}

function walkState(options: WalkRolloutFilesOptions): WalkState {
  const maxFiles = Math.max(0, options.maxFiles ?? DEFAULT_ROLLOUT_WALK_MAX_FILES);
  const limit = options.limit === undefined ? Infinity : Math.max(0, options.limit);
  return {
    results: [],
    seen: new Set(),
    cap: Math.min(maxFiles, limit),
    maxDepth: options.maxDepth ?? DEFAULT_ROLLOUT_WALK_MAX_DEPTH,
    since: options.since !== undefined && Number.isFinite(options.since) ? options.since : null,
    sessionId: options.sessionId ? options.sessionId.trim().toLowerCase() : null,
    includeEmpty: options.includeEmpty ?? false,
    cache: options.cache ?? null,
    revalidateRecent: options.revalidateRecent ?? false,
    stats: options.stats,
  };
}

/** Newest-dated first: directory and file names sort descending. */
function byNameDescending(a: fs.Dirent, b: fs.Dirent): number {
  return b.name.localeCompare(a.name);
}

function matchesFilter(state: WalkState, name: string): boolean {
  if (!isRolloutFile(name)) return false;
  return (
    state.sessionId === null || extractRolloutSessionId(name).toLowerCase() === state.sessionId
  );
}

function record(
  state: WalkState,
  fullPath: string,
  name: string,
  stat: { size: number; mtimeMs: number },
): void {
  if (!state.includeEmpty && stat.size <= 0) return;
  if (state.since !== null && stat.mtimeMs < state.since) return;
  if (state.seen.has(fullPath)) return;
  state.seen.add(fullPath);
  state.results.push({
    path: fullPath,
    mtime: new Date(stat.mtimeMs),
    sizeBytes: stat.size,
    sessionId: extractRolloutSessionId(name),
  });
}

function finish(state: WalkState): RolloutFileInfo[] {
  return state.results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Slack added to a dated directory's range so a timezone skew cannot prune a live day. */
const DATE_DIR_SLACK_MS = 24 * 60 * 60_000;

/**
 * True when `segments` (the directory names below the root, e.g. `['2026',
 * '09', '04']`) are all numeric and describe a year, month, or day that ended
 * more than a day before `since`. Non-numeric names are never pruned.
 */
export function isDatedDirectoryBefore(segments: readonly string[], since: number): boolean {
  if (segments.length === 0 || segments.length > 3) return false;
  const numbers = segments.map((segment) => (/^\d+$/.test(segment) ? Number(segment) : NaN));
  if (numbers.some((value) => !Number.isFinite(value))) return false;
  const [year, month, day] = numbers;
  if (year < 1970 || year > 9999) return false;
  if (segments.length >= 2 && (month < 1 || month > 12)) return false;
  if (segments.length === 3 && (day < 1 || day > 31)) return false;
  const rangeEnd =
    segments.length === 1
      ? new Date(year + 1, 0, 1).getTime()
      : segments.length === 2
        ? new Date(year, month, 1).getTime()
        : new Date(year, month - 1, day + 1).getTime();
  return rangeEnd + DATE_DIR_SLACK_MS < since;
}

function visitSync(state: WalkState, dir: string, depth: number, segments: string[]): void {
  if (depth > state.maxDepth || state.results.length >= state.cap) return;
  if (state.since !== null && isDatedDirectoryBefore(segments, state.since)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort(byNameDescending);

  for (const entry of entries) {
    if (state.results.length >= state.cap) return;
    if (!entry.isFile() || !matchesFilter(state, entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      record(state, fullPath, entry.name, fs.statSync(fullPath));
    } catch {
      // Skip files that vanish between readdir and stat.
    }
  }
  for (const entry of entries) {
    if (state.results.length >= state.cap) return;
    if (entry.isDirectory()) {
      visitSync(state, path.join(dir, entry.name), depth + 1, [...segments, entry.name]);
    }
  }
}

/**
 * Walk one or more `sessions` roots for rollout files, newest first.
 * Missing or unreadable directories are skipped; paths are deduplicated.
 */
export function walkRolloutFiles(
  roots: readonly string[],
  options: WalkRolloutFilesOptions = {},
): RolloutFileInfo[] {
  const state = walkState(options);
  for (const root of roots) visitSync(state, root, 0, []);
  return finish(state);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function byStringDescending(a: string, b: string): number {
  return b.localeCompare(a);
}

async function visitCached(
  state: WalkState,
  cache: DirectoryListingCache,
  dir: string,
  depth: number,
  segments: string[],
): Promise<void> {
  if (depth > state.maxDepth || state.results.length >= state.cap) return;
  if (state.since !== null && isDatedDirectoryBefore(segments, state.since)) return;
  const listing = await cache.listDirectory(dir, (name) => matchesFilter(state, name), {
    revalidateRecent: state.revalidateRecent,
    stats: state.stats,
  });
  if (!listing) return;

  const names = [...listing.files.keys()].sort(byStringDescending);
  for (const name of names) {
    if (state.results.length >= state.cap) return;
    const stat = listing.files.get(name);
    if (!stat) continue;
    record(state, path.join(dir, name), name, { size: stat.sizeBytes, mtimeMs: stat.mtimeMs });
  }
  await yieldToEventLoop();
  for (const name of [...listing.subdirectories].sort(byStringDescending)) {
    if (state.results.length >= state.cap) return;
    await visitCached(state, cache, path.join(dir, name), depth + 1, [...segments, name]);
  }
}

async function visitAsync(
  state: WalkState,
  dir: string,
  depth: number,
  segments: string[],
): Promise<void> {
  if (depth > state.maxDepth || state.results.length >= state.cap) return;
  if (state.since !== null && isDatedDirectoryBefore(segments, state.since)) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
    if (state.stats) state.stats.directoriesListed = (state.stats.directoriesListed ?? 0) + 1;
  } catch {
    return;
  }
  entries.sort(byNameDescending);

  let sinceYield = 0;
  for (const entry of entries) {
    if (state.results.length >= state.cap) return;
    if (!entry.isFile() || !matchesFilter(state, entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (state.stats) state.stats.filesStatted = (state.stats.filesStatted ?? 0) + 1;
      record(state, fullPath, entry.name, stat);
    } catch {
      // Skip files that vanish between readdir and stat.
    }
    if (++sinceYield >= 200) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  await yieldToEventLoop();
  for (const entry of entries) {
    if (state.results.length >= state.cap) return;
    if (entry.isDirectory()) {
      await visitAsync(state, path.join(dir, entry.name), depth + 1, [...segments, entry.name]);
    }
  }
}

/** Async twin of {@link walkRolloutFiles} that yields between directories. */
export async function walkRolloutFilesAsync(
  roots: readonly string[],
  options: WalkRolloutFilesOptions = {},
): Promise<RolloutFileInfo[]> {
  const state = walkState(options);
  for (const root of roots) {
    if (state.cache) await visitCached(state, state.cache, root, 0, []);
    else await visitAsync(state, root, 0, []);
  }
  return finish(state);
}
