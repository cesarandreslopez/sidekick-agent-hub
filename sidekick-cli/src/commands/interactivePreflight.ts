/**
 * TTY preflight for the full-screen Ink surfaces.
 *
 * Ink sets `isRawModeSupported = stdin.isTTY` and throws from `setRawMode`
 * when it is false. Ink catches that throw and renders it as an error panel
 * rather than crashing, so a piped or redirected invocation produced a garbled
 * frame with the error mixed into the normal output — and still exited 0, so
 * scripts read it as success.
 *
 * Checking up front lets those invocations fail cleanly with a message that
 * names the problem and points at a command that does work when piped.
 */

export interface TerminalCapabilities {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

export interface PreflightFailure {
  message: string;
  exitCode: number;
}

/** Capabilities of the current process streams. */
export function currentTerminalCapabilities(): TerminalCapabilities {
  return {
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
}

/**
 * `null` when the terminal can host a full-screen Ink app, otherwise a
 * ready-to-print failure.
 *
 * @param command  Name used in the message, e.g. `dashboard`.
 * @param fallbackHint  A command that does the same job non-interactively.
 */
export function checkInteractivePreflight(
  caps: TerminalCapabilities,
  command: string,
  fallbackHint: string,
): PreflightFailure | null {
  if (caps.stdinIsTTY && caps.stdoutIsTTY) return null;

  const which = !caps.stdinIsTTY
    ? 'stdin is not a TTY (input is piped or redirected)'
    : 'stdout is not a TTY (output is piped or redirected)';

  return {
    message:
      `sidekick ${command} needs an interactive terminal.\n` +
      `  ${which}\n` +
      `  Try: ${fallbackHint}\n`,
    exitCode: 1,
  };
}
