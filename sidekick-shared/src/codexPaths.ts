import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAccountsDir, listSavedAccountProfiles } from './accountRegistry';

export function getDefaultSystemCodexHome(): string {
  return path.join(os.homedir(), '.codex');
}

export function getExplicitCodexHome(): string | null {
  const explicitHome = process.env.CODEX_HOME?.trim();
  return explicitHome ? explicitHome : null;
}

/** The home the `codex` CLI reads for this process: `CODEX_HOME` or `~/.codex`. */
export function getSystemCodexHome(): string {
  return getExplicitCodexHome() ?? getDefaultSystemCodexHome();
}

export function resolveSidekickCodexHome(): string {
  // Account switching swaps auth.json inside the system home, so the system
  // home (or an explicit CODEX_HOME) is always the single live home.
  return getSystemCodexHome();
}

/**
 * The environment for spawning `codex`: `baseEnv` with `CODEX_HOME` set to the
 * live home. A non-blank `CODEX_HOME` already in `baseEnv` is kept, so a caller
 * that points one child at its own home does not have it overwritten.
 */
export function getCodexExecutionEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const requested = baseEnv.CODEX_HOME?.trim();
  return {
    ...baseEnv,
    CODEX_HOME: requested ? requested : resolveSidekickCodexHome(),
  };
}

export function getCodexProfilesDir(): string {
  return path.join(getAccountsDir(), 'codex', 'profiles');
}

function assertCodexAccountId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error('Invalid Codex account id.');
}

export function getCodexProfileDir(profileId: string): string {
  assertCodexAccountId(profileId);
  return path.join(getCodexProfilesDir(), profileId);
}

export function getCodexProfileHome(profileId: string): string {
  return path.join(getCodexProfileDir(profileId), 'codex-home');
}

export function getCodexProfileStatePath(profileId: string): string {
  return path.join(getCodexProfileDir(profileId), 'profile.json');
}

export function ensureCodexProfileDirs(profileId: string): void {
  fs.mkdirSync(getCodexProfileHome(profileId), { recursive: true, mode: 0o700 });
}

export function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export type CodexCredentialStoreMode =
  | 'file'
  | 'keyring'
  | 'auto'
  | 'ephemeral'
  | 'unknown'
  | 'unreadable';

const STORE_MODE_PATTERN = /^[ \t]*cli_auth_credentials_store[ \t]*=[ \t]*["']([a-z]+)["']/m;

/**
 * How the `codex` CLI persists credentials for a home, from its `config.toml`.
 * `unknown` means the key is absent (Codex defaults to file storage).
 */
export function getCodexCredentialStoreMode(
  codexHome: string = getSystemCodexHome(),
): CodexCredentialStoreMode {
  let config: string;
  try {
    config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unknown' : 'unreadable';
  }
  const topLevel = config.split(/^[ \t]*\[/m, 1)[0];
  const match = topLevel.match(STORE_MODE_PATTERN);
  if (!match && /^[ \t]*cli_auth_credentials_store\s*=/m.test(topLevel)) return 'unreadable';
  const value = match?.[1];
  return value === 'file' || value === 'keyring' || value === 'auto' || value === 'ephemeral'
    ? value
    : value === undefined
      ? 'unknown'
      : 'unreadable';
}

/**
 * Rewrite a `config.toml` so an isolated login writes `auth.json` instead of a
 * keyring entry sidekick could never swap. Adds the key when absent.
 */
export function forceFileCredentialStore(configToml: string): string {
  const firstHeader = configToml.search(/^[ \t]*\[/m);
  const header = firstHeader < 0 ? configToml : configToml.slice(0, firstHeader);
  if (STORE_MODE_PATTERN.test(header)) {
    return (
      header.replace(STORE_MODE_PATTERN, 'cli_auth_credentials_store = "file"') +
      (firstHeader < 0 ? '' : configToml.slice(firstHeader))
    );
  }
  const line = 'cli_auth_credentials_store = "file"';
  const trimmed = configToml.replace(/\s*$/, '');
  if (!trimmed) return `${line}\n`;
  // A key after a `[table]` header belongs to that table: keep this one at the
  // top level by inserting it before the first table header.
  const firstTable = trimmed.search(/^\s*\[/m);
  if (firstTable === -1) return `${trimmed}\n${line}\n`;
  const head = trimmed.slice(0, firstTable).replace(/\s*$/, '');
  return `${head ? `${head}\n` : ''}${line}\n\n${trimmed.slice(firstTable).replace(/^\s*/, '')}\n`;
}

export function getCodexBackupPath(id: string, legacy = false): string {
  assertCodexAccountId(id);
  return path.join(
    getAccountsDir(),
    'codex',
    'backups',
    `${id}.${legacy ? 'credentials' : 'auth'}.json`,
  );
}
export function getCodexLoginsDir(): string {
  return path.join(getAccountsDir(), 'codex', 'logins');
}
export function getCodexLoginDir(id: string): string {
  assertCodexAccountId(id);
  return path.join(getCodexLoginsDir(), id);
}
/** Legacy pending profiles remain readable until finalized or discarded. */
export function getCodexLoginHome(id: string): string {
  const dir = getCodexLoginDir(id);
  return fs.existsSync(dir) ? path.join(dir, 'codex-home') : getCodexProfileHome(id);
}
export function getCodexLoginStatePath(id: string): string {
  const dir = getCodexLoginDir(id);
  return fs.existsSync(dir) ? path.join(dir, 'profile.json') : getCodexProfileStatePath(id);
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const candidate of paths) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(candidate);
  }

  return unique;
}

export function getCodexMonitoringHomes(): string[] {
  const explicitHome = getExplicitCodexHome();
  if (explicitHome) return [explicitHome];

  // The system home is the single live home; profile homes only matter for
  // sessions recorded back when they doubled as live CODEX_HOMEs.
  const homes: string[] = [getDefaultSystemCodexHome()];
  for (const profile of listSavedAccountProfiles('codex')) {
    const profileHome = getCodexProfileHome(profile.id);
    if (fs.existsSync(path.join(profileHome, 'sessions'))) {
      homes.push(profileHome);
    }
  }

  return dedupePaths(homes);
}

/** Where Codex writes live rollouts, below each home. */
export const CODEX_SESSIONS_SUBDIR = 'sessions';
/** Where Codex moves a rollout when its thread is archived, below each home. */
export const CODEX_ARCHIVED_SESSIONS_SUBDIR = 'archived_sessions';

export interface CodexSessionsDirsOptions {
  /** Also list each home's `archived_sessions` directory when it exists (default true). */
  includeArchived?: boolean;
}

/**
 * Every directory that may hold Codex rollouts: each home's `sessions`, then
 * each home's `archived_sessions` that exists. Live directories come first so
 * callers that pick one directory pick a live one.
 */
export function getCodexSessionsDirs(
  homes: string[] = getCodexMonitoringHomes(),
  options: CodexSessionsDirsOptions = {},
): string[] {
  const live = homes.map((home) => path.join(home, CODEX_SESSIONS_SUBDIR));
  if (options.includeArchived === false) return live;
  const archived = homes
    .map((home) => path.join(home, CODEX_ARCHIVED_SESSIONS_SUBDIR))
    .filter((dir) => fs.existsSync(dir));
  return [...live, ...archived];
}
