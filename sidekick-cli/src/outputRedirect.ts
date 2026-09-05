import * as fs from 'fs';

/**
 * Route everything the command writes to stdout into a file.
 *
 * Writes are synchronous so nothing is lost if a command sets an exit code
 * and returns before the event loop drains. stderr is untouched, so progress
 * notes and errors still reach the terminal.
 */
export function installOutputRedirect(filePath: string): void {
  const fd = fs.openSync(filePath, 'w');
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
