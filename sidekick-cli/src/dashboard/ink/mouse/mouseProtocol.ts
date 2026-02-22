/**
 * Enable/disable SGR 1006 mouse tracking on the terminal.
 * Writes escape sequences to stdout to toggle mouse event reporting.
 */

/** Enable VT200 button events + drag tracking + SGR encoding. */
export function enableMouse(): void {
  process.stdout.write('\x1b[?1000h'); // button events
  process.stdout.write('\x1b[?1002h'); // drag events
  process.stdout.write('\x1b[?1006h'); // SGR extended encoding
}

/** Disable mouse tracking (reverse order). */
export function disableMouse(): void {
  process.stdout.write('\x1b[?1006l');
  process.stdout.write('\x1b[?1002l');
  process.stdout.write('\x1b[?1000l');
}
