/**
 * Which Claude Code and Codex homes a reader should look in, resolved from
 * explicit lists, an environment, and the user's home directory.
 *
 * The agent CLIs pick their home from `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in
 * *their* environment, which a reader (an editor host, a hook, a server
 * process) often does not share. A caller that knows where the agent wrote
 * passes the homes explicitly; one that does not lets the environment and
 * then `<HOME>/.claude` / `<HOME>/.codex` decide.
 *
 * Precedence, per provider: an explicit array (`[]` disables that provider),
 * then the environment variable, then the default under the user's home.
 *
 * A blank variable counts as unset, which is how Codex treats a blank
 * `CODEX_HOME`. Claude Code is different: since 2.1.316 it resolves an
 * *exactly* empty `CLAUDE_CONFIG_DIR` to the folder it was started in (and
 * reports a relative `transcript_path`), while older versions treat it as
 * unset. A relative variable names a directory relative to the agent's start
 * folder too. A reader that knows the candidate start folders passes them as
 * `agentCwds` (see {@link ResolveAgentHomesOptions}); without them an empty
 * `CLAUDE_CONFIG_DIR` falls back to the default home, and a relative variable
 * is ignored and reported.
 *
 * Never adds sidekick account-profile homes; `resolveMonitoredHomes()` in
 * `codexPaths` does that for Codex.
 *
 * Dependency-free: Node's `os` and `path` only, and no filesystem access, so
 * hook bundles can use it.
 *
 * @module agentHomes
 */

import * as os from 'os';
import * as path from 'path';

/** An environment to read home variables from (default `process.env`). */
export type AgentHomesEnv = Readonly<Record<string, string | undefined>>;

/** Where session readers look for Claude Code and Codex data. */
export interface SessionHomesOptions {
  /**
   * Claude Code homes (each holds `projects/`), absolute. `[]` disables
   * Claude Code. Omit to use `CLAUDE_CONFIG_DIR`, else `<HOME>/.claude`.
   */
  claudeHomes?: readonly string[];
  /**
   * Codex homes (each holds `sessions/` and `archived_sessions/`), absolute.
   * `[]` disables Codex. Omit to use `CODEX_HOME`, else `<HOME>/.codex`.
   */
  codexHomes?: readonly string[];
  /** Environment for `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `HOME` (default `process.env`). */
  env?: AgentHomesEnv;
  /**
   * Codex only, when `codexHomes` is omitted and `CODEX_HOME` is unset: also
   * read sidekick account-profile homes that recorded sessions (default
   * true, as the providers always have). Ignored by `resolveAgentHomes()`.
   */
  includeProfileHomes?: boolean;
}

/** Options for {@link resolveAgentHomes}. */
export interface ResolveAgentHomesOptions extends SessionHomesOptions {
  /**
   * Folders the agent may have been started in, absolute, most likely first
   * (for a hook: its project directory, then the payload's `cwd`). They
   * resolve what only the agent's start folder can: an exactly empty
   * `CLAUDE_CONFIG_DIR` adds each as a Claude home after the default home
   * (Claude Code 2.1.316+ writes to `<start folder>/projects/`, older
   * versions to the default), and a relative `CLAUDE_CONFIG_DIR` or
   * `CODEX_HOME` resolves against each instead of being ignored. Blank,
   * relative, or non-string entries are skipped. Explicit home lists win.
   */
  agentCwds?: readonly string[];
}

export type AgentHomeProvider = 'claude-code' | 'codex';

/** An environment value `resolveAgentHomes()` did not use, and why. */
export interface IgnoredAgentHome {
  provider: AgentHomeProvider;
  variable: string;
  value: string;
  reason: 'relative';
}

export interface ResolvedAgentHomes {
  /** Claude Code homes, deduplicated, in precedence order. */
  claude: string[];
  /** Codex homes, deduplicated, in precedence order. */
  codex: string[];
  /** Environment values that were set but not used. */
  ignored: IgnoredAgentHome[];
}

export const CLAUDE_CONFIG_DIR_ENV_VAR = 'CLAUDE_CONFIG_DIR';
export const CODEX_HOME_ENV_VAR = 'CODEX_HOME';
/** Default Claude Code home directory name under the user's home. */
export const DEFAULT_CLAUDE_HOME_DIRNAME = '.claude';
/** Default Codex home directory name under the user's home. */
export const DEFAULT_CODEX_HOME_DIRNAME = '.codex';

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The user's home directory for `env`: an absolute `HOME` (or, on Windows,
 * `USERPROFILE`) in it, else `os.homedir()`.
 */
export function agentUserHome(env: AgentHomesEnv = process.env): string {
  for (const variable of ['HOME', 'USERPROFILE']) {
    const value = nonBlank(env[variable]);
    if (value && path.isAbsolute(value)) return value;
  }
  return os.homedir();
}

/**
 * Validate an explicit home list: every entry must be a non-blank absolute
 * path. Throws `RangeError` naming the option otherwise. Returns the entries
 * normalized and deduplicated, first occurrence first.
 */
export function normalizeExplicitHomes(homes: readonly string[], label: string): string[] {
  if (!Array.isArray(homes)) {
    throw new RangeError(`\`${label}\` must be an array of absolute paths.`);
  }
  for (const home of homes) {
    if (typeof home !== 'string' || home.trim() === '') {
      throw new RangeError(`\`${label}\` contains a blank entry.`);
    }
    if (!path.isAbsolute(home)) {
      throw new RangeError(`\`${label}\` entries must be absolute paths: ${home}`);
    }
  }
  return dedupeHomes(homes.map((home) => path.resolve(home)));
}

/** Deduplicate by resolved path, keeping the first spelling and order. */
export function dedupeHomes(homes: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const home of homes) {
    const key = path.resolve(home);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(home);
  }
  return unique;
}

function absoluteDirs(dirs: readonly string[] | undefined): string[] {
  if (!Array.isArray(dirs)) return [];
  return dedupeHomes(
    dirs
      .filter((dir) => typeof dir === 'string' && dir.trim() !== '' && path.isAbsolute(dir))
      .map((dir) => path.resolve(dir)),
  );
}

function resolveOne(
  provider: AgentHomeProvider,
  explicit: readonly string[] | undefined,
  label: string,
  variable: string,
  dirname: string,
  env: AgentHomesEnv,
  ignored: IgnoredAgentHome[],
  cwds: string[],
): string[] {
  if (explicit !== undefined) return normalizeExplicitHomes(explicit, label);
  const fallback = path.join(agentUserHome(env), dirname);
  const raw = env[variable];
  // Claude Code 2.1.316+ resolves an exactly empty value to its start folder;
  // older versions (and Codex) treat it as unset.
  if (raw === '' && provider === 'claude-code' && cwds.length > 0) {
    return dedupeHomes([fallback, ...cwds]);
  }
  const fromEnv = nonBlank(raw);
  if (fromEnv !== undefined) {
    if (path.isAbsolute(fromEnv)) return [path.resolve(fromEnv)];
    if (cwds.length > 0) return dedupeHomes(cwds.map((cwd) => path.resolve(cwd, fromEnv)));
    ignored.push({ provider, variable, value: fromEnv, reason: 'relative' });
  }
  return [fallback];
}

/**
 * Resolve the Claude Code and Codex homes to read. Pure: no filesystem
 * access. Throws `RangeError` only for an explicit list with a relative or
 * blank entry; environment values and `agentCwds` never throw (see
 * `ignored`).
 */
export function resolveAgentHomes(options: ResolveAgentHomesOptions = {}): ResolvedAgentHomes {
  const env = options.env ?? process.env;
  const ignored: IgnoredAgentHome[] = [];
  const cwds = absoluteDirs(options.agentCwds);
  const claude = resolveOne(
    'claude-code',
    options.claudeHomes,
    'claudeHomes',
    CLAUDE_CONFIG_DIR_ENV_VAR,
    DEFAULT_CLAUDE_HOME_DIRNAME,
    env,
    ignored,
    cwds,
  );
  const codex = resolveOne(
    'codex',
    options.codexHomes,
    'codexHomes',
    CODEX_HOME_ENV_VAR,
    DEFAULT_CODEX_HOME_DIRNAME,
    env,
    ignored,
    cwds,
  );
  return { claude, codex, ignored };
}
