/**
 * Claude Code session-file listing, kept apart from the provider class so a
 * caller that only lists files does not bundle the provider's stats,
 * context and transcript code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getClaudeProjectsDir } from '../claudePaths';
import { encodeWorkspacePath as encodeWsPath } from '../parsers/sessionPathResolver';
import { DirectoryListingCache } from './directoryListingCache';
import type { ListSessionFilesOptions, SessionFileInfo } from './types';

/** Bytes `readClaudeSessionCwdAsync` reads at most before giving up. */
export const CLAUDE_CWD_SCAN_BYTES = 1024 * 1024;

const CWD_CACHE_LIMIT = 5000;
const cwdCache = new Map<string, string>();

/**
 * The first working directory a Claude Code session file records (the
 * top-level `cwd` of its earliest record that has one), streaming at most
 * `maxBytes` (default 1 MiB) from the start. Null when none is found in
 * that prefix or the file cannot be read. A found cwd is cached per path
 * (it never changes); a miss is not, since the line may not be written yet.
 */
export async function readClaudeSessionCwdAsync(
  sessionPath: string,
  maxBytes = CLAUDE_CWD_SCAN_BYTES,
): Promise<string | null> {
  const cached = cwdCache.get(sessionPath);
  if (cached !== undefined) return cached;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(sessionPath, 'r');
    const chunkSize = 64 * 1024;
    let offset = 0;
    let pending = '';
    while (offset < maxBytes) {
      const buffer = Buffer.alloc(Math.min(chunkSize, maxBytes - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      pending += buffer.toString('utf8', 0, bytesRead);
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.includes('"cwd"')) continue;
        try {
          const record = JSON.parse(line) as { cwd?: unknown };
          if (typeof record?.cwd === 'string' && record.cwd) {
            if (cwdCache.size >= CWD_CACHE_LIMIT) {
              const oldest = cwdCache.keys().next().value;
              if (oldest !== undefined) cwdCache.delete(oldest);
            }
            cwdCache.set(sessionPath, record.cwd);
            return record.cwd;
          }
        } catch {
          // A malformed line; keep looking.
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Matches project directory names that may hold sessions for `workspacePath`. */
export function workspaceDirectoryFilter(
  workspacePath?: string,
): (directoryName: string) => boolean {
  if (!workspacePath) return () => true;
  const encodedWorkspace = encodeWsPath(workspacePath).toLowerCase();
  const workspaceBasename = path
    .basename(workspacePath)
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase();
  return (directoryName) => {
    const name = directoryName.toLowerCase();
    return (
      name === encodedWorkspace ||
      name.startsWith(`${encodedWorkspace}-`) ||
      name === workspaceBasename ||
      name.endsWith(`-${workspaceBasename}`)
    );
  };
}

/** Options for {@link listClaudeSessionFilesAsync}. */
export interface ListClaudeSessionFilesOptions extends ListSessionFilesOptions {
  /**
   * `projects/` directories to walk, one per Claude Code home (default the
   * live home's). Files are deduplicated by path across them.
   */
  projectsDirs?: readonly string[];
  /**
   * Which project directories to list, by name; replaces the
   * `workspacePath` filter (so one walk can serve several roots).
   */
  directoryFilter?: (directoryName: string) => boolean;
}

/**
 * Enumerate session files across project directories through the
 * directory cache: one stat per project directory, a readdir only for
 * directories whose mtime changed, and a stat only for files new to a
 * changed directory (or recently modified, with `revalidateRecent`; every
 * file, with `revalidateAll`).
 *
 * With `limit`, directories are visited newest-mtime first and the walk
 * stops once the remaining directories are older than the newest `limit`
 * files found. A directory's mtime ignores appends, so a cold limited walk
 * can miss a long-running session in an old directory until its next watch
 * event; `since` filters files and shares the caveat.
 */
export async function listClaudeSessionFilesAsync(
  workspacePath?: string,
  options: ListClaudeSessionFilesOptions = {},
  cache: DirectoryListingCache = new DirectoryListingCache(),
): Promise<SessionFileInfo[]> {
  const projectsRoots = [...new Set(options.projectsDirs ?? [getClaudeProjectsDir()])];
  if (options.stats) {
    options.stats.directoriesListed ??= 0;
    options.stats.directoriesStatted ??= 0;
    options.stats.filesStatted ??= 0;
  }

  const limit =
    options.limit !== undefined && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : null;
  if (limit === 0) {
    return [];
  }
  const since =
    options.since !== undefined && Number.isFinite(options.since) ? options.since : null;
  const matchesWorkspace = options.directoryFilter ?? workspaceDirectoryFilter(workspacePath);

  const candidates: Array<{ directory: string; stat: fs.Stats }> = [];
  let sinceYield = 0;
  for (const projectsRoot of projectsRoots) {
    const root = await cache.listDirectory(projectsRoot, () => false, {
      revalidateRecent: options.revalidateRecent,
      revalidateAll: options.revalidateAll,
      stats: options.stats,
    });
    if (!root) continue;
    for (const name of root.subdirectories) {
      if (!matchesWorkspace(name)) continue;
      const directory = path.join(projectsRoot, name);
      try {
        const stat = await fs.promises.stat(directory);
        if (options.stats) {
          options.stats.directoriesStatted = (options.stats.directoriesStatted ?? 0) + 1;
        }
        if (stat.isDirectory()) candidates.push({ directory, stat });
      } catch {
        continue;
      }
      if (++sinceYield >= 50) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  if (candidates.length === 0) return [];
  if (limit !== null) candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

  const byNewest = (left: SessionFileInfo, right: SessionFileInfo): number =>
    right.mtime.getTime() - left.mtime.getTime();
  const results: SessionFileInfo[] = [];
  const seen = new Set<string>();
  let cutoffMs: number | null = null;
  for (const candidate of candidates) {
    if (limit !== null && cutoffMs !== null && candidate.stat.mtimeMs < cutoffMs) break;
    const listing = await cache.listDirectory(
      candidate.directory,
      (name) => name.endsWith('.jsonl'),
      {
        dirStat: candidate.stat,
        revalidateRecent: options.revalidateRecent,
        revalidateAll: options.revalidateAll,
        stats: options.stats,
      },
    );
    if (!listing) continue;
    for (const [name, stat] of listing.files) {
      if (stat.sizeBytes <= 0) continue;
      if (since !== null && stat.mtimeMs < since) continue;
      const sessionPath = path.join(candidate.directory, name);
      if (seen.has(sessionPath)) continue;
      seen.add(sessionPath);
      results.push({
        path: sessionPath,
        mtime: new Date(stat.mtimeMs),
        sizeBytes: stat.sizeBytes,
        sessionId: path.basename(sessionPath, '.jsonl'),
      });
    }
    if (limit !== null && results.length >= limit) {
      results.sort(byNewest);
      results.length = limit;
      cutoffMs = results[limit - 1].mtime.getTime();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  results.sort(byNewest);
  return limit !== null && results.length > limit ? results.slice(0, limit) : results;
}
