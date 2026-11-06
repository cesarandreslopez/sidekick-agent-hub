/**
 * Splits a process's output into lines: UTF-8 bytes decoded across chunk
 * edges, a leading byte-order mark dropped, CRLF accepted, and lines over a
 * byte limit skipped without being buffered. The same lines come out
 * whatever the chunking.
 *
 * Pure: `TextDecoder` only.
 *
 * @module headless/lineSplitter
 */

/** Default longest line, in UTF-8 bytes. */
export const DEFAULT_HEADLESS_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface LineSplitter {
  /** Complete lines (without `\n` or `\r\n`) that this chunk finished. */
  push(chunk: string | Uint8Array): string[];
  /** The final line when the output did not end with a newline. */
  end(): string[];
  /** Complete lines seen, blank ones included. */
  readonly lines: number;
  /** Lines skipped for exceeding the limit. */
  readonly oversizedLines: number;
}

/** UTF-8 length of `text` (a lone surrogate counts as 3, a pair as 4). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xdc00 && code <= 0xdfff ? 1 : 3;
  }
  return bytes;
}

export function createLineSplitter(options: { maxLineBytes?: number } = {}): LineSplitter {
  const maxLineBytes =
    typeof options.maxLineBytes === 'number' && options.maxLineBytes >= 1
      ? Math.floor(options.maxLineBytes)
      : DEFAULT_HEADLESS_MAX_LINE_BYTES;
  // Strips one leading BOM, keeps multi-byte characters split across chunks.
  const decoder = new TextDecoder('utf-8');
  let pieces: string[] = [];
  let pieceBytes = 0;
  let skipping = false;
  let sawText = false;
  let lines = 0;
  let oversizedLines = 0;

  const finishLine = (out: string[]): void => {
    lines++;
    if (!skipping) {
      const line = pieces.join('');
      out.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    pieces = [];
    pieceBytes = 0;
    skipping = false;
  };

  const feed = (text: string): string[] => {
    const out: string[] = [];
    let index = 0;
    while (index < text.length) {
      const newline = text.indexOf('\n', index);
      const end = newline === -1 ? text.length : newline;
      if (!skipping && end > index) {
        const piece = text.slice(index, end);
        const bytes = utf8Bytes(piece);
        if (pieceBytes + bytes > maxLineBytes) {
          skipping = true;
          oversizedLines++;
          pieces = [];
          pieceBytes = 0;
        } else {
          pieces.push(piece);
          pieceBytes += bytes;
        }
      }
      if (newline === -1) break;
      finishLine(out);
      index = newline + 1;
    }
    return out;
  };

  return {
    push(chunk) {
      let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (!sawText && text.length > 0) {
        sawText = true;
        if (typeof chunk === 'string' && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      return feed(text);
    },
    end() {
      const out = feed(decoder.decode());
      if (pieces.length > 0 || skipping) finishLine(out);
      return out;
    },
    get lines() {
      return lines;
    },
    get oversizedLines() {
      return oversizedLines;
    },
  };
}
