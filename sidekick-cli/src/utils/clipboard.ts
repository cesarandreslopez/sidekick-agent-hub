/**
 * Terminal clipboard copy helpers.
 *
 * Adapted from `trawl` by Juan Fourie (B33pBeeps), MIT licensed:
 * https://github.com/B33pBeeps/trawl
 */

import { execSync, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { platform } from 'node:os';

function which(bin: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function isWSL(): boolean {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

export function clipboardAttempts(
  runtimePlatform: NodeJS.Platform,
  wsl: boolean,
  wayland: boolean,
): Array<[string, string[]]> {
  const attempts: Array<[string, string[]]> = [];
  if (runtimePlatform === 'darwin') attempts.push(['pbcopy', []]);
  else if (runtimePlatform === 'win32' || wsl) attempts.push(['clip.exe', []]);
  if (wayland) attempts.push(['wl-copy', []]);
  if (runtimePlatform !== 'win32') {
    attempts.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['-ib']]);
  }
  return attempts;
}

function nativeCopy(text: string): boolean {
  const attempts = clipboardAttempts(platform(), isWSL(), !!process.env.WAYLAND_DISPLAY);

  for (const [bin, args] of attempts) {
    if (!which(bin)) continue;
    const result = spawnSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    if (result.status === 0) return true;
  }

  return false;
}

function osc52Copy(text: string): boolean {
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  let sequence = `\x1b]52;c;${base64}\x07`;

  if (process.env.TMUX) {
    const esc = '\x1b';
    sequence = `${esc}Ptmux;${esc}${sequence.split(esc).join(esc + esc)}${esc}\\`;
  }

  try {
    const fd = openSync('/dev/tty', 'w');
    writeSync(fd, sequence);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function copyToClipboard(text: string): boolean {
  const osc52Available = platform() !== 'win32';
  if (process.env.SIDEKICK_CLIP === 'osc52') {
    return (osc52Available && osc52Copy(text)) || nativeCopy(text);
  }
  return nativeCopy(text) || (osc52Available && osc52Copy(text));
}
