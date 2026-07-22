/**
 * Open a URL in the default browser.
 *
 * Adapted from `trawl` by Juan Fourie (B33pBeeps), MIT licensed:
 * https://github.com/B33pBeeps/trawl
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

function isWSL(): boolean {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function opener(): string {
  if (platform() === 'darwin') return 'open';
  if (platform() === 'win32') return 'rundll32.exe';
  if (isWSL()) return 'explorer.exe';
  return 'xdg-open';
}

export function openUrl(url: string): boolean {
  try {
    const executable = opener();
    const args = platform() === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
    // spawn failures are asynchronous and otherwise become uncaught 'error'
    // events after this function returns.
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
