/**
 * Tag-aware text helpers for the dashboard's blessed-style markup.
 *
 * Panels build their output as strings carrying a small set of style tags
 * (`{cyan-fg}`, `{bold}`, `{/bold}`, ...). Everything that measures, cuts or
 * wraps that output goes through this module so the parser, the width maths
 * and the wrapper agree on what a tag is:
 *
 * - Only the tags the dashboard actually emits are tags. Any other braced
 *   text (`${HOME}`, a JSON `{`, `{foo}` in a plan) is literal and visible.
 * - Widths are terminal display columns (emoji and CJK count as two), not
 *   UTF-16 code units.
 */

import stringWidth from 'string-width';

/** Source of the strict tag pattern: colour tags, emphasis, layout, and the brace escapes. */
const TAG_SOURCE = String.raw`\{(\/?)([a-zA-Z]+-(?:fg|bg)|bold|underline|center|open|close)\}`;

/** A fresh global regex for the tags the dashboard emits (fresh, so `lastIndex` is never shared). */
export function blessedTagPattern(): RegExp {
  return new RegExp(TAG_SOURCE, 'g');
}

export type TaggedToken =
  | { kind: 'text'; text: string }
  | { kind: 'open'; name: string; raw: string }
  | { kind: 'close'; name: string; raw: string };

/**
 * Split tagged text into text runs and tags. The escapes `{open}` and
 * `{close}` become the literal braces they stand for.
 */
export function tokenizeTagged(input: string): TaggedToken[] {
  const tokens: TaggedToken[] = [];
  if (!input) return tokens;
  const re = blessedTagPattern();
  let last = 0;
  let match: RegExpExecArray | null;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === 'text') prev.text += text;
    else tokens.push({ kind: 'text', text });
  };
  while ((match = re.exec(input)) !== null) {
    pushText(input.slice(last, match.index));
    last = match.index + match[0].length;
    const isClose = match[1] === '/';
    const name = match[2];
    if (name === 'open' || name === 'close') {
      // `{/open}` has no meaning; keep it as the text it is.
      pushText(isClose ? match[0] : name === 'open' ? '{' : '}');
      continue;
    }
    tokens.push({ kind: isClose ? 'close' : 'open', name, raw: match[0] });
  }
  pushText(input.slice(last));
  return tokens;
}

/** Escape literal braces so the tag parser renders them as text. */
function escapeText(text: string): string {
  return text.replace(/[{}]/g, (brace) => (brace === '{' ? '{open}' : '{close}'));
}

/** Display width of plain text in terminal columns. */
export function displayWidth(text: string): number {
  if (!text) return 0;
  // ASCII fast path: printable ASCII is one column per character.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  return stringWidth(text);
}

/** Visible text of tagged markup (tags removed, escapes resolved). */
export function stripTagged(input: string): string {
  let out = '';
  for (const token of tokenizeTagged(input)) if (token.kind === 'text') out += token.text;
  return out;
}

/** Display width of tagged markup. */
export function visibleWidth(input: string): number {
  return displayWidth(stripTagged(input));
}

let segmenter: Intl.Segmenter | null = null;
/** Split text into grapheme clusters (so an emoji with modifiers is one unit). */
function graphemes(text: string): string[] {
  if (/^[\x20-\x7e]*$/.test(text)) return text.split('');
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Normalise characters a terminal cannot lay out predictably. */
function sanitizeText(text: string): string {
  return text.replace(/\t/g, '    ').replace(/\r/g, '');
}

function closingTags(stack: Array<{ name: string }>): string {
  let out = '';
  for (let i = stack.length - 1; i >= 0; i--) out += `{/${stack[i].name}}`;
  return out;
}

function applyTag(stack: Array<{ name: string; raw: string }>, token: TaggedToken): void {
  if (token.kind === 'open') {
    stack.push({ name: token.name, raw: token.raw });
  } else if (token.kind === 'close') {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === token.name) {
        stack.splice(i);
        break;
      }
    }
  }
}

/**
 * Cut tagged markup to at most `maxWidth` display columns, ending with an
 * ellipsis when anything was removed. Tags are kept balanced.
 */
export function truncateTagged(input: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(input) <= maxWidth) return input;
  const ellipsisWidth = displayWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisWidth);
  const stack: Array<{ name: string; raw: string }> = [];
  let out = '';
  let used = 0;
  outer: for (const token of tokenizeTagged(input)) {
    if (token.kind !== 'text') {
      applyTag(stack, token);
      out += token.raw;
      continue;
    }
    for (const g of graphemes(sanitizeText(token.text))) {
      const w = displayWidth(g);
      if (used + w > budget) break outer;
      out += escapeText(g);
      used += w;
    }
  }
  return out + (ellipsisWidth <= maxWidth ? ellipsis : '') + closingTags(stack);
}

type Atom =
  | { tag: TaggedToken & { kind: 'open' | 'close' } }
  | { g: string; w: number; space: boolean };

/**
 * Wrap tagged content into physical rows no wider than `width` columns.
 *
 * - Breaks at spaces where possible and hard-breaks words (paths, URLs, JSON
 *   strings) longer than the row.
 * - A wrapped line's continuation rows keep its leading indentation (capped
 *   at half the width), so wrapped JSON and lists stay readable.
 * - Every row is self-contained: tags open at the end of a row are closed
 *   there and reopened on the next row. Tags left open at the end of a line
 *   carry over to the following lines, so a colour spanning several lines
 *   styles all of them.
 */
export function wrapTaggedLines(content: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let carried: Array<{ name: string; raw: string }> = [];

  for (const rawLine of content.split('\n')) {
    // Fast path: plain ASCII that fits, with no styles carried in.
    if (
      carried.length === 0 &&
      rawLine.length <= w &&
      !rawLine.includes('{') &&
      /^[\x20-\x7e]*$/.test(rawLine)
    ) {
      rows.push(rawLine);
      continue;
    }

    const atoms: Atom[] = [];
    for (const token of tokenizeTagged(rawLine)) {
      if (token.kind !== 'text') {
        atoms.push({ tag: token });
        continue;
      }
      for (const g of graphemes(sanitizeText(token.text))) {
        atoms.push({ g, w: displayWidth(g), space: g === ' ' });
      }
    }

    // Continuation indent: the line's leading spaces, capped.
    let leading = 0;
    for (const atom of atoms) {
      if ('tag' in atom) continue;
      if (atom.space) leading++;
      else break;
    }
    const indentWidth = Math.min(leading, Math.floor(w / 2));
    const indentAtoms = (): Atom[] =>
      Array.from({ length: indentWidth }, () => ({ g: ' ', w: 1, space: true }));

    const lineRows: Atom[][] = [];
    let row: Atom[] = [];
    let rowWidth = 0;
    // Leading columns of `row` that are indentation, never a break point. The
    // first row's indentation is the line's own leading spaces.
    let rowIndent = Math.min(leading, w - 1);
    const startRow = (initial: Atom[] = []) => {
      row = [...indentAtoms(), ...initial];
      rowIndent = indentWidth;
      rowWidth = row.reduce((sum, a) => sum + ('tag' in a ? 0 : a.w), 0);
    };
    const flush = () => {
      lineRows.push(row);
    };

    for (const atom of atoms) {
      if ('tag' in atom) {
        row.push(atom);
        continue;
      }
      if (rowWidth + atom.w > w && rowWidth > rowIndent) {
        if (atom.space) {
          // Break here; the space itself is dropped.
          flush();
          startRow();
          continue;
        }
        // Find the last space after the indent to break at.
        let breakAt = -1;
        let seenText = 0;
        for (let i = 0; i < row.length; i++) {
          const a = row[i];
          if ('tag' in a) continue;
          seenText++;
          if (seenText > rowIndent && a.space) breakAt = i;
        }
        if (breakAt > 0) {
          const tail = row.slice(breakAt + 1);
          row = row.slice(0, breakAt);
          flush();
          startRow(tail);
          // A tail that still cannot take this atom gets a hard break.
          if (rowWidth + atom.w > w && rowWidth > rowIndent) {
            flush();
            startRow();
          }
        } else {
          flush();
          startRow();
        }
      }
      row.push(atom);
      rowWidth += atom.w;
    }
    lineRows.push(row);

    // Serialise rows, threading the tag stack through them.
    const stack = [...carried];
    lineRows.forEach((atomsOfRow, rowIndex) => {
      // Rows ended by a break drop the spaces they end with.
      if (rowIndex < lineRows.length - 1) {
        let lastText = -1;
        for (let i = atomsOfRow.length - 1; i >= 0; i--) {
          const a = atomsOfRow[i];
          if (!('tag' in a) && !a.space) {
            lastText = i;
            break;
          }
        }
        atomsOfRow = atomsOfRow.filter((a, i) => i <= lastText || 'tag' in a);
      }
      let out = stack.map((t) => t.raw).join('');
      for (const atom of atomsOfRow) {
        if ('tag' in atom) {
          applyTag(stack, atom.tag);
          out += atom.tag.raw;
        } else {
          out += escapeText(atom.g);
        }
      }
      rows.push(out + closingTags(stack));
    });
    carried = stack;
  }

  return rows;
}
