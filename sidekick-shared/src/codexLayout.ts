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

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The dated folders (`YYYY/MM/DD`, relative to a `sessions/` directory)
 * where Codex most likely wrote the rollout of thread `threadId`.
 *
 * Codex thread ids are UUIDv7: their first 48 bits are the creation time in
 * epoch milliseconds, and Codex files the rollout under the creating
 * machine's local date of that instant. Every real time zone lies within a
 * day of UTC, so the UTC date and the days either side of it always include
 * that folder, whatever time zone the reader runs in. Returns those three
 * folders (the UTC date first), or `[]` for an id that is not a UUIDv7.
 * Pure: no filesystem access.
 */
export function codexRolloutDayCandidates(threadId: string): string[] {
  const id = typeof threadId === 'string' ? threadId.trim().toLowerCase() : '';
  if (!UUID_V7.test(id)) return [];
  const created = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  const pad = (value: number) => String(value).padStart(2, '0');
  const folders: string[] = [];
  for (const offset of [0, -DAY_MS, DAY_MS]) {
    const day = new Date(created + offset);
    const year = day.getUTCFullYear();
    if (year < 1970 || year > 9999) continue;
    folders.push(path.join(String(year), pad(day.getUTCMonth() + 1), pad(day.getUTCDate())));
  }
  return folders;
}
