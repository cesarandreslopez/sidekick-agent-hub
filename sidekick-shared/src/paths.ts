/**
 * Config path resolution and workspace encoding.
 * Mirrors patterns from sidekick-vscode/src/services/SessionPathResolver.ts
 * and TaskPersistenceService.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Gets the Sidekick config directory.
 * ~/.config/sidekick on Unix, %APPDATA%/sidekick on Windows.
 */
export function getConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'sidekick');
  }
  return path.join(os.homedir(), '.config', 'sidekick');
}

/**
 * Gets the path to a project-specific data file.
 * e.g., ~/.config/sidekick/tasks/my-project.json
 */
export function getProjectDataPath(slug: string, subdomain: string): string {
  return path.join(getConfigDir(), subdomain, `${slug}.json`);
}

/**
 * Gets the path to a global data file.
 * e.g., ~/.config/sidekick/historical-data.json
 */
export function getGlobalDataPath(filename: string): string {
  return path.join(getConfigDir(), filename);
}

/**
 * Encodes a workspace path to Claude Code's directory naming scheme.
 * Replaces path separators, colons, and underscores with hyphens.
 *
 * From: sidekick-vscode/src/services/SessionPathResolver.ts:35-43
 */
export function encodeWorkspacePath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/');
  return normalized.replace(/[:/_]/g, '-');
}

/**
 * Derives a project slug from a workspace path.
 * Resolves symlinks, then encodes for use as a filename.
 */
export function getProjectSlug(cwd?: string): string {
  return resolveProjectIdentity(cwd).canonicalSlug;
}

export interface ProjectIdentity {
  cwd: string;
  resolvedCwd: string;
  canonicalSlug: string;
  legacySlug: string;
  candidates: string[];
  hasLegacyMismatch: boolean;
}

/** Resolves the canonical project identity used by all new readers and writers. */
export function resolveProjectIdentity(cwd?: string): ProjectIdentity {
  const dir = path.resolve(cwd || process.cwd());
  let resolved: string;
  try {
    resolved = fs.realpathSync(dir);
  } catch {
    resolved = dir;
  }
  const canonicalSlug = encodeWorkspacePath(resolved);
  const legacySlug = encodeWorkspacePath(dir);
  return {
    cwd: dir,
    resolvedCwd: resolved,
    canonicalSlug,
    legacySlug,
    candidates: canonicalSlug === legacySlug ? [canonicalSlug] : [canonicalSlug, legacySlug],
    hasLegacyMismatch: canonicalSlug !== legacySlug,
  };
}

/**
 * Derives a project slug WITHOUT resolving symlinks.
 * Matches the VS Code extension's behavior (encodeWorkspacePath on raw path).
 * Use this when reading data written by the extension.
 */
export function getProjectSlugRaw(cwd?: string): string {
  return resolveProjectIdentity(cwd).legacySlug;
}
