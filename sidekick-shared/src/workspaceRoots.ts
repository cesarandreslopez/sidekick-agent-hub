/**
 * Workspace-root expansion shared by the session readers: realpath each root
 * and, optionally, add its git worktree siblings.
 *
 * @module workspaceRoots
 */

import * as fs from 'fs';
import * as path from 'path';
import { discoverWorktreeSiblings, resolveWorktreeMainRepo } from './parsers/sessionPathResolver';

export interface ResolveWorkspaceRootsOptions {
  /** Add the main checkout and every git worktree of each root. Default true. */
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
    const mainRepo = resolveWorktreeMainRepo(real) ?? real;
    add(mainRepo);
    for (const sibling of discoverWorktreeSiblings(mainRepo)) add(sibling);
  }
  return { roots: [...roots], listingRoots: [...listingRoots] };
}
