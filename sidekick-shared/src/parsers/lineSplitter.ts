/**
 * Newline splitting for text that arrives in chunks.
 *
 * `splitLines` hands every complete line to `onLine` and returns what follows
 * the last newline, to pass back with the next chunk. It scans only the new
 * chunk, so a line spanning many chunks costs one scan per chunk rather than
 * a rescan of everything buffered (the cost of `(carry + chunk).split('\n')`),
 * and it builds no array of lines.
 *
 * @module parsers/lineSplitter
 */

/**
 * Calls `onLine` for each line completed by `chunk` (without its `\n`) and
 * returns the unterminated remainder. `carry` is the remainder of the
 * previous call (`''` at the start).
 */
export function splitLines(carry: string, chunk: string, onLine: (line: string) => void): string {
  let newline = chunk.indexOf('\n');
  if (newline === -1) return carry + chunk;
  onLine(carry + chunk.slice(0, newline));
  let start = newline + 1;
  while ((newline = chunk.indexOf('\n', start)) !== -1) {
    onLine(chunk.slice(start, newline));
    start = newline + 1;
  }
  return chunk.slice(start);
}
