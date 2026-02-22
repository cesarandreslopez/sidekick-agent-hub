/**
 * Cached wrapper around `git diff --numstat`.
 * Returns per-file addition/deletion counts from uncommitted changes.
 * Falls back to an empty map in non-git dirs or on errors.
 */

import { execSync } from 'child_process';
import * as path from 'path';

export interface DiffStat {
  additions: number;
  deletions: number;
}

const CACHE_TTL_MS = 5_000;

export class GitDiffCache {
  private workspacePath: string;
  private cache: Map<string, DiffStat> | null = null;
  private cacheTime = 0;
  private repoRoot: string | null = null;
  private repoRootResolved = false;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  getStats(): Map<string, DiffStat> {
    const now = Date.now();
    if (this.cache && now - this.cacheTime < CACHE_TTL_MS) {
      return this.cache;
    }

    this.cache = this.fetchStats();
    this.cacheTime = now;
    return this.cache;
  }

  /** Resolve the git repo root (cached). Returns null if not a git repo. */
  getRepoRoot(): string | null {
    if (this.repoRootResolved) return this.repoRoot;
    this.repoRootResolved = true;
    try {
      this.repoRoot = execSync('git rev-parse --show-toplevel', {
        cwd: this.workspacePath,
        timeout: 3_000,
        encoding: 'utf-8',
      }).trim();
    } catch {
      this.repoRoot = null;
    }
    return this.repoRoot;
  }

  private fetchStats(): Map<string, DiffStat> {
    const stats = new Map<string, DiffStat>();
    const root = this.getRepoRoot();
    if (!root) return stats;

    try {
      // Include both staged and unstaged changes
      const output = execSync('git diff HEAD --numstat', {
        cwd: this.workspacePath,
        timeout: 3_000,
        encoding: 'utf-8',
      });

      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        const [add, del, file] = line.split('\t');
        if (!file) continue;
        // Binary files show '-' for add/del
        const additions = add === '-' ? 0 : parseInt(add, 10) || 0;
        const deletions = del === '-' ? 0 : parseInt(del, 10) || 0;
        stats.set(file, { additions, deletions });
      }
    } catch {
      // git command failed — return empty stats
    }

    return stats;
  }

  /**
   * Resolve an absolute file path to a repo-relative path for lookup.
   * Returns the original path if it's already relative or can't be resolved.
   */
  toRelative(absolutePath: string): string {
    const root = this.getRepoRoot();
    if (!root) return absolutePath;

    // Already relative
    if (!path.isAbsolute(absolutePath)) return absolutePath;

    const rel = path.relative(root, absolutePath);
    // If the relative path escapes the repo, return as-is
    if (rel.startsWith('..')) return absolutePath;
    return rel;
  }
}
