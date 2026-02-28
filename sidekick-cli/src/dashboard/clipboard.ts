/**
 * Cross-platform clipboard copy utility.
 *
 * Handles macOS (pbcopy), Wayland (wl-copy), and X11 (xclip, xsel).
 * Returns a result object instead of silently swallowing errors.
 */

import { execSync } from 'child_process';

export interface ClipboardResult {
  success: boolean;
  /** Human-readable message suitable for display in a toast. */
  message: string;
}

/**
 * Copy text to the system clipboard.
 *
 * On Linux, tries clipboard tools in order of preference:
 *   1. `wl-copy` — if `WAYLAND_DISPLAY` env var is set
 *   2. `xclip -selection clipboard`
 *   3. `xsel --clipboard --input`
 *
 * On macOS, uses `pbcopy`.
 */
export function copyToClipboard(text: string): ClipboardResult {
  if (process.platform === 'darwin') {
    return tryCommand('pbcopy', [], text);
  }

  // Linux / other Unix
  const commands = buildLinuxCommands();

  for (const [cmd, args] of commands) {
    const result = tryCommand(cmd, args, text);
    if (result.success) return result;
  }

  return {
    success: false,
    message: 'Clipboard unavailable — install wl-copy, xclip, or xsel',
  };
}

function buildLinuxCommands(): [string, string[]][] {
  const commands: [string, string[]][] = [];

  if (process.env.WAYLAND_DISPLAY) {
    commands.push(['wl-copy', []]);
  }

  commands.push(['xclip', ['-selection', 'clipboard']]);
  commands.push(['xsel', ['--clipboard', '--input']]);

  return commands;
}

function tryCommand(cmd: string, args: string[], input: string): ClipboardResult {
  try {
    const fullCmd = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
    execSync(fullCmd, { input, stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, message: 'Copied to clipboard' };
  } catch {
    return { success: false, message: `${cmd} failed` };
  }
}
