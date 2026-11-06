import * as os from 'os';
import * as path from 'path';

/** Where Claude Code writes session transcripts, below each home. */
export const CLAUDE_PROJECTS_SUBDIR = 'projects';

export function getDefaultClaudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

/** True when an environment (default this process's) runs against the default `~/.claude` home. */
export function isDefaultClaudeHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !env.CLAUDE_CONFIG_DIR?.trim();
}

/**
 * The home the `claude` CLI reads and writes for an environment (default this
 * process's): `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. Every "live"
 * credential or identity read goes through this so sidekick follows the same
 * home the CLI does.
 */
export function getLiveClaudeHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env.CLAUDE_CONFIG_DIR?.trim();
  return explicit ? explicit : getDefaultClaudeHome();
}

/**
 * Where the `claude` CLI writes session transcripts below `home` (default the
 * live home of this process).
 */
export function getClaudeProjectsDir(home: string = getLiveClaudeHome()): string {
  return path.join(home, CLAUDE_PROJECTS_SUBDIR);
}

/**
 * Encodes a workspace path to Claude Code's on-disk directory naming scheme
 * under `~/.claude/projects/` — every non-ASCII-alphanumeric character
 * (separators, colons, underscores, dots, spaces) becomes a hyphen, and case
 * is preserved. Also exported as `encodeWorkspacePath` from
 * `parsers/sessionPathResolver` (the same function).
 *
 * Not to be confused with the top-level `encodeWorkspacePath` export from
 * `paths.ts`: that one is Sidekick's own config-store slug (it keeps dots) and
 * does NOT match Claude Code's scheme — using it to build a
 * `~/.claude/projects/` path silently misses for any workspace containing a
 * dot or space. For lookups, prefer `getClaudeSessionDirectory` or the
 * mismatch-tolerant `discoverSessionDirectory` over raw string encoding.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Encoded path string (e.g., "-home-user-code-project")
 *
 * @example
 * ```typescript
 * encodeClaudeWorkspacePath('/home/user/code/my_project');
 * // => "-home-user-code-my-project"
 *
 * encodeClaudeWorkspacePath('C:\\Users\\user\\code\\my_project'); // Windows
 * // => "C--Users-user-code-my-project"
 * ```
 */
export function encodeClaudeWorkspacePath(workspacePath: string): string {
  // Normalize path separators to forward slash
  const normalized = workspacePath.replace(/\\/g, '/');

  // Claude Code replaces every non-alphanumeric path character, including
  // dots and spaces, with a hyphen.
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Subagent ids Claude Code writes (`agent-<id>.jsonl`): a letter or digit, then `[A-Za-z0-9_-]`. */
export const CLAUDE_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const SUBAGENT_FILE_PREFIX = 'agent-';
const SUBAGENT_FILE_SUFFIX = '.jsonl';

/** True when `agentId` is a well-formed Claude Code subagent id. */
export function isClaudeAgentId(agentId: unknown): agentId is string {
  return typeof agentId === 'string' && CLAUDE_AGENT_ID_PATTERN.test(agentId);
}

/**
 * The directory holding a session's subagent transcripts:
 * `<project dir>/<session id>/subagents`, for the session file
 * `<project dir>/<session id>.jsonl`.
 */
export function getClaudeSubagentsDir(sessionFile: string): string {
  const name = path.basename(sessionFile);
  const sessionId = name.endsWith(SUBAGENT_FILE_SUFFIX)
    ? name.slice(0, -SUBAGENT_FILE_SUFFIX.length)
    : name;
  return path.join(path.dirname(sessionFile), sessionId, 'subagents');
}

/**
 * The transcript Claude Code writes for subagent `agentId` of a session:
 * `<subagents dir>/agent-<id>.jsonl`. Null when the id is malformed, so a
 * caller-supplied id can never point outside the subagents directory.
 */
export function getClaudeSubagentTranscriptPath(
  sessionFile: string,
  agentId: string,
): string | null {
  if (!isClaudeAgentId(agentId)) return null;
  return path.join(
    getClaudeSubagentsDir(sessionFile),
    `${SUBAGENT_FILE_PREFIX}${agentId}${SUBAGENT_FILE_SUFFIX}`,
  );
}

/**
 * The agent id of a subagent transcript file name (`agent-<id>.jsonl`), or
 * null for anything else (`agent-<id>.meta.json`, other files, bad ids).
 */
export function parseClaudeSubagentFileName(name: string): string | null {
  if (!name.startsWith(SUBAGENT_FILE_PREFIX) || !name.endsWith(SUBAGENT_FILE_SUFFIX)) return null;
  const agentId = name.slice(SUBAGENT_FILE_PREFIX.length, -SUBAGENT_FILE_SUFFIX.length);
  return isClaudeAgentId(agentId) ? agentId : null;
}
