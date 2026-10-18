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

/**
 * Enumerate session files across project directories through the
 * directory cache: one stat per project directory, a readdir only for
 * directories whose mtime changed, and a stat only for files new to a
 * changed directory (or recently modified, with `revalidateRecent`).
 *
 * With `limit`, directories are visited newest-mtime first and the walk
 * stops once the remaining directories are older than the newest `limit`
 * files found. A directory's mtime ignores appends, so a cold limited walk
 * can miss a long-running session in an old directory until its next watch
 * event; `since` filters files and shares the caveat.
 */
export async function listClaudeSessionFilesAsync(
  workspacePath?: string,
  options: ListSessionFilesOptions = {},
  cache: DirectoryListingCache = new DirectoryListingCache(),
): Promise<SessionFileInfo[]> {
  const projectsRoot = getClaudeProjectsDir();
  if (options.stats) {
    options.stats.directoriesListed ??= 0;
    options.stats.directoriesStatted ??= 0;
    options.stats.filesStatted ??= 0;
  }
  const root = await cache.listDirectory(projectsRoot, () => false, {
    revalidateRecent: options.revalidateRecent,
    stats: options.stats,
  });
  if (!root) {
    return [];
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
  const matchesWorkspace = workspaceDirectoryFilter(workspacePath);

  const candidates: Array<{ directory: string; stat: fs.Stats }> = [];
  let sinceYield = 0;
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
  if (limit !== null) candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

  const byNewest = (left: SessionFileInfo, right: SessionFileInfo): number =>
    right.mtime.getTime() - left.mtime.getTime();
  const results: SessionFileInfo[] = [];
  let cutoffMs: number | null = null;
  for (const candidate of candidates) {
    if (limit !== null && cutoffMs !== null && candidate.stat.mtimeMs < cutoffMs) break;
    const listing = await cache.listDirectory(
      candidate.directory,
      (name) => name.endsWith('.jsonl'),
      {
        dirStat: candidate.stat,
        revalidateRecent: options.revalidateRecent,
        stats: options.stats,
      },
    );
    if (!listing) continue;
    for (const [name, stat] of listing.files) {
      if (stat.sizeBytes <= 0) continue;
      if (since !== null && stat.mtimeMs < since) continue;
      const sessionPath = path.join(candidate.directory, name);
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
