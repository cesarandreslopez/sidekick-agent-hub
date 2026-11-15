/**
 * Decides what fits on the one-row status bar.
 *
 * Every candidate segment has a priority; the plan keeps the brand and the
 * `? help  q quit` hints, then adds the rest in priority order while the
 * row still fits. Rendering never relies on flex shrinking, which wrapped
 * each zone inside the one-row box and showed only its first line
 * ("SIDEKI │Claude │4 ● active").
 */

import { displayWidth } from '../blessedText';

export interface StatusPiece {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

export type StatusZone = 'left' | 'center' | 'right';

export interface StatusSegment {
  id: string;
  zone: StatusZone;
  /** 0 = always shown; higher numbers are dropped first. */
  priority: number;
  pieces: StatusPiece[];
}

/** Separator drawn before each centre segment. */
export const CENTER_SEPARATOR = ' │ ';
/** Prefix drawn once before the right-hand hints. */
export const RIGHT_PREFIX = '│ ';
/** Gap between right-hand hints. */
export const HINT_GAP = '  ';

function piecesWidth(pieces: StatusPiece[]): number {
  return pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);
}

/** Display width of a set of segments laid out in their zones. */
export function statusWidth(segments: StatusSegment[]): number {
  let width = 0;
  let rightCount = 0;
  for (const segment of segments) {
    const w = piecesWidth(segment.pieces);
    if (segment.zone === 'left') width += w;
    else if (segment.zone === 'center') width += displayWidth(CENTER_SEPARATOR) + w;
    else {
      width += w + (rightCount > 0 ? displayWidth(HINT_GAP) : 0);
      rightCount++;
    }
  }
  if (rightCount > 0) width += displayWidth(RIGHT_PREFIX);
  return width;
}

/**
 * Choose the segments to show in `columns`, keeping their original order.
 * Priority-0 segments are always kept; the rest are added cheapest-priority
 * first while one free column remains between the zones.
 */
export function planStatusBar(segments: StatusSegment[], columns: number): StatusSegment[] {
  const kept = new Set<StatusSegment>(segments.filter((s) => s.priority === 0));
  const optional = segments
    .map((segment, order) => ({ segment, order }))
    .filter(({ segment }) => segment.priority > 0)
    .sort((a, b) => a.segment.priority - b.segment.priority || a.order - b.order);
  for (const { segment } of optional) {
    kept.add(segment);
    const trial = segments.filter((s) => kept.has(s));
    if (statusWidth(trial) + 1 > columns) kept.delete(segment);
  }
  return segments.filter((s) => kept.has(s));
}

/** Truncate a status label to `max` columns. */
export function clipLabel(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = '';
  for (const ch of Array.from(text)) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + '…';
}
