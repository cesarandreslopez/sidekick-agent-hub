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
  if (isWSL()) return 'explorer.exe';
  return 'xdg-open';
}

export function openUrl(url: string): boolean {
  try {
    const child = spawn(opener(), [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
