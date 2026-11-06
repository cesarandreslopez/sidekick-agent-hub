/**
 * The on-disk layout of a Codex home: where the `codex` CLI keeps its home,
 * the rollout directories below it, and how rollout files are named.
 *
 * Dependency-free (Node's `os` and `path` only) and filesystem-free, so hook
 * bundles can classify rollout paths without loading the providers.
 * `codexPaths` and `providers/rolloutWalker` re-export everything here.
 *
 * @module codexLayout
 */

import * as os from 'os';
import * as path from 'path';

/** Where Codex writes live rollouts, below each home. */
export const CODEX_SESSIONS_SUBDIR = 'sessions';
/** Where Codex moves a rollout when its thread is archived, below each home. */
export const CODEX_ARCHIVED_SESSIONS_SUBDIR = 'archived_sessions';

/** `~/.codex`. */
export function getDefaultSystemCodexHome(): string {
  return path.join(os.homedir(), '.codex');
}

/** A non-blank `CODEX_HOME` in `env` (default `process.env`), else null. */
export function getExplicitCodexHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const explicitHome = env.CODEX_HOME?.trim();
  return explicitHome ? explicitHome : null;
}

/**
 * The home the `codex` CLI reads for an environment (default this process's):
 * `CODEX_HOME` or `~/.codex`.
 */
export function getSystemCodexHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return getExplicitCodexHome(env) ?? getDefaultSystemCodexHome();
}

/** Test if a filename is a Codex rollout file (`rollout-….jsonl`; not compressed ones). */
export function isRolloutFile(filename: string): boolean {
  return filename.startsWith('rollout-') && filename.endsWith('.jsonl');
}

/** Test if a filename is a compressed Codex rollout (`rollout-….jsonl.zst`). */
export function isCompressedRolloutFile(filename: string): boolean {
  return filename.startsWith('rollout-') && filename.endsWith('.jsonl.zst');
}

/**
 * Extract the session UUID from a rollout filename.
 * Format: rollout-<timestamp>-<uuid>.jsonl (or .jsonl.zst) -> <uuid>
 */
export function extractRolloutSessionId(filename: string): string {
  const name = path.basename(filename);
  const base = name.endsWith('.jsonl.zst')
    ? name.slice(0, -'.jsonl.zst'.length)
    : path.basename(name, '.jsonl');
  // rollout-YYYYMMDD-HHMMSS-<uuid> or rollout-<timestamp>-<uuid>
  const parts = base.split('-');
  // The UUID is typically the last 5 segments (8-4-4-4-12)
  if (parts.length >= 6) {
    const possibleUuid = parts.slice(-5).join('-');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(possibleUuid)) {
      return possibleUuid;
    }
  }
  // Fallback: use everything after "rollout-"
  return base.replace(/^rollout-/, '');
}
