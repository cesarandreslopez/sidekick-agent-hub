/**
 * Config path resolution and workspace encoding.
 * Mirrors patterns from sidekick-vscode/src/services/SessionPathResolver.ts
 * and TaskPersistenceService.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Environment variable that redirects the Sidekick config root. */
export const CONFIG_DIR_ENV_VAR = 'SIDEKICK_CONFIG_DIR';

let configDirOverride: string | null = null;

/**
 * The platform default config directory, ignoring both {@link setConfigDir}
 * and `SIDEKICK_CONFIG_DIR`.
 *
 * `~/.config/sidekick` on Unix, `%APPDATA%/sidekick` on Windows.
 */
export function getDefaultConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'sidekick');
  }
  return path.join(os.homedir(), '.config', 'sidekick');
}

/**
 * Redirect the Sidekick config root for this process.
 *
 * Takes precedence over `SIDEKICK_CONFIG_DIR`. Pass `null` (or an empty
 * string) to clear it. Every reader and writer in the package resolves the
 * root lazily through {@link getConfigDir}, so this takes effect immediately
 * for all of them — including transitive callers of `getProjectDataPath`,
 * `getGlobalDataPath`, and the account registry.
 *
 * Prefer `SIDEKICK_CONFIG_DIR` when the value is known before the process
 * starts: it is read fresh on every call, so it stays correct even if a
 * bundler ends up with more than one copy of this module.
 *
 * @example
 * setConfigDir(path.join(os.tmpdir(), 'sidekick-fixture'));
 * try {
 *   await addTask(project, { subject: 'isolated' });
 * } finally {
 *   setConfigDir(null);
 * }
 */
export function setConfigDir(dir: string | null | undefined): void {
  configDirOverride = dir && dir.trim() ? path.resolve(dir) : null;
}

/** The active {@link setConfigDir} override, or `null` when unset. */
export function getConfigDirOverride(): string | null {
  return configDirOverride;
}

/**
 * Gets the Sidekick config directory.
 *
 * Resolution order: {@link setConfigDir} override → `SIDEKICK_CONFIG_DIR`
 * → {@link getDefaultConfigDir}.
 */
export function getConfigDir(): string {
  if (configDirOverride) return configDirOverride;
  const fromEnv = process.env[CONFIG_DIR_ENV_VAR]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return getDefaultConfigDir();
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
