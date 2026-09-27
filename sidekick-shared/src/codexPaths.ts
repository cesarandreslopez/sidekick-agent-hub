import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAccountsDir } from './accountRegistry';

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
