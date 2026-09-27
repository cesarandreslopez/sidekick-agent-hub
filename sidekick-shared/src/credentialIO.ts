/**
 * Platform-aware credential I/O for Claude Code.
 *
 * On macOS, Claude Code stores OAuth credentials in the system Keychain
 * (service "Claude Code-credentials", suffixed per config directory). On
 * Linux/WSL/Windows, credentials live in `<home>/.credentials.json`. When the
 * Keychain is unavailable (locked, SSH) Claude Code falls back to the file on
 * macOS too, so reads consult the file after a Keychain miss.
 *
 * Keychain writes mirror Claude Code 2.1.x exactly: the payload is hex-encoded
 * (`-X`) and sent through `security -i` only while the command line fits the
 * tool's line buffer; longer payloads go through argv. `security -i` silently
 * truncates longer lines, which once stored half a credential (the `mcpOAuth`
 * tokens make blobs of 4 KB and more) — a login Claude Code then reports as
 * "Not logged in". Every write is read back and compared before it counts.
 *
 * Both accounts.ts and credentials.ts consume this module so that all
 * credential access is platform-correct in one place.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  claudeKeychainAccountName,
  claudeKeychainService,
  getLiveClaudeHome,
} from './claudeProfiles';
import { forgetClaudeCredentialHome, recordClaudeCredentialHome } from './claudeCredentialLedger';
import { atomicWriteFileSync } from './writers/atomic';

export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const SECURITY_TIMEOUT_MS = 4000;
/** `security` exits with this status when no item matches. */
const SECURITY_ITEM_NOT_FOUND = 44;
/**
 * Claude Code's ceiling for a `security -i` command line (the tool reads at
 * most 4095 bytes per line). Longer commands go through argv instead.
 */
export const SECURITY_INTERACTIVE_LINE_LIMIT = 4032;
/**
 * Written as the item comment (`-j`) on every Keychain item Sidekick creates,
 * so ownership is provable from the item itself even after its directory and
 * the ledger that described it are gone.
 */
export const SIDEKICK_KEYCHAIN_COMMENT_PREFIX = 'sidekick-agent-hub:';

export type ClaudeCredentialStoreSource = 'keychain' | 'file';

/**
 * Outcome of reading one credential store. `error` (timeout, locked Keychain)
 * is never treated like `absent`: guard decisions that may overwrite a store
 * only proceed on a definite answer.
 */
export type ClaudeCredentialStoreRead =
  | { status: 'ok'; blob: Record<string, unknown>; source: ClaudeCredentialStoreSource }
  | { status: 'absent' }
  | { status: 'corrupt'; source: ClaudeCredentialStoreSource; length: number }
  | { status: 'error'; reason: string };

/** A credential write that did not land, or could not be verified. */
export class ClaudeCredentialWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCredentialWriteError';
  }
}

function quoteSecurityInteractiveArg(value: string): string {
  // `security -i` is not a POSIX shell: adjacent quoted segments do NOT
  // concatenate (so the shell-style '\'' splice splits the token), and
  // backslash escapes the next character even inside single quotes.
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, `\\'`)}'`;
}

function getCredentialsFilePath(configDir?: string): string {
  return path.join(configDir ?? getLiveClaudeHome(), '.credentials.json');
}

function parseStoredText(
  raw: string,
  source: ClaudeCredentialStoreSource,
): ClaudeCredentialStoreRead {
  const text = raw.trim();
  if (!text) return { status: 'corrupt', source, length: 0 };
  // `security -w` prints hex when the stored bytes are not plain text.
  const decoded =
    source === 'keychain' && !text.startsWith('{') && /^(?:[0-9a-f]{2})+$/i.test(text)
      ? Buffer.from(text, 'hex').toString('utf8')
      : text;
  try {
    const parsed = JSON.parse(decoded) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { status: 'ok', blob: parsed as Record<string, unknown>, source };
    }
  } catch {
    /* fall through */
  }
  return { status: 'corrupt', source, length: decoded.length };
}

function readCredentialsFileStore(configDir?: string): ClaudeCredentialStoreRead {
  let raw: string;
  try {
    raw = fs.readFileSync(getCredentialsFilePath(configDir), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'error', reason: String((error as Error).message ?? error) };
  }
  return parseStoredText(raw, 'file');
}

function securityErrorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function readKeychainStore(service: string): ClaudeCredentialStoreRead {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-a', claudeKeychainAccountName(), '-s', service, '-w'],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: SECURITY_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    return parseStoredText(String(raw), 'keychain');
  } catch (error) {
    if (securityErrorStatus(error) === SECURITY_ITEM_NOT_FOUND) return { status: 'absent' };
    return { status: 'error', reason: String((error as Error)?.message ?? error) };
  }
}

/**
 * Read one Claude credential store with a definite outcome. On macOS the
 * Keychain item is authoritative; the file is consulted only when the item is
 * absent (Claude Code's own fallback), unless `keychainOnly` is set.
 */
export function readClaudeCredentialStore(
  configDir?: string,
  options: { keychainOnly?: boolean } = {},
): ClaudeCredentialStoreRead {
  if (process.platform === 'darwin') {
    const keychain = readKeychainStore(claudeKeychainService(configDir));
    if (keychain.status !== 'absent' || options.keychainOnly) return keychain;
  }
  return readCredentialsFileStore(configDir);
}

/**
 * Read the active Claude Code credentials as a parsed object.
 *
 * - macOS: reads from system Keychain via the `security` CLI, then the file
 * - Linux / WSL / Windows: reads `<home>/.credentials.json`
 *
 * Returns `null` when credentials are absent or unreadable. Callers that must
 * tell "absent" from "could not read" use {@link readClaudeCredentialStore}.
 */
export function readActiveCredentials(configDir?: string): unknown {
  if (process.platform === 'darwin') {
    const keychain = readKeychainStore(claudeKeychainService(configDir));
    if (keychain.status === 'ok') return keychain.blob;
  }
  const file = readCredentialsFileStore(configDir);
  return file.status === 'ok' ? file.blob : null;
}

function runKeychainWrite(service: string, hex: string, comment: string | null): void {
  const account = claudeKeychainAccountName();
  const args = ['add-generic-password', '-U', '-a', account, '-s', service];
  const interactive = [
    'add-generic-password',
    '-U',
    '-a',
    quoteSecurityInteractiveArg(account),
    '-s',
    quoteSecurityInteractiveArg(service),
  ];
  if (comment) {
    args.push('-j', comment);
    interactive.push('-j', quoteSecurityInteractiveArg(comment));
  }
  args.push('-X', hex);
  interactive.push('-X', quoteSecurityInteractiveArg(hex));
  const line = `${interactive.join(' ')}\n`;
  if (Buffer.byteLength(line, 'utf8') <= SECURITY_INTERACTIVE_LINE_LIMIT) {
    execFileSync('security', ['-i'], {
      input: line,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SECURITY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return;
  }
  // The same trade-off Claude Code makes for large payloads: the hex is on the
  // command line (visible to `ps`) for the duration of this call.
  execFileSync('security', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SECURITY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

/**
 * Write a credential blob to a store and verify it by reading it back.
 * `configDir` undefined targets the live home; only the guarded live installer
 * in accounts.ts may do that (see {@link writeLiveClaudeCredentialStoreUnguarded}).
 */
function writeClaudeCredentialStore(credentials: unknown, configDir: string | undefined): void {
  const json = JSON.stringify(credentials);
  let expected: string;
  try {
    expected = JSON.stringify(JSON.parse(json));
  } catch {
    throw new ClaudeCredentialWriteError('Refusing to store a credential that is not JSON.');
  }

  if (process.platform === 'darwin') {
    const service = claudeKeychainService(configDir);
    const comment = configDir
      ? `${SIDEKICK_KEYCHAIN_COMMENT_PREFIX}${path.resolve(configDir)}`
      : null;
    try {
      runKeychainWrite(service, Buffer.from(json, 'utf8').toString('hex'), comment);
    } catch (error) {
      throw new ClaudeCredentialWriteError(
        `Keychain write failed: ${(error as Error)?.message ?? error}`,
      );
    }
    const readBack = readKeychainStore(service);
    if (readBack.status === 'error') {
      throw new ClaudeCredentialWriteError(
        'The Keychain write could not be verified (read-back failed); treating it as not written.',
      );
    }
    if (readBack.status !== 'ok' || JSON.stringify(readBack.blob) !== expected) {
      throw new ClaudeCredentialWriteError(
        'The Keychain item did not hold the credential after writing it.',
      );
    }
    return;
  }

  // Linux / WSL / Windows — file-based (tmp + fsync + rename, retried on Windows)
  atomicWriteFileSync(getCredentialsFilePath(configDir), json, 0o600);
  const readBack = readCredentialsFileStore(configDir);
  if (readBack.status !== 'ok' || JSON.stringify(readBack.blob) !== expected) {
    throw new ClaudeCredentialWriteError(
      'The credentials file did not hold the credential after writing it.',
    );
  }
}

/**
 * Write credentials to a profile home's Claude Code credential store.
 *
 * - macOS: the suffixed Keychain item for `configDir`
 * - Linux / WSL / Windows: atomic-writes `<configDir>/.credentials.json`
 *
 * `configDir` is required: the live store is written only through the guarded
 * installer in accounts.ts, which refuses downgrades and captures the outgoing
 * login first. Throws {@link ClaudeCredentialWriteError} when the write did
 * not land intact.
 */
export function writeActiveCredentials(credentials: unknown, configDir?: string): void {
  if (!configDir) {
    throw new ClaudeCredentialWriteError(
      'writeActiveCredentials() needs a config directory; the live Claude login is only written through a guarded account switch.',
    );
  }
  recordClaudeCredentialHome(configDir, 'profile');
  writeClaudeCredentialStore(credentials, configDir);
}

/**
 * Write the live store with no guard. Internal: the only caller is
 * `installIntoLiveClaudeStore` in accounts.ts (a test enforces this).
 */
export function writeLiveClaudeCredentialStoreUnguarded(credentials: unknown): void {
  writeClaudeCredentialStore(credentials, undefined);
}

function deleteKeychainItem(service: string, withAccount: boolean): 'deleted' | 'absent' | 'error' {
  try {
    execFileSync(
      'security',
      [
        'delete-generic-password',
        ...(withAccount ? ['-a', claudeKeychainAccountName()] : []),
        '-s',
        service,
      ],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: SECURITY_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    return 'deleted';
  } catch (error) {
    return securityErrorStatus(error) === SECURITY_ITEM_NOT_FOUND ? 'absent' : 'error';
  }
}

/**
 * Remove the credential store of a config directory (an abandoned isolated
 * login, a removed profile, the profile home of the account that became
 * live). Never throws; returns true when the store is gone afterwards.
 */
export function deleteStoredCredentials(configDir: string): boolean {
  let gone = true;
  if (process.platform === 'darwin') {
    const service = claudeKeychainService(configDir);
    let outcome = deleteKeychainItem(service, true);
    // Items written before the account name was pinned may carry another one.
    if (outcome === 'absent') outcome = deleteKeychainItem(service, false);
    if (outcome === 'error') gone = false;
  }
  try {
    fs.rmSync(getCredentialsFilePath(configDir), { force: true });
  } catch {
    gone = false;
  }
  if (gone) forgetClaudeCredentialHome(configDir);
  return gone;
}
