/**
 * Find a session's transcript by id: a Claude Code session file or a Codex
 * rollout, without loading the providers.
 *
 * Dependency-free (Node's `fs` and `path`, plus the other `agentPaths`
 * modules), for hook and launcher bundles. Never throws: a malformed id,
 * unreadable homes, or no match give null.
 *
 * @module agentTranscriptLookup
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveAgentHomes, type AgentHomesEnv, type SessionHomesOptions } from './agentHomes';
import { CLAUDE_PROJECTS_SUBDIR, encodeClaudeWorkspacePath } from './claudePaths';
import {
  CODEX_ARCHIVED_SESSIONS_SUBDIR,
  CODEX_SESSIONS_SUBDIR,
  codexRolloutDayCandidates,
  extractRolloutSessionId,
  isCompressedRolloutFile,
  isRolloutFile,
} from './codexLayout';

/** Project folders {@link findClaudeSessionFile} checks by default, across homes. */
export const DEFAULT_MAX_CLAUDE_PROJECT_DIRS = 2000;
/** Directories the fallback walk of {@link locateCodexRolloutFile} lists by default. */
const DEFAULT_MAX_ROLLOUT_DIRS = 5000;
/** Deepest directory below a sessions root the fallback walk visits (dated trees are 3). */
const MAX_ROLLOUT_DEPTH = 6;
const MAX_ID_LENGTH = 256;
/** A session id that names one file: no separators, not dot-leading. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface LookupHomesOptions {
  /** Environment for `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `HOME` (default `process.env`). */
  env?: AgentHomesEnv;
  /** Candidate start folders of the agent, as in `resolveAgentHomes()`. */
  agentCwds?: readonly string[];
}

export interface FindClaudeSessionFileOptions extends LookupHomesOptions {
  /**
   * Claude Code homes to search (see `SessionHomesOptions`). Omitted, they
   * follow `env` and the user's home; invalid entries are skipped.
   */
  homes?: Pick<SessionHomesOptions, 'claudeHomes'>;
  /**
   * The session's workspace folder, absolute. Its project folder (Claude
   * Code's encoding of the path, and of its realpath) is checked first in
   * each home, with no directory listing.
   */
  workspacePath?: string;
  /**
   * Upper bound on project folders the scan checks, across homes (default
   * {@link DEFAULT_MAX_CLAUDE_PROJECT_DIRS}). The workspace check does not
   * count against it.
   */
  maxProjectDirs?: number;
}

export interface LocateCodexRolloutFileOptions extends LookupHomesOptions {
  /**
   * Codex homes to search (see `SessionHomesOptions`). Omitted, they follow
   * `env` and the user's home (never sidekick account-profile homes);
   * invalid entries are skipped.
   */
  homes?: Pick<SessionHomesOptions, 'codexHomes'>;
  /** Also search `archived_sessions/` (default true). */
  includeArchived?: boolean;
  /** Also match a compressed rollout (`.jsonl.zst`) when no `.jsonl` exists (default false). */
  includeCompressed?: boolean;
  /** Upper bound on directories the fallback walk lists, across homes (default 5000). */
  maxDirs?: number;
}

function validHomes(homes: readonly string[] | undefined): string[] | undefined {
  if (homes === undefined) return undefined;
  if (!Array.isArray(homes)) return [];
  return homes.filter(
    (home) => typeof home === 'string' && home.trim() !== '' && path.isAbsolute(home),
  );
}

function budget(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function fileMtime(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The transcript of Claude Code session `sessionId`
 * (`<home>/projects/<project>/<id>.jsonl`), or null.
 *
 * With `workspacePath`, that workspace's project folder is checked first and
 * a hit there is returned at once. Otherwise (or on a miss) the project
 * folders of every home are checked, up to `maxProjectDirs`, and the most
 * recently modified copy wins. The id must be a single file name (letters,
 * digits, `.`, `_`, `-`; not dot-leading), so it can never point outside a
 * project folder.
 */
export function findClaudeSessionFile(
  sessionId: string,
  options: FindClaudeSessionFileOptions = {},
): string | null {
  try {
    if (
      typeof sessionId !== 'string' ||
      sessionId.length > MAX_ID_LENGTH ||
      !SESSION_ID.test(sessionId)
    ) {
      return null;
    }
    const homes = resolveAgentHomes({
      claudeHomes: validHomes(options.homes?.claudeHomes),
      codexHomes: [],
      ...(options.env ? { env: options.env } : {}),
      ...(options.agentCwds ? { agentCwds: options.agentCwds } : {}),
    }).claude;
    const name = `${sessionId}.jsonl`;

    const workspace = options.workspacePath;
    if (typeof workspace === 'string' && path.isAbsolute(workspace)) {
      const folders = new Set([encodeClaudeWorkspacePath(path.resolve(workspace))]);
      try {
        folders.add(encodeClaudeWorkspacePath(fs.realpathSync.native(workspace)));
      } catch {
        // A deleted workspace keeps its recorded spelling.
      }
      for (const home of homes) {
        for (const folder of folders) {
          const file = path.join(home, CLAUDE_PROJECTS_SUBDIR, folder, name);
          if (fileMtime(file) !== null) return file;
        }
      }
    }

    let remaining = budget(options.maxProjectDirs, DEFAULT_MAX_CLAUDE_PROJECT_DIRS);
    let best: { file: string; mtime: number } | null = null;
    for (const home of homes) {
      const projects = path.join(home, CLAUDE_PROJECTS_SUBDIR);
      for (const entry of listDir(projects)) {
        if (remaining <= 0) break;
        if (!entry.isDirectory()) continue;
        remaining--;
        const file = path.join(projects, entry.name, name);
        const mtime = fileMtime(file);
        if (mtime !== null && (best === null || mtime > best.mtime)) best = { file, mtime };
      }
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}

interface RolloutHit {
  file: string;
  mtime: number;
  compressed: boolean;
}

function collectRollouts(
  dir: string,
  id: string,
  includeCompressed: boolean,
  hits: RolloutHit[],
): fs.Dirent[] {
  const entries = listDir(dir);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const compressed = isCompressedRolloutFile(entry.name);
    if (!isRolloutFile(entry.name) && !(includeCompressed && compressed)) continue;
    if (extractRolloutSessionId(entry.name).toLowerCase() !== id) continue;
    const file = path.join(dir, entry.name);
    const mtime = fileMtime(file);
    if (mtime !== null) hits.push({ file, mtime, compressed });
  }
  return entries;
}

function walkRollouts(
  dir: string,
  depth: number,
  id: string,
  includeCompressed: boolean,
  hits: RolloutHit[],
  remaining: { dirs: number },
): void {
  if (depth > MAX_ROLLOUT_DEPTH || remaining.dirs <= 0) return;
  remaining.dirs--;
  const entries = collectRollouts(dir, id, includeCompressed, hits);
  // Newest-dated directories first.
  const subdirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  for (const name of subdirs) {
    walkRollouts(path.join(dir, name), depth + 1, id, includeCompressed, hits, remaining);
  }
}

/** A live `.jsonl` beats a compressed copy; among either, the newest modification wins. */
function pickRollout(hits: readonly RolloutHit[]): string | null {
  let best: RolloutHit | null = null;
  for (const hit of hits) {
    if (
      best === null ||
      (best.compressed && !hit.compressed) ||
      (best.compressed === hit.compressed && hit.mtime > best.mtime)
    ) {
      best = hit;
    }
  }
  return best?.file ?? null;
}

/**
 * The rollout of Codex thread `threadId`
 * (`<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, or below
 * `archived_sessions/`), or null. The id is matched against file names,
 * case-insensitively; no file contents are read.
 *
 * For a UUIDv7 id (every current Codex thread) the dated folders its
 * creation time points to ({@link codexRolloutDayCandidates}) and the
 * archive are checked first in every home, so a lookup usually lists four
 * directories per home. Without a hit there (or for any other id), the
 * sessions trees are walked, newest-dated first, up to `maxDirs`
 * directories. A live `.jsonl` beats a compressed copy, and among copies
 * the most recently modified wins.
 */
export function locateCodexRolloutFile(
  threadId: string,
  options: LocateCodexRolloutFileOptions = {},
): string | null {
  try {
    const id = typeof threadId === 'string' ? threadId.trim().toLowerCase() : '';
    if (!id || id.length > MAX_ID_LENGTH || !SESSION_ID.test(id)) return null;
    const homes = resolveAgentHomes({
      claudeHomes: [],
      codexHomes: validHomes(options.homes?.codexHomes),
      ...(options.env ? { env: options.env } : {}),
      ...(options.agentCwds ? { agentCwds: options.agentCwds } : {}),
    }).codex;
    const includeArchived = options.includeArchived !== false;
    const includeCompressed = options.includeCompressed === true;
    const hits: RolloutHit[] = [];

    const days = codexRolloutDayCandidates(id);
    if (days.length > 0) {
      for (const home of homes) {
        for (const day of days) {
          collectRollouts(path.join(home, CODEX_SESSIONS_SUBDIR, day), id, includeCompressed, hits);
        }
        if (includeArchived) {
          collectRollouts(
            path.join(home, CODEX_ARCHIVED_SESSIONS_SUBDIR),
            id,
            includeCompressed,
            hits,
          );
        }
      }
      const hinted = pickRollout(hits);
      if (hinted) return hinted;
    }

    const remaining = { dirs: budget(options.maxDirs, DEFAULT_MAX_ROLLOUT_DIRS) };
    for (const home of homes) {
      walkRollouts(
        path.join(home, CODEX_SESSIONS_SUBDIR),
        0,
        id,
        includeCompressed,
        hits,
        remaining,
      );
      if (includeArchived) {
        walkRollouts(
          path.join(home, CODEX_ARCHIVED_SESSIONS_SUBDIR),
          0,
          id,
          includeCompressed,
          hits,
          remaining,
        );
      }
    }
    return pickRollout(hits);
  } catch {
    return null;
  }
}
