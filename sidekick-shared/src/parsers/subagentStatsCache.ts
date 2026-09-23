/**
 * Memoizes per-transcript subagent stats by file size and mtime.
 *
 * Dashboards rescan a session's subagents on a timer, and one parent can own
 * a hundred subagent transcripts of several MB each. An unchanged transcript
 * now costs one `stat` instead of a full parse. Callers treat the returned
 * stats as read-only.
 *
 * Node-only: stats files.
 *
 * @module parsers/subagentStatsCache
 */

import * as fs from 'fs';
import type { SubagentStats } from '../types/sessionEvent';

const MAX_ENTRIES = 1024;

interface Entry {
  size: number;
  mtimeMs: number;
  stats: SubagentStats | null;
}

const cache = new Map<string, Entry>();

/** Stats for one subagent transcript, parsed again only when the file changed. */
export function cachedSubagentStats(
  filePath: string,
  compute: () => SubagentStats | null,
): SubagentStats | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cache.delete(filePath);
    return compute();
  }
  const hit = cache.get(filePath);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    cache.delete(filePath);
    cache.set(filePath, hit);
    return hit.stats;
  }
  const stats = compute();
  cache.delete(filePath);
  cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, stats });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return stats;
}

/** @internal Test hook. */
export function clearSubagentStatsCache(): void {
  cache.clear();
}
