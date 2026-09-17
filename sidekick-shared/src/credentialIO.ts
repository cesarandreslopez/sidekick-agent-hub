/**
 * Platform-aware credential I/O for Claude Code.
 *
 * On macOS, Claude Code stores OAuth credentials in the system Keychain
 * (service "Claude Code-credentials", suffixed per config directory). On
 * Linux/WSL/Windows, credentials live in `<home>/.credentials.json`. When the
 * Keychain is unavailable (locked, SSH) Claude Code falls back to the file on
 * macOS too, so reads consult the file after a Keychain miss.
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
import { atomicWriteFileSync } from './writers/atomic';

export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const SECURITY_TIMEOUT_MS = 4000;

function quoteSecurityInteractiveArg(value: string): string {
  // `security -i` is not a POSIX shell: adjacent quoted segments do NOT
  // concatenate (so the shell-style '\'' splice splits the token), and
  // backslash escapes the next character even inside single quotes.
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, `\\'`)}'`;
}

function getCredentialsFilePath(configDir?: string): string {
  return path.join(configDir ?? getLiveClaudeHome(), '.credentials.json');
}

function readCredentialsFile(configDir?: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(getCredentialsFilePath(configDir), 'utf8'));
  } catch {
    return null;
  }
}

function readKeychainItem(service: string): unknown {
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SECURITY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Read the active Claude Code credentials as a parsed object.
 *
 * - macOS: reads from system Keychain via the `security` CLI, then the file
 * - Linux / WSL / Windows: reads `<home>/.credentials.json`
 *
 * Returns `null` when credentials are absent or unreadable.
 */
export function readActiveCredentials(configDir?: string): unknown {
  if (process.platform === 'darwin') {
    return readKeychainItem(claudeKeychainService(configDir)) ?? readCredentialsFile(configDir);
  }
  return readCredentialsFile(configDir);
}

/**
 * Write credentials to the active Claude Code credential store.
 *
 * - macOS: writes to system Keychain via the `security` CLI
 * - Linux / WSL / Windows: atomic-writes `<home>/.credentials.json`
 *
 * Throws on failure.
 */
export function writeActiveCredentials(credentials: unknown, configDir?: string): void {
  const json = JSON.stringify(credentials);
  JSON.parse(json); // validate round-trip

  if (process.platform === 'darwin') {
    const service = claudeKeychainService(configDir);
    const command = [
      'add-generic-password',
      '-U',
      '-s',
      quoteSecurityInteractiveArg(service),
      '-a',
      quoteSecurityInteractiveArg(claudeKeychainAccountName()),
      '-w',
      quoteSecurityInteractiveArg(json),
    ].join(' ');
    execFileSync('security', ['-i'], {
      input: command + '\n',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SECURITY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return;
  }
  // Linux / WSL / Windows — file-based (tmp + fsync + rename, retried on Windows)
  atomicWriteFileSync(getCredentialsFilePath(configDir), json, 0o600);
}

/**
 * Remove the credential store of a config directory (an abandoned isolated
 * login, a removed profile). Best effort: never throws.
 */
export function deleteStoredCredentials(configDir: string): void {
  if (process.platform === 'darwin') {
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', claudeKeychainService(configDir)],
        {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: SECURITY_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
    } catch {
      /* no item, or keychain unavailable */
    }
  }
  try {
    fs.rmSync(getCredentialsFilePath(configDir), { force: true });
  } catch {
    /* best effort */
  }
}
