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
