/**
 * Workspace-root expansion shared by the session readers: realpath each root
 * and, optionally, add its git worktree siblings.
 *
 * @module workspaceRoots
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveGitWorktrees } from './gitWorktrees';

export interface ResolveWorkspaceRootsOptions {
  /**
   * Add the main checkout and every git worktree of each root (see
   * `resolveGitWorktrees()`; bare, `--separate-git-dir` and relative-path
   * layouts included, a submodule never expanding to its superproject).
   * Default true.
   */
  includeWorktrees?: boolean;
}

export interface ResolvedWorkspaceRoots {
  /** Realpaths of the roots, after worktree expansion; scope checks use these. */
  roots: string[];
  /** The roots plus their unresolved spellings, for listing session files. */
  listingRoots: string[];
}

/** Realpath of an absolute path, or null when it does not resolve. */
export function realpathOrNull(
  input: string,
  cache: Map<string, string | null> = new Map(),
): string | null {
  const cached = cache.get(input);
  if (cached !== undefined) return cached;
  let resolved: string | null = null;
  try {
    resolved = path.isAbsolute(input) ? fs.realpathSync.native(input) : null;
  } catch {
    resolved = null;
  }
  cache.set(input, resolved);
  return resolved;
}

/**
 * The realpath of a recorded working directory when it is one of `roots` or
 * below one, else null. Fails closed: a non-string, empty, relative, or
 * unresolvable `cwd` (a deleted directory, for instance) is never in scope.
 * `roots` must already be realpaths (see `resolveWorkspaceRoots`).
 */
export function pathWithinRoots(
  cwd: unknown,
  roots: readonly string[],
  realpaths: Map<string, string | null> = new Map(),
): string | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const real = realpathOrNull(cwd, realpaths);
  if (!real) return null;
  for (const root of roots) {
    if (real === root) return real;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (real.startsWith(prefix)) return real;
  }
  return null;
}

/**
 * Realpaths each absolute root and, by default, adds its main checkout and
 * git worktree siblings. Relative and unresolvable roots are dropped.
 */
export function resolveWorkspaceRoots(
  workspacePaths: string[],
  options: ResolveWorkspaceRootsOptions = {},
  realpaths: Map<string, string | null> = new Map(),
): ResolvedWorkspaceRoots {
  const includeWorktrees = options.includeWorktrees !== false;
  const roots = new Set<string>();
  const listingRoots = new Set<string>();
  const add = (candidate: string): void => {
    const real = realpathOrNull(candidate, realpaths);
    if (!real) return;
    roots.add(real);
    listingRoots.add(real);
    listingRoots.add(path.resolve(candidate));
  };
  for (const workspacePath of workspacePaths) {
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) continue;
    add(workspacePath);
    if (!includeWorktrees) continue;
    const real = realpathOrNull(workspacePath, realpaths);
    if (!real) continue;
    // The main checkout and every linked worktree, read from the git layout
    // (a bare repository directory holds no checkout, so it is not a root).
    for (const worktree of resolveGitWorktrees(real)?.worktrees ?? []) {
      if (worktree.kind !== 'bare') add(worktree.path);
    }
  }
  return { roots: [...roots], listingRoots: [...listingRoots] };
}
