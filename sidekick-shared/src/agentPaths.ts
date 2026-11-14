/**
 * `sidekick-shared/agentPaths`: where Claude Code and Codex keep their
 * homes and transcripts, what a transcript path is, which CLI version and
 * model wrote it, and where a session's transcript is by id, for bundles that
 * may load nothing else (hooks, launchers).
 *
 * Six modules and Node's `fs`, `os` and `path`, nothing more. The
 * classifiers, readers and lookups here never throw; `resolveAgentHomes()`
 * throws `RangeError` only for an explicit relative or blank home, which is
 * a caller bug. Everything is also exported from the package root and
 * `sidekick-shared/node`. Bundlers keep only what is imported (the package
 * has no side effects), so a hook that imports one classifier does not pay
 * for the readers or lookups.
 *
 * @module agentPaths
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveAgentHomes, type AgentHomesEnv, type SessionHomesOptions } from './agentHomes';
import { CLAUDE_PROJECTS_SUBDIR, parseClaudeSubagentFileName } from './claudePaths';
import {
  CODEX_ARCHIVED_SESSIONS_SUBDIR,
  CODEX_SESSIONS_SUBDIR,
  extractRolloutSessionId,
  isCompressedRolloutFile,
  isRolloutFile,
} from './codexLayout';

export { CLAUDE_CONFIG_DIR_ENV_VAR, CODEX_HOME_ENV_VAR, resolveAgentHomes } from './agentHomes';
export type {
  AgentHomeProvider,
  AgentHomesEnv,
  IgnoredAgentHome,
  ResolveAgentHomesOptions,
  ResolvedAgentHomes,
  SessionHomesOptions,
} from './agentHomes';
export {
  CLAUDE_AGENT_ID_PATTERN,
  CLAUDE_PROJECTS_SUBDIR,
  encodeClaudeWorkspacePath,
  getClaudeProjectsDir,
  getClaudeSubagentTranscriptPath,
  getClaudeSubagentsDir,
  getDefaultClaudeHome,
  getLiveClaudeHome,
  isClaudeAgentId,
  isDefaultClaudeHome,
  parseClaudeSubagentFileName,
} from './claudePaths';
export {
  CODEX_ARCHIVED_SESSIONS_SUBDIR,
  CODEX_SESSIONS_SUBDIR,
  codexRolloutDayCandidates,
  extractRolloutSessionId,
  getSystemCodexHome,
  isCompressedRolloutFile,
  isRolloutFile,
} from './codexLayout';
export {
  DEFAULT_AGENT_VERSION_WINDOW_BYTES,
  readAgentModel,
  readAgentVersion,
} from './agentVersion';
export type {
  AgentModelInfo,
  AgentVersionInfo,
  AgentVersionProvider,
  ReadAgentModelOptions,
  ReadAgentVersionOptions,
} from './agentVersion';
export {
  DEFAULT_MAX_CLAUDE_PROJECT_DIRS,
  findClaudeSessionFile,
  locateCodexRolloutFile,
} from './agentTranscriptLookup';
export type {
  FindClaudeSessionFileOptions,
  LocateCodexRolloutFileOptions,
} from './agentTranscriptLookup';

export type AgentTranscriptKind = 'session' | 'subagent' | 'rollout';

/** What a transcript path is, by where it sits under a known home. */
export interface AgentTranscriptPath {
  provider: 'claude-code' | 'codex';
  /** A Claude Code session, a Claude Code subagent transcript, or a Codex rollout. */
  kind: AgentTranscriptKind;
  /** The home the path is under. */
  home: string;
  /** The session (a subagent's parent session for `subagent`). */
  sessionId: string;
  /** Claude Code subagent id (`agent-<id>.jsonl`). */
  agentId?: string;
  /** Codex: under `archived_sessions/`. */
  archived?: boolean;
  /** Codex: a compressed rollout (`….jsonl.zst`). */
  compressed?: boolean;
}

export interface ClassifyAgentTranscriptPathOptions {
  /**
   * Homes to accept (see `SessionHomesOptions`). Omitted lists follow `env`
   * and the user's home; invalid explicit entries are skipped, not thrown.
   */
  homes?: Pick<SessionHomesOptions, 'claudeHomes' | 'codexHomes'>;
  /** Environment for `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `HOME` (default `process.env`). */
  env?: AgentHomesEnv;
  /**
   * Candidate start folders of the agent, as in `resolveAgentHomes()`: with
   * an exactly empty `CLAUDE_CONFIG_DIR` each is also accepted as a Claude
   * home, and a relative variable resolves against them.
   */
  agentCwds?: readonly string[];
  /**
   * Absolute folders a *relative* path is resolved against, in order (for a
   * hook: its project directory, then the payload's `cwd`). Claude Code
   * 2.1.316+ with an exactly empty `CLAUDE_CONFIG_DIR` reports
   * `projects/<dir>/<id>.jsonl` relative to its start folder, so pass bases
   * only when the agent ran that way. A relative path is accepted only as a
   * Claude Code session or subagent transcript under a base's own
   * `projects/`, and that base is reported as `home`: the first base where
   * the file exists, else the first base (a session's first hook can run
   * before its transcript is written). Without `baseDirs` a relative path
   * gives null.
   */
  baseDirs?: readonly string[];
  /** Compare realpaths, following symlinks in the path and the homes (default false). */
  realpath?: boolean;
}

/** Deepest rollout below a sessions root that the rollout walker visits. */
const MAX_ROLLOUT_SEGMENTS = 7;

function validHomes(homes: readonly string[] | undefined): string[] | undefined {
  if (homes === undefined) return undefined;
  if (!Array.isArray(homes)) return [];
  return homes.filter(
    (home) => typeof home === 'string' && home.trim() !== '' && path.isAbsolute(home),
  );
}

/**
 * `target` with symlinks resolved when `realpath` is set. A path that does not
 * exist yet (a transcript before its first write) resolves its deepest
 * existing ancestor and keeps the rest, so it still compares equal to a
 * resolved home.
 */
function canonical(target: string, realpath: boolean | undefined): string {
  if (!realpath) return target;
  for (let dir = target, rest = ''; ; ) {
    try {
      return path.join(fs.realpathSync.native(dir), rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return target;
      rest = path.join(path.basename(dir), rest);
      dir = parent;
    }
  }
}

/** Path segments of `target` below `base`, or null when it is not inside. */
function segmentsBelow(base: string, target: string): string[] | null {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const segments = relative.split(/[\\/]+/);
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ? null
    : segments;
}

function claudeSessionId(fileName: string): string | null {
  if (!fileName.endsWith('.jsonl')) return null;
  const sessionId = fileName.slice(0, -'.jsonl'.length);
  return sessionId && !sessionId.startsWith('.') ? sessionId : null;
}

function classifyClaude(
  target: string,
  home: string,
  realpath: boolean | undefined,
): AgentTranscriptPath | null {
  const segments = segmentsBelow(
    canonical(path.join(home, CLAUDE_PROJECTS_SUBDIR), realpath),
    target,
  );
  if (!segments) return null;
  if (segments.length === 2) {
    const sessionId = claudeSessionId(segments[1]);
    return sessionId ? { provider: 'claude-code', kind: 'session', home, sessionId } : null;
  }
  if (segments.length === 4 && segments[2] === 'subagents') {
    const agentId = parseClaudeSubagentFileName(segments[3]);
    const sessionId = segments[1];
    if (!agentId || !sessionId || sessionId.startsWith('.')) return null;
    return { provider: 'claude-code', kind: 'subagent', home, sessionId, agentId };
  }
  return null;
}

function classifyCodex(
  target: string,
  home: string,
  realpath: boolean | undefined,
): AgentTranscriptPath | null {
  for (const [subdir, archived] of [
    [CODEX_SESSIONS_SUBDIR, false],
    [CODEX_ARCHIVED_SESSIONS_SUBDIR, true],
  ] as const) {
    const segments = segmentsBelow(canonical(path.join(home, subdir), realpath), target);
    if (!segments || segments.length > MAX_ROLLOUT_SEGMENTS) continue;
    const name = segments[segments.length - 1];
    const compressed = isCompressedRolloutFile(name);
    if (!compressed && !isRolloutFile(name)) return null;
    return {
      provider: 'codex',
      kind: 'rollout',
      home,
      sessionId: extractRolloutSessionId(name),
      archived,
      compressed,
    };
  }
  return null;
}

/**
 * Classify a transcript path by the home it sits under: a Claude Code
 * session (`<home>/projects/<dir>/<id>.jsonl`), a Claude Code subagent
 * (`<home>/projects/<dir>/<id>/subagents/agent-<agent>.jsonl`), or a Codex
 * rollout (`<home>/sessions/…/rollout-….jsonl[.zst]`, or below
 * `archived_sessions/`). A relative path is classified only against
 * `baseDirs` (see {@link ClassifyAgentTranscriptPathOptions.baseDirs}). Null
 * for anything else. Only the path is examined unless `realpath` is set.
 * Never throws.
 */
export function classifyAgentTranscriptPath(
  filePath: string,
  options: ClassifyAgentTranscriptPathOptions = {},
): AgentTranscriptPath | null {
  try {
    if (typeof filePath !== 'string' || !filePath) return null;
    if (!path.isAbsolute(filePath)) {
      let first: AgentTranscriptPath | null = null;
      for (const base of validHomes(options.baseDirs) ?? []) {
        const home = path.resolve(base);
        const target = path.resolve(home, filePath);
        const match = classifyClaude(canonical(target, options.realpath), home, options.realpath);
        if (!match) continue;
        // A relative path fits every base; prefer the one that holds the file.
        if (fs.existsSync(target)) return match;
        first ??= match;
      }
      return first;
    }
    const homes = resolveAgentHomes({
      claudeHomes: validHomes(options.homes?.claudeHomes),
      codexHomes: validHomes(options.homes?.codexHomes),
      ...(options.env ? { env: options.env } : {}),
      ...(options.agentCwds ? { agentCwds: options.agentCwds } : {}),
    });
    const target = canonical(path.resolve(filePath), options.realpath);
    for (const home of homes.claude) {
      const match = classifyClaude(target, home, options.realpath);
      if (match) return match;
    }
    for (const home of homes.codex) {
      const match = classifyCodex(target, home, options.realpath);
      if (match) return match;
    }
    return null;
  } catch {
    return null;
  }
}
