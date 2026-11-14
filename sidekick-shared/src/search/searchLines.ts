/**
 * Line-by-line scanning for session search: a file read in bounded chunks
 * with a yield to the event loop between them, and the snippet rule every
 * provider's search shares.
 *
 * Node-only: reads files.
 *
 * @module search/searchLines
 * @internal
 */

import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { splitLines } from '../parsers/lineSplitter';
import { yieldToEventLoop } from '../providers/readerDrain';

/** Bytes read per chunk. */
export const SEARCH_READ_CHUNK_BYTES = 1024 * 1024;

export interface ForEachLineOptions {
  /** Checked between chunks; an abort ends the scan (no rejection). */
  signal?: AbortSignal;
  /** Bytes per chunk (default 1 MiB). */
  chunkBytes?: number;
}

/**
 * Calls `onLine` for every line of `source` (a file path, or content
 * already in memory) in order, the last segment included even without a
 * trailing newline, exactly as `content.split('\n')` would list them.
 * `onLine` returning `false` stops the scan. A file is read up to the size
 * it had when opened. Resolves `true` when every line was seen; I/O errors
 * reject.
 */
export async function forEachLineAsync(
  source: string | Buffer,
  onLine: (line: string) => boolean | void,
  options: ForEachLineOptions = {},
): Promise<boolean> {
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? SEARCH_READ_CHUNK_BYTES));
  if (options.signal?.aborted) return false;
  let stopped = false;
  let carry = '';
  const decoder = new StringDecoder('utf8');
  const feed = (line: string) => {
    if (!stopped && onLine(line) === false) stopped = true;
  };
  const consume = (bytes: Buffer) => {
    // Lines after a stop are split but not handed on.
    carry = splitLines(carry, decoder.write(bytes), feed);
  };

  if (typeof source !== 'string') {
    for (let offset = 0; offset < source.length; offset += chunkBytes) {
      if (offset > 0) {
        await yieldToEventLoop();
        if (options.signal?.aborted) return false;
      }
      consume(source.subarray(offset, Math.min(source.length, offset + chunkBytes)));
      if (stopped) return false;
    }
  } else {
    const handle = await fs.promises.open(source, 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, size)));
      let position = 0;
      while (position < size) {
        if (position > 0) {
          await yieldToEventLoop();
          if (options.signal?.aborted) return false;
        }
        const length = Math.min(buffer.length, size - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead <= 0) break;
        // The decoder copies an incomplete trailing character, so the
        // buffer can be reused for the next chunk.
        consume(buffer.subarray(0, bytesRead));
        if (stopped) return false;
        position += bytesRead;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  feed(carry + decoder.end());
  return !stopped;
}

/**
 * The snippet session search shows for a match of `query` in `text`: up to
 * 40 characters either side, `...` where the text was cut, newlines as
 * spaces. `null` when `text` does not contain the query.
 */
export function searchSnippet(text: string, query: string, queryLower: string): string | null {
  const matchIdx = text.toLowerCase().indexOf(queryLower);
  if (matchIdx < 0) return null;
  const start = Math.max(0, matchIdx - 40);
  const end = Math.min(text.length, matchIdx + query.length + 40);
  const snippet =
    (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
  return snippet.replace(/\n/g, ' ');
}
