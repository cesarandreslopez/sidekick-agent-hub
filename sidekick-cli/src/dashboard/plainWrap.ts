/**
 * Word wrap for plain text measured in terminal columns.
 *
 * For text that is not blessed-tagged, such as toast messages, error messages
 * and changelog entries. Those can contain literal `{bold}` or `${HOME}`, which
 * the tag-aware wrapper would read as markup.
 */

import { displayWidth } from './blessedText';

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

/**
 * Wrap `text` into rows of at most `width` columns, breaking at spaces and
 * hard-breaking words (paths, URLs) longer than a row. Existing line breaks
 * are kept.
 */
export function wrapPlainText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const rows: string[] = [];
  for (const paragraph of text.split('\n')) {
    let row = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = row ? `${row} ${word}` : word;
      if (displayWidth(candidate) <= w) {
        row = candidate;
        continue;
      }
      if (row) rows.push(row);
      row = '';
      if (displayWidth(word) <= w) {
        row = word;
      } else {
        const pieces = breakWord(word, w);
        rows.push(...pieces.slice(0, -1));
        row = pieces[pieces.length - 1] ?? '';
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * At most `maxRows` rows of `text` wrapped to `width`; when it is longer, the
 * last row ends in an ellipsis.
 */
export function wrapPlainTextLimited(text: string, width: number, maxRows: number): string[] {
  const rows = wrapPlainText(text, width);
  if (rows.length <= maxRows) return rows;
  const kept = rows.slice(0, Math.max(1, maxRows));
  const last = kept[kept.length - 1];
  let cut = '';
  for (const ch of Array.from(last)) {
    if (displayWidth(cut + ch) > Math.max(1, width - 1)) break;
    cut += ch;
  }
  kept[kept.length - 1] = `${cut}…`;
  return kept;
}
