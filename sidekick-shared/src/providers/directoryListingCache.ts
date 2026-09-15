/**
 * Directory listings keyed by path and validated by the directory's own
 * mtime and inode.
 *
 * A create, delete, or rename inside a directory bumps that directory's
 * mtime; an append to an existing file does not. So a listing can be reused
 * for as long as the directory's mtime and inode are unchanged, and the per
 * file size/mtime it carries is only refreshed by `refreshFile()` (the watch
 * event path) or by `revalidateRecent` on catch-up passes. Full discovery is
 * then one stat per directory instead of one readdir per directory plus one
 * stat per file.
 *
 * @module providers/directoryListingCache
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CachedFileStat {
  sizeBytes: number;
  mtimeMs: number;
}

export interface CachedDirectoryListing {
  /** Directory mtime when the listing was taken. */
  mtimeMs: number;
  ino: number;
  /** Wall-clock time the listing was taken (coarse-mtime guard). */
  listedAtMs: number;
  /** Files accepted by the caller's filter, with the stat seen last. */
  files: Map<string, CachedFileStat>;
  /** Subdirectory names, unsorted. */
  subdirectories: string[];
}

/** Payload-free counters a caller can pass to measure what a pass cost. */
export interface DirectoryListingCounters {
  directoriesListed?: number;
  directoriesStatted?: number;
  filesStatted?: number;
}

export interface DirectoryListingCacheOptions {
  /** Bound on cached directories, least-recently-used first (default 10 000). */
  maxDirectories?: number;
  /**
   * Files whose cached mtime is within this window are re-stat'ed when a
   * caller asks for `revalidateRecent` (default 30 minutes).
   */
  recentWindowMs?: number;
}

export interface ListDirectoryOptions {
  /** Re-stat files modified within the recent window even if the directory is unchanged. */
  revalidateRecent?: boolean;
  /** A stat of the directory the caller already took; saves one syscall. */
  dirStat?: fs.Stats;
  stats?: DirectoryListingCounters;
}

export const DEFAULT_DIRECTORY_CACHE_MAX_DIRECTORIES = 10_000;
export const DEFAULT_DIRECTORY_CACHE_RECENT_WINDOW_MS = 30 * 60_000;

/**
 * A directory whose mtime is within this many milliseconds of the moment it
 * was listed may still receive entries that land on the same coarse mtime
 * (HFS+, exFAT, SMB), so it is re-listed rather than trusted.
 */
const COARSE_MTIME_GUARD_MS = 2_000;

export class DirectoryListingCache {
  private readonly listings = new Map<string, CachedDirectoryListing>();
  private readonly maxDirectories: number;
  private readonly recentWindowMs: number;

  constructor(options: DirectoryListingCacheOptions = {}) {
    this.maxDirectories = Math.max(
      1,
      Math.floor(options.maxDirectories ?? DEFAULT_DIRECTORY_CACHE_MAX_DIRECTORIES),
    );
    this.recentWindowMs = Math.max(
      0,
      options.recentWindowMs ?? DEFAULT_DIRECTORY_CACHE_RECENT_WINDOW_MS,
    );
  }

  get size(): number {
    return this.listings.size;
  }

  /** The cached listing without touching the filesystem, if any. */
  peek(dir: string): CachedDirectoryListing | undefined {
    return this.listings.get(dir);
  }

  /**
   * List `dir`, reusing the cached listing when the directory is unchanged.
   * Returns null when `dir` is missing, unreadable, or not a directory.
   */
  async listDirectory(
    dir: string,
    accept: (name: string) => boolean,
    options: ListDirectoryOptions = {},
  ): Promise<CachedDirectoryListing | null> {
    let dirStat = options.dirStat;
    if (!dirStat) {
      try {
        dirStat = await fs.promises.stat(dir);
        count(options.stats, 'directoriesStatted');
      } catch {
        this.listings.delete(dir);
        return null;
      }
    }
    if (!dirStat.isDirectory()) {
      this.listings.delete(dir);
      return null;
    }

    const cached = this.listings.get(dir);
    const unchanged =
      cached !== undefined &&
      cached.mtimeMs === dirStat.mtimeMs &&
      cached.ino === dirStat.ino &&
      dirStat.mtimeMs < cached.listedAtMs - COARSE_MTIME_GUARD_MS;
    if (cached && unchanged) {
      this.touch(dir, cached);
      if (options.revalidateRecent) await this.revalidateRecent(dir, cached, options.stats);
      return cached;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
      count(options.stats, 'directoriesListed');
    } catch {
      this.listings.delete(dir);
      return null;
    }

    const listedAtMs = Date.now();
    const files = new Map<string, CachedFileStat>();
    const subdirectories: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        subdirectories.push(entry.name);
        continue;
      }
      const isCandidateFile = entry.isFile() && accept(entry.name);
      if (!isCandidateFile && !entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      // A file already in the listing keeps its cached stat unless it is
      // recent enough to be live; a directory change is a create, delete, or
      // rename, and only the new names need a fresh stat.
      const previous = cached?.files.get(entry.name);
      if (isCandidateFile && previous && !this.isRecent(previous, listedAtMs)) {
        files.set(entry.name, previous);
        continue;
      }
      if (entry.isSymbolicLink() && !accept(entry.name)) {
        // Symlinked directories are followed so linked project folders count.
        try {
          const target = await fs.promises.stat(fullPath);
          count(options.stats, 'directoriesStatted');
          if (target.isDirectory()) subdirectories.push(entry.name);
        } catch {
          // Dangling link.
        }
        continue;
      }
      try {
        const stat = await fs.promises.stat(fullPath);
        count(options.stats, 'filesStatted');
        if (stat.isFile()) files.set(entry.name, { sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
        else if (stat.isDirectory()) subdirectories.push(entry.name);
      } catch {
        // Vanished between readdir and stat.
      }
    }

    const listing: CachedDirectoryListing = {
      mtimeMs: dirStat.mtimeMs,
      ino: dirStat.ino,
      listedAtMs,
      files,
      subdirectories,
    };
    this.touch(dir, listing);
    return listing;
  }

  /**
   * Stat one file and reflect the result in its parent's cached listing when
   * that listing exists. Returns null when the path is missing or not a file.
   * Never creates a listing: a partial listing must not pass for a full one.
   */
  async refreshFile(
    fullPath: string,
    stats?: DirectoryListingCounters,
  ): Promise<CachedFileStat | null> {
    const dir = path.dirname(fullPath);
    const name = path.basename(fullPath);
    const listing = this.listings.get(dir);
    try {
      const stat = await fs.promises.stat(fullPath);
      count(stats, 'filesStatted');
      if (!stat.isFile()) {
        listing?.files.delete(name);
        return null;
      }
      const fileStat = { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
      listing?.files.set(name, fileStat);
      return fileStat;
    } catch {
      listing?.files.delete(name);
      return null;
    }
  }

  /** Drop one directory's listing, or every listing. */
  invalidate(dir?: string): void {
    if (dir === undefined) this.listings.clear();
    else this.listings.delete(dir);
  }

  private async revalidateRecent(
    dir: string,
    listing: CachedDirectoryListing,
    stats?: DirectoryListingCounters,
  ): Promise<void> {
    const now = Date.now();
    for (const [name, cached] of [...listing.files]) {
      if (!this.isRecent(cached, now)) continue;
      await this.refreshFile(path.join(dir, name), stats);
    }
  }

  private isRecent(stat: CachedFileStat, now: number): boolean {
    return now - stat.mtimeMs <= this.recentWindowMs;
  }

  private touch(dir: string, listing: CachedDirectoryListing): void {
    this.listings.delete(dir);
    this.listings.set(dir, listing);
    while (this.listings.size > this.maxDirectories) {
      const oldest = this.listings.keys().next().value;
      if (oldest === undefined) break;
      this.listings.delete(oldest);
    }
  }
}

/**
 * Split a watcher-reported root-relative path into segments. Both separators
 * are accepted (Windows watchers report backslashes). Returns null for an
 * empty path or one that escapes the root.
 */
export function splitWatchedPath(relativePath: string): string[] | null {
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments;
}

function count(stats: DirectoryListingCounters | undefined, field: keyof DirectoryListingCounters) {
  if (!stats) return;
  stats[field] = (stats[field] ?? 0) + 1;
}
