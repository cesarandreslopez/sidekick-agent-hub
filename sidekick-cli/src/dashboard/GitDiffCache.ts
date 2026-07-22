/**
 * Cached wrapper around `git diff --numstat`.
 * Returns per-file addition/deletion counts from uncommitted changes.
 * Falls back to an empty map in non-git dirs or on errors.
 */

import { execFile } from 'child_process';
import * as path from 'path';

export interface DiffStat {
  additions: number;
  deletions: number;
}

const CACHE_TTL_MS = 5_000;

export class GitDiffCache {
  private workspacePath: string;
  private cache = new Map<string, DiffStat>();
  private cacheTime = 0;
  private repoRoot: string | null = null;
  private refreshInFlight = false;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  getStats(): Map<string, DiffStat> {
    const now = Date.now();
    if (now - this.cacheTime >= CACHE_TTL_MS) this.refreshAsync();
    return this.cache;
  }

  /** Return the asynchronously resolved git repo root, if available. */
  getRepoRoot(): string | null {
    return this.repoRoot;
  }

  private refreshAsync(): void {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        cwd: this.workspacePath,
        timeout: 3_000,
        encoding: 'utf-8',
      },
      (rootError, stdout) => {
        if (rootError) {
          this.finishRefresh(new Map());
          return;
        }
        this.repoRoot = String(stdout).trim();
        execFile(
          'git',
          ['diff', 'HEAD', '--numstat'],
          { cwd: this.workspacePath, timeout: 3_000, encoding: 'utf-8' },
          (diffError, output) => {
            const stats = new Map<string, DiffStat>();
            if (!diffError) {
              for (const line of String(output).split('\n')) {
                if (!line.trim()) continue;
                const [add, del, file] = line.split('\t');
                if (!file) continue;
                stats.set(file, {
                  additions: add === '-' ? 0 : parseInt(add, 10) || 0,
                  deletions: del === '-' ? 0 : parseInt(del, 10) || 0,
                });
              }
            }
            this.finishRefresh(stats);
          },
        );
      },
    );
  }

  private finishRefresh(stats: Map<string, DiffStat>): void {
    this.cache = stats;
    this.cacheTime = Date.now();
    this.refreshInFlight = false;
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
