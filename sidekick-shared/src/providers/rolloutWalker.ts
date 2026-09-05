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
 * With `limit`, the early exit is by directory date: a rollout that was
 * created days ago but is still being written lands in its creation day's
 * directory, so a very small limit can miss it in favour of newer-dated,
 * older-modified files. Callers that need exact mtime order over the whole
 * history omit `limit` (the `maxFiles` cap still applies).
 *
 * @module providers/rolloutWalker
 */

import * as fs from 'fs';
import * as path from 'path';

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
  /** Only files whose name carries this session id (case-insensitive). */
  sessionId?: string;
  /** Include zero-byte files (default false). */
  includeEmpty?: boolean;
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
  sessionId: string | null;
  includeEmpty: boolean;
}

function walkState(options: WalkRolloutFilesOptions): WalkState {
  const maxFiles = Math.max(0, options.maxFiles ?? DEFAULT_ROLLOUT_WALK_MAX_FILES);
  const limit = options.limit === undefined ? Infinity : Math.max(0, options.limit);
  return {
    results: [],
    seen: new Set(),
    cap: Math.min(maxFiles, limit),
    maxDepth: options.maxDepth ?? DEFAULT_ROLLOUT_WALK_MAX_DEPTH,
    sessionId: options.sessionId ? options.sessionId.trim().toLowerCase() : null,
    includeEmpty: options.includeEmpty ?? false,
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

function record(state: WalkState, fullPath: string, name: string, stat: fs.Stats): void {
  if (!state.includeEmpty && stat.size <= 0) return;
  if (state.seen.has(fullPath)) return;
  state.seen.add(fullPath);
  state.results.push({
    path: fullPath,
    mtime: stat.mtime,
    sizeBytes: stat.size,
    sessionId: extractRolloutSessionId(name),
  });
}

function finish(state: WalkState): RolloutFileInfo[] {
  return state.results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function visitSync(state: WalkState, dir: string, depth: number): void {
  if (depth > state.maxDepth || state.results.length >= state.cap) return;
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
    if (entry.isDirectory()) visitSync(state, path.join(dir, entry.name), depth + 1);
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
  for (const root of roots) visitSync(state, root, 0);
  return finish(state);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function visitAsync(state: WalkState, dir: string, depth: number): Promise<void> {
  if (depth > state.maxDepth || state.results.length >= state.cap) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
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
      record(state, fullPath, entry.name, await fs.promises.stat(fullPath));
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
    if (entry.isDirectory()) await visitAsync(state, path.join(dir, entry.name), depth + 1);
  }
}

/** Async twin of {@link walkRolloutFiles} that yields between directories. */
export async function walkRolloutFilesAsync(
  roots: readonly string[],
  options: WalkRolloutFilesOptions = {},
): Promise<RolloutFileInfo[]> {
  const state = walkState(options);
  for (const root of roots) await visitAsync(state, root, 0);
  return finish(state);
}
