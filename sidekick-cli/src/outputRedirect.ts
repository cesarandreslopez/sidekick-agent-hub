import * as fs from 'fs';
import chalk from 'chalk';

/**
 * Route everything the command writes to stdout into a file.
 *
 * Writes are synchronous so nothing is lost if a command sets an exit code
 * and returns before the event loop drains. stderr is untouched, so progress
 * notes and errors still reach the terminal.
 *
 * The file gets plain text: chalk chose its colour level at import time from
 * the terminal stdout was attached to, so it is reset here unless the caller
 * set `FORCE_COLOR` to keep the escapes (for `less -R` and the like).
 */
export function installOutputRedirect(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const fd = fs.openSync(filePath, 'w');
  if (!env.FORCE_COLOR) chalk.level = 0;
  const stdout = process.stdout as NodeJS.WriteStream & {
    write: (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;
  };
  stdout.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const cb = typeof encoding === 'function' ? encoding : callback;
    const data =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
        : (chunk as Uint8Array);
    fs.writeSync(fd, data);
    if (typeof cb === 'function') cb();
    return true;
  }) as typeof stdout.write;
  process.on('exit', () => {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
  });
}

/** Commands whose stdout is a live UI or a wire protocol, not a document. */
export const REDIRECT_UNSUPPORTED_COMMANDS = new Set(['dashboard', 'mcp']);
