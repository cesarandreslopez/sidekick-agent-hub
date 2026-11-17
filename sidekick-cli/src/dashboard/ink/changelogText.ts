/**
 * Changelog entries as wrapped rows for the What's New overlay.
 *
 * Entries are markdown: `**bold**`, backticked code, and nested bullets joined
 * with " - ". They are plain text otherwise, and may contain literal `{bold}` or
 * `${HOME}`, so they are never passed through the blessed-tag parser.
 */

import { displayWidth } from '../blessedText';

export interface ChangelogSegment {
  text: string;
  bold: boolean;
}

/** One rendered row: its segments, and whether it starts a (sub-)bullet. */
export interface ChangelogRow {
  segments: ChangelogSegment[];
  /** 0 for a top-level item, 1 for a nested " - " bullet. */
  level: 0 | 1;
  /** First row of its bullet (draws the bullet glyph). */
  first: boolean;
}

type Word = ChangelogSegment[];

function wordWidth(word: Word): number {
  return word.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
}

/** Split text into words, each a run of segments with their bold state. */
function tokenize(text: string): Word[] {
  const words: Word[] = [];
  let bold = false;
  for (const raw of text.replace(/`/g, '').split(/\s+/).filter(Boolean)) {
    const word: Word = [];
    const parts = raw.split('**');
    parts.forEach((part, i) => {
      if (i > 0) bold = !bold;
      if (part) word.push({ text: part, bold });
    });
    if (word.length > 0) words.push(word);
  }
  return words;
}

/** Hard-break a word wider than `width` into pieces that fit. */
function breakWord(word: Word, width: number): Word[] {
  const pieces: Word[] = [];
  let piece: Word = [];
  let used = 0;
  for (const segment of word) {
    for (const ch of Array.from(segment.text)) {
      const w = displayWidth(ch);
      if (used + w > width && used > 0) {
        pieces.push(piece);
        piece = [];
        used = 0;
      }
      const last = piece[piece.length - 1];
      if (last && last.bold === segment.bold) last.text += ch;
      else piece.push({ text: ch, bold: segment.bold });
      used += w;
    }
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

function wrapWords(words: Word[], width: number): ChangelogSegment[][] {
  const w = Math.max(1, width);
  const rows: ChangelogSegment[][] = [];
  let row: ChangelogSegment[] = [];
  let used = 0;
  const push = (word: Word) => {
    if (row.length > 0) row.push({ text: ' ', bold: false });
    row.push(...word);
    used += (used > 0 ? 1 : 0) + wordWidth(word);
  };
  for (const word of words) {
    const width = wordWidth(word);
    if (used > 0 && used + 1 + width <= w) {
      push(word);
      continue;
    }
    if (used > 0) {
      rows.push(row);
      row = [];
      used = 0;
    }
    if (width <= w) {
      push(word);
    } else {
      const pieces = breakWord(word, w);
      for (const piece of pieces.slice(0, -1)) rows.push(piece);
      push(pieces[pieces.length - 1]);
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * Rows for one changelog item at an inner width of `width` columns. The
 * bullet prefix ("    • ", six columns; "      ◦ " for a nested bullet,
 * eight) is the caller's; rows here fit the space after it.
 */
export function changelogItemRows(item: string, width: number): ChangelogRow[] {
  const [main, ...nested] = item.split(/\s+-\s+(?=\S)/);
  const rows: ChangelogRow[] = [];
  wrapWords(tokenize(main), width - 6).forEach((segments, i) =>
    rows.push({ segments, level: 0, first: i === 0 }),
  );
  for (const sub of nested) {
    wrapWords(tokenize(sub), width - 8).forEach((segments, i) =>
      rows.push({ segments, level: 1, first: i === 0 }),
    );
  }
  return rows;
}
