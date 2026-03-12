/**
 * Platform-aware credential I/O for Claude Code.
 *
 * On macOS, Claude Code stores OAuth credentials in the system Keychain
 * (service "Claude Code-credentials"). On Linux/WSL/Windows, credentials
 * live in ~/.claude/.credentials.json.
 *
 * Both accounts.ts and credentials.ts consume this module so that all
 * credential access is platform-correct in one place.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function getCredentialsFilePath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Read the active Claude Code credentials as a parsed object.
 *
 * - macOS: reads from system Keychain via the `security` CLI
 * - Linux / WSL / Windows: reads `~/.claude/.credentials.json`
 *
 * Returns `null` when credentials are absent or unreadable.
 */
export function readActiveCredentials(): unknown {
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', [
        'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w',
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return JSON.parse(raw.trim());
    } catch {
      return null;
    }
  }
  // Linux / WSL / Windows — file-based
  try {
    return JSON.parse(fs.readFileSync(getCredentialsFilePath(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write credentials to the active Claude Code credential store.
 *
 * - macOS: writes to system Keychain via the `security` CLI
 * - Linux / WSL / Windows: atomic-writes `~/.claude/.credentials.json`
 *
 * Throws on failure.
 */
export function writeActiveCredentials(credentials: unknown): void {
  const json = JSON.stringify(credentials);
  JSON.parse(json); // validate round-trip

  if (process.platform === 'darwin') {
    execFileSync('security', [
      'add-generic-password', '-U',
      '-s', KEYCHAIN_SERVICE,
      '-a', process.env.USER || 'user',
      '-w', json,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    return;
  }
  // Linux / WSL / Windows — file-based
  const credPath = getCredentialsFilePath();
  const tmp = credPath + '.tmp';
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, credPath);
}
