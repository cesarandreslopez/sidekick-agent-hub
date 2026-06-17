/**
 * Open a URL in the default browser (detached).
 *
 * Adapted from `trawl` (MIT, (c) 2026 Juan Fourie).
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { readFileSync } from 'node:fs';

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

/** Open `url` in the default browser. Returns true if the opener spawned. */
export function openUrl(url: string): boolean {
  try {
    const child = spawn(opener(), [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
