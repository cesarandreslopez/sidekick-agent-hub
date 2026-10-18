import * as os from 'os';
import * as path from 'path';

export function getDefaultClaudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

/** True when this process runs against the default `~/.claude` home. */
export function isDefaultClaudeHome(): boolean {
  return !process.env.CLAUDE_CONFIG_DIR?.trim();
}

/**
 * The home the `claude` CLI reads and writes for this process: `CLAUDE_CONFIG_DIR`
 * when set, else `~/.claude`. Every "live" credential or identity read goes
 * through this so sidekick follows the same home the CLI does.
 */
export function getLiveClaudeHome(): string {
  const explicit = process.env.CLAUDE_CONFIG_DIR?.trim();
  return explicit ? explicit : getDefaultClaudeHome();
}

/** Where the `claude` CLI writes session transcripts for this process. */
export function getClaudeProjectsDir(): string {
  return path.join(getLiveClaudeHome(), 'projects');
}
