/**
 * Word wrap for plain text measured in terminal columns.
 *
 * For text that is not blessed-tagged, such as toast messages, error messages
 * and changelog entries. Those can contain literal `{bold}` or `${HOME}`, which
 * the tag-aware wrapper would read as markup.
 */

import { displayWidth } from './blessedText';

interface PlainRow {
  text: string;
  /** This row continues the previous row's word (it was hard-broken). */
  joined: boolean;
}

/** Hard-break one word into pieces of at most `width` columns. */
function breakWord(word: string, width: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const ch of Array.from(word)) {
    if (piece && displayWidth(piece + ch) > width) {
      pieces.push(piece);
      piece = '';
    }
    piece += ch;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

function wrapPlainRows(text: string, width: number): PlainRow[] {
  const w = Math.max(1, width);
  const rows: PlainRow[] = [];
  for (const paragraph of text.split('\n')) {
    let row = '';
    let rowJoined = false;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = row ? `${row} ${word}` : word;
      if (displayWidth(candidate) <= w) {
        row = candidate;
        continue;
      }
      if (row) rows.push({ text: row, joined: rowJoined });
      row = '';
      rowJoined = false;
      if (displayWidth(word) <= w) {
        row = word;
      } else {
        const pieces = breakWord(word, w);
        pieces.slice(0, -1).forEach((piece, i) => rows.push({ text: piece, joined: i > 0 }));
        row = pieces[pieces.length - 1] ?? '';
        rowJoined = pieces.length > 1;
      }
    }
    rows.push({ text: row, joined: rowJoined });
  }
  return rows;
}

/**
 * Wrap `text` into rows of at most `width` columns, breaking at spaces and
 * hard-breaking words (paths, URLs) longer than a row. Existing line breaks
 * are kept.
 */
export function wrapPlainText(text: string, width: number): string[] {
  return wrapPlainRows(text, width).map((row) => row.text);
}

/** The end of `text` that fits in `width` columns. */
function tailToWidth(text: string, width: number): string {
  let tail = '';
  const chars = Array.from(text);
  for (let i = chars.length - 1; i >= 0; i--) {
    if (displayWidth(chars[i] + tail) > width) break;
    tail = chars[i] + tail;
  }
  return tail;
}

/**
 * At most `maxRows` rows of `text` wrapped to `width`. When it is longer, the
 * last row is an ellipsis and the end of the text: the end of a message such
 * as a report path is its file name, which identifies it. The rest is
 * re-joined exactly as written, with no space added inside a hard-broken word.
 */
export function wrapPlainTextLimited(text: string, width: number, maxRows: number): string[] {
  const rows = wrapPlainRows(text, width);
  if (rows.length <= maxRows) return rows.map((row) => row.text);
  const keep = Math.max(1, maxRows) - 1;
  const kept = rows.slice(0, keep).map((row) => row.text);
  let rest = '';
  rows.slice(keep).forEach((row, i) => {
    rest += i === 0 || row.joined ? row.text : ` ${row.text}`;
  });
  kept.push(`…${tailToWidth(rest, Math.max(1, width - 1))}`);
  return kept;
}
