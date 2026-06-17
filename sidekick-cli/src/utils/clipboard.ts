/**
 * Clipboard copy for the terminal.
 *
 * Clipboard logic is adapted from `trawl` (MIT, (c) 2026 Juan Fourie), but the
 * default order is flipped: native tools (wl-copy/xclip/pbcopy) are tried FIRST
 * because `sidekick extract` runs in the user's normal terminal — and inside
 * tmux/screen (TERM=screen-*) an OSC52 escape written to the tty is usually
 * swallowed, so it "succeeds" without ever reaching the system clipboard.
 * OSC52 remains the fallback for remote/SSH terminals with no native tool, and
 * is wrapped for tmux passthrough so it works there too. `SIDEKICK_CLIP=osc52`
 * forces OSC52 first.
 */

import { spawnSync, execSync } from 'node:child_process';
import { openSync, writeSync, closeSync, readFileSync } from 'node:fs';
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

function nativeCopy(text: string): boolean {
  const tries: Array<[string, string[]]> = [];
  if (platform() === 'darwin') tries.push(['pbcopy', []]);
  else if (isWSL()) tries.push(['clip.exe', []]);
  if (process.env.WAYLAND_DISPLAY) tries.push(['wl-copy', []]);
  tries.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['-ib']]);

  for (const [bin, args] of tries) {
    if (!which(bin)) continue;
    // stdout/stderr → 'ignore', not piped: wl-copy forks a daemon that keeps
    // the selection alive and inherits these fds. If they were pipes, spawnSync
    // would block waiting for EOF that never comes (the daemon holds them open).
    const r = spawnSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    if (r.status === 0) return true;
  }
  return false;
}

/**
 * OSC52: write base64 of the text wrapped in the clipboard escape to the tty.
 * Inside tmux the sequence is wrapped in a DCS passthrough so it reaches the
 * outer terminal. Only counts as success if a real tty took it.
 */
function osc52Copy(text: string): boolean {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  let seq = `\x1b]52;c;${b64}\x07`;
  // tmux: wrap in passthrough (\ePtmux;\e <inner, ESC doubled> \e\\)
  if (process.env.TMUX) {
    const esc = '\x1b';
    seq = `${esc}Ptmux;${esc}${seq.split(esc).join(esc + esc)}${esc}\\`;
  }
  try {
    const fd = openSync('/dev/tty', 'w');
    writeSync(fd, seq);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Copy `text` to the system clipboard. Returns true on success. */
export function copyToClipboard(text: string): boolean {
  if (process.env.SIDEKICK_CLIP === 'osc52') return osc52Copy(text) || nativeCopy(text);
  // Native first (reliable across tmux/screen), OSC52 fallback for SSH/remote.
  return nativeCopy(text) || osc52Copy(text);
}
