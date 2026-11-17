import os from 'node:os';
import type { ProviderId, SessionProviderBase } from 'sidekick-shared';

export function selectSessionProvider(
  original: SessionProviderBase,
  additional: SessionProviderBase[],
  selectedProviderId: ProviderId | undefined,
  createProvider: (id: ProviderId) => SessionProviderBase,
): SessionProviderBase {
  if (!selectedProviderId || selectedProviderId === original.id) return original;
  const active = additional.find((provider) => provider.id === selectedProviderId);
  original.dispose();
  return active ?? createProvider(selectedProviderId);
}

/**
 * The exit status for a process ended by `signal`: 128 plus the signal's
 * number (143 for SIGTERM, 129 for SIGHUP), as shells report it, so a script
 * can tell a killed dashboard from one the user quit. No signal means a
 * normal exit.
 */
export function signalExitCode(signal?: string): number {
  if (!signal) return 0;
  const number = (os.constants.signals as Record<string, number | undefined>)[signal];
  return typeof number === 'number' ? 128 + number : 1;
}

export function createDashboardSignalHandler(
  cleanup: () => void,
  unmount: () => void,
  exitProcess: (code: number) => void = (code) => process.exit(code),
): (signal?: NodeJS.Signals) => void {
  // Node passes the signal's name to the listener.
  return (signal) => {
    cleanup();
    unmount();
    exitProcess(signalExitCode(signal));
  };
}

/** A fatal error's text for the main screen: the stack when there is one. */
export function formatFatalError(error: unknown): string {
  if (error instanceof Error) return `${error.stack ?? `${error.name}: ${error.message}`}\n`;
  return `Unexpected error: ${String(error)}\n`;
}

export interface TuiFatalHandlerOptions {
  /** Stop timers and watchers, unmount Ink, release the mouse, leave the alternate screen. */
  teardown: () => void;
  /** Write to the main screen and call `done` once flushed. */
  write: (text: string, done: () => void) => void;
  exitProcess?: (code: number) => void;
  /** The process to listen on; injectable for tests. */
  target?: Pick<NodeJS.Process, 'on' | 'removeListener'>;
}

/**
 * While a full-screen TUI is up, an error nobody catches would otherwise print
 * into the alternate screen (wiped a moment later) and leave raw mode, mouse
 * tracking and timers running, so the process hung until a second Ctrl+C,
 * which then exited 0. These handlers tear the TUI down first, print the
 * error on the main screen, and exit 1 once it is flushed.
 *
 * Installed only after the screen is entered and removed by the returned
 * disposer: never at module scope, where they would take over a test
 * runner's own handlers.
 */
export function installTuiFatalHandlers(options: TuiFatalHandlerOptions): () => void {
  const target = options.target ?? process;
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  let fired = false;
  const onFatal = (error: unknown): void => {
    if (fired) return;
    fired = true;
    dispose();
    try {
      options.teardown();
    } catch {
      // Already failing; the message below matters more than a clean teardown.
    }
    options.write(formatFatalError(error), () => exitProcess(1));
  };
  function dispose(): void {
    target.removeListener('uncaughtException', onFatal);
    target.removeListener('unhandledRejection', onFatal);
  }
  target.on('uncaughtException', onFatal);
  target.on('unhandledRejection', onFatal);
  return dispose;
}

/** Write to stderr and call `done` once the text has been flushed. */
export function writeToStderr(text: string, done: () => void): void {
  process.stderr.write(text, () => done());
}
