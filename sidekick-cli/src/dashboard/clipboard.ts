/**
 * Clipboard copy for the dashboard, with a toast-ready result.
 *
 * Delegates to the CLI's clipboard helper (pbcopy, clip.exe on Windows and
 * WSL, wl-copy, xclip, xsel, then the terminal's OSC 52 sequence, which also
 * works over SSH), so the dashboard copies wherever `sidekick extract -i` can.
 */

import { copyToClipboard as copyText } from '../utils/clipboard';

export interface ClipboardResult {
  success: boolean;
  /** Human-readable message suitable for display in a toast. */
  message: string;
}

/** Copy text to the system clipboard and describe the outcome. */
export function copyToClipboard(text: string): ClipboardResult {
  let ok = false;
  try {
    ok = copyText(text);
  } catch {
    ok = false;
  }
  return ok
    ? { success: true, message: 'Copied to clipboard' }
    : {
        success: false,
        message:
          process.platform === 'win32'
            ? 'Clipboard unavailable — clip.exe not found'
            : 'Clipboard unavailable — install pbcopy, wl-copy, xclip or xsel, or use a terminal with OSC 52',
      };
}
