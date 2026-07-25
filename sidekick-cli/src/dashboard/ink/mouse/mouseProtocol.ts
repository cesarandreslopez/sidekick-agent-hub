/**
 * Enable/disable SGR 1006 mouse tracking on the terminal.
 * Writes escape sequences to stdout to toggle mouse event reporting.
 */

/** Minimal shape needed to toggle mouse tracking; parameterized for tests. */
type MouseStream = Pick<NodeJS.WriteStream, 'write'> & { isTTY?: boolean };

/**
 * Enable VT200 button events + drag tracking + SGR encoding.
 *
 * No-op when the stream is not a TTY — a redirected or piped stdout would
 * otherwise carry the control sequences into the captured output.
 */
export function enableMouse(stream: MouseStream = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write('\x1b[?1000h'); // button events
  stream.write('\x1b[?1002h'); // drag events
  stream.write('\x1b[?1006h'); // SGR extended encoding
}

/** Disable mouse tracking (reverse order). */
export function disableMouse(stream: MouseStream = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write('\x1b[?1006l');
  stream.write('\x1b[?1002l');
  stream.write('\x1b[?1000l');
}
