import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAccountsDir } from './accountRegistry';

const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const KEYCHAIN_FALLBACK_ACCOUNT = 'claude-code-user';

/**
 * Claude Code honours this variable ahead of `CLAUDE_CONFIG_DIR` when it
 * derives the keychain item name. Any `claude` child sidekick spawns must not
 * inherit it, or the login would land in an item nobody else reads.
 */
export const CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

export interface ClaudeProfileIdentity {
  email: string;
  uuid: string;
}

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

export function getClaudeProfilesDir(): string {
  return path.join(getAccountsDir(), 'claude', 'profiles');
}

export function getClaudeProfileDir(uuid: string): string {
  return path.join(getClaudeProfilesDir(), uuid);
}

export function getClaudeProfileHome(uuid: string): string {
  return path.join(getClaudeProfileDir(uuid), 'home');
}

export function ensureClaudeProfileDirs(uuid: string): void {
  fs.mkdirSync(getClaudeProfileHome(uuid), { recursive: true, mode: 0o700 });
}

/**
 * Claude Code hashes the NFC-normalised config directory; macOS hands paths
 * back decomposed (NFD), so a home directory with a non-ASCII name would
 * otherwise hash differently from the item the CLI wrote.
 */
export function claudeKeychainSuffix(configDir: string): string {
  return createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
}

/**
 * Keychain service name for a config directory. Claude Code drops the suffix
 * when `CLAUDE_CONFIG_DIR` is unset — not when the path merely equals
 * `~/.claude` — so the no-argument form follows the process environment.
 */
export function claudeKeychainService(configDir?: string): string {
  const dir = configDir ?? (isDefaultClaudeHome() ? undefined : getLiveClaudeHome());
  return dir
    ? `${DEFAULT_CLAUDE_KEYCHAIN_SERVICE}-${claudeKeychainSuffix(dir)}`
    : DEFAULT_CLAUDE_KEYCHAIN_SERVICE;
}

/** The keychain account name Claude Code uses: the unix username, sanitised. */
export function claudeKeychainAccountName(): string {
  let name: string | undefined;
  try {
    name = process.env.USER || os.userInfo().username;
  } catch {
    name = undefined;
  }
  return name && KEYCHAIN_ACCOUNT_PATTERN.test(name) ? name : KEYCHAIN_FALLBACK_ACCOUNT;
}

/** Environment for spawning `claude` against a specific home. */
export function buildClaudeChildEnv(
  home: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, CLAUDE_CONFIG_DIR: home };
  delete env[CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV];
  return env;
}

function readOauthAccount(configPath: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      oauthAccount?: Record<string, unknown>;
    };
    return raw?.oauthAccount && typeof raw.oauthAccount === 'object' ? raw.oauthAccount : null;
  } catch {
    return null;
  }
}

/**
 * Where the identity (`oauthAccount`) of a Claude home lives. Recent Claude
 * Code versions keep it in `<home>/.claude.json`; older ones (and the default
 * home on this machine's history) use `~/.claude.json`. Prefer the in-home file
 * when it carries an identity, otherwise fall back to the legacy location for
 * the default home only.
 */
export function getClaudeConfigPath(home: string = getLiveClaudeHome()): string {
  const primary = path.join(home, '.claude.json');
  if (readOauthAccount(primary)) return primary;
  if (path.resolve(home) === path.resolve(getDefaultClaudeHome())) {
    return path.join(os.homedir(), '.claude.json');
  }
  return primary;
}

function identityFromOauthAccount(
  oauthAccount: Record<string, unknown> | null,
): ClaudeProfileIdentity | null {
  const email = oauthAccount?.emailAddress;
  const uuid = oauthAccount?.accountUuid;
  return typeof email === 'string' && typeof uuid === 'string' ? { email, uuid } : null;
}

/** Identity of the account currently logged in to a Claude home (default: the live home). */
export function readLiveClaudeIdentity(
  home: string = getLiveClaudeHome(),
): ClaudeProfileIdentity | null {
  return identityFromOauthAccount(readOauthAccount(getClaudeConfigPath(home)));
}

export function readClaudeProfileIdentity(home: string): ClaudeProfileIdentity | null {
  return identityFromOauthAccount(readOauthAccount(path.join(home, '.claude.json')));
}

export function keychainServiceExists(service: string): boolean {
  try {
    execFileSync('security', ['find-generic-password', '-s', service], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 4000,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  }
}

export function isClaudeProfileAuthenticated(home: string): boolean {
  const hasCredentials =
    process.platform === 'darwin'
      ? keychainServiceExists(claudeKeychainService(home)) ||
        fs.existsSync(path.join(home, '.credentials.json'))
      : fs.existsSync(path.join(home, '.credentials.json'));

  return hasCredentials && readClaudeProfileIdentity(home) !== null;
}
