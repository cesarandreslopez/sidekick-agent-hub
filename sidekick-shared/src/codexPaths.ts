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

export function getCodexProfileDir(profileId: string): string {
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

export type CodexCredentialStoreMode = 'file' | 'keyring' | 'auto' | 'ephemeral' | 'unknown';

const STORE_MODE_PATTERN = /^\s*cli_auth_credentials_store\s*=\s*"([a-z]+)"/m;

/**
 * How the `codex` CLI persists credentials for a home, from its `config.toml`.
 * `unknown` means the key is absent (older CLIs: file; newer CLIs: auto).
 */
export function getCodexCredentialStoreMode(
  codexHome: string = getSystemCodexHome(),
): CodexCredentialStoreMode {
  const config = readFileOrNull(path.join(codexHome, 'config.toml'));
  const match = config?.match(STORE_MODE_PATTERN);
  const value = match?.[1];
  return value === 'file' || value === 'keyring' || value === 'auto' || value === 'ephemeral'
    ? value
    : 'unknown';
}

/**
 * Rewrite a `config.toml` so an isolated login writes `auth.json` instead of a
 * keyring entry sidekick could never swap. Adds the key when absent.
 */
export function forceFileCredentialStore(configToml: string): string {
  if (STORE_MODE_PATTERN.test(configToml)) {
    return configToml.replace(STORE_MODE_PATTERN, 'cli_auth_credentials_store = "file"');
  }
  const trimmed = configToml.replace(/\s*$/, '');
  return `${trimmed ? `${trimmed}\n` : ''}cli_auth_credentials_store = "file"\n`;
}
