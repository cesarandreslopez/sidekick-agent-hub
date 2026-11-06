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
