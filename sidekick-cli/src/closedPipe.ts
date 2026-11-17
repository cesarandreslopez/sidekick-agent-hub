/**
 * A reader that stops early (`sidekick stats | head -2`, `less` quit early)
 * closes the pipe, and the next write fails with EPIPE. Unhandled, that is a
 * Node stack trace and exit 1 for what Unix filters treat as a normal end.
 *
 * Installed once at both entry points (the SEA build starts at `cli.ts`, so
 * the launcher's `entry.ts` alone would miss it).
 */

export interface ClosedPipeOptions {
  /**
   * End the process once the reader is gone. The status line passes false:
   * after printing it still writes `state.json` and persists the official
   * quota, which an early exit would cut off.
   */
  exit: boolean;
  /** Runs before exiting (gives the terminal back if a full-screen view was up). */
  beforeExit?: () => void;
  /** Test seam; defaults to `process.exit`. */
  exitProcess?: (code: number) => void;
}

type ErrorEmitter = Pick<NodeJS.EventEmitter, 'on'>;

function exitCodeNow(): number {
  const code = Number(process.exitCode ?? 0);
  return Number.isInteger(code) ? code : 1;
}

export function installClosedPipeHandler(
  options: ClosedPipeOptions,
  streams: readonly ErrorEmitter[] = [process.stdout, process.stderr],
): void {
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  let exiting = false;
  for (const stream of streams) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code !== 'EPIPE') throw err;
      if (!options.exit || exiting) return;
      exiting = true;
      options.beforeExit?.();
      // A failed command stays failed; a closed reader alone is not a failure.
      exitProcess(exitCodeNow());
    });
  }
}
