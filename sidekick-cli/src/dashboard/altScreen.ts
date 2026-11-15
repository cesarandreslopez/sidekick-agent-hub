/**
 * Alternate-screen session for the full-screen TUIs (`dashboard`,
 * `map --follow`).
 *
 * Once a frame fills the terminal, Ink clears the screen on every render with
 * `ESC[2J ESC[3J ESC[H` — and `ESC[3J` erases the scrollback. Running in the
 * alternate screen leaves the user's scrollback and shell output untouched
 * and restores them on exit; the stream handed to Ink also drops `ESC[3J`,
 * since whether it reaches the main buffer from the alternate screen is up to
 * the terminal.
 *
 * Only a TTY gets any of this. Leaving is idempotent, and it runs from the
 * normal exit path, from signal handlers, from `process.on('exit')`, and
 * before any fatal message is printed (so the message lands in the main
 * screen instead of vanishing with the alternate one).
 */

/** Signals after which a full-screen TUI must unmount and restore the main screen. */
export const DASHBOARD_EXIT_SIGNALS: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGQUIT',
];

const ENTER = '\x1b[?1049h\x1b[H';
const LEAVE = '\x1b[?1049l';
// eslint-disable-next-line no-control-regex
const ERASE_SCROLLBACK = /\x1b\[3J/g;

type WriteFn = (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;

export interface AltScreenSession {
  /** The stream to give Ink: the original stream minus scrollback erases. */
  readonly stdout: NodeJS.WriteStream;
  readonly active: boolean;
  enter(): void;
  leave(): void;
}

let current: AltScreenSession | null = null;

/** Leave whichever alternate screen is active (no-op when none is). */
export function leaveActiveAltScreen(): void {
  current?.leave();
}

/** Strip scrollback erases from a chunk Ink writes. */
export function stripScrollbackErase(chunk: unknown): unknown {
  return typeof chunk === 'string' ? chunk.replace(ERASE_SCROLLBACK, '') : chunk;
}

/**
 * Create (but do not enter) an alternate-screen session on `stream`. On a
 * non-TTY stream it does nothing and hands back the stream unchanged.
 */
export function createAltScreen(stream: NodeJS.WriteStream = process.stdout): AltScreenSession {
  const isTTY = Boolean(stream.isTTY);
  let active = false;
  // Once left, Ink's late writes (an unmount on a signal repaints the last
  // frame) must not land on the restored main screen.
  let left = false;

  const write: WriteFn = (chunk, encoding, callback) => {
    if (left) {
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') (done as () => void)();
      return true;
    }
    return (stream.write as unknown as WriteFn).call(
      stream,
      stripScrollbackErase(chunk),
      encoding,
      callback,
    );
  };

  // A proxy rather than a copy: columns/rows, isTTY and resize listeners stay
  // live on the real stream.
  const wrapped = isTTY
    ? (new Proxy(stream, {
        get(target, prop) {
          if (prop === 'write') return write;
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as NodeJS.WriteStream)
    : stream;

  const onExit = () => session.leave();

  const session: AltScreenSession = {
    stdout: wrapped,
    get active() {
      return active;
    },
    enter() {
      if (active || !isTTY) return;
      stream.write(ENTER);
      active = true;
      current = session;
      process.on('exit', onExit);
    },
    leave() {
      if (!active) return;
      active = false;
      left = true;
      if (current === session) current = null;
      process.removeListener('exit', onExit);
      try {
        stream.write(LEAVE);
      } catch {
        // The terminal is gone; nothing to restore.
      }
    },
  };
  return session;
}
