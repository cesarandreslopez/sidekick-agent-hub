/**
 * Colors for the activity map's text layout in a terminal.
 *
 * The shared layout (`layoutActivityMapText`) hands back rows of segments
 * tagged with a tone; this module paints them three ways: as blessed tags for
 * the dashboard's tag parser (with braces escaped, since labels come from
 * data), as ANSI through chalk for plain output, and as Ink text props for the
 * live `map --follow` view.
 *
 * Named terminal colors (not the SVG palette's hex values) so the map follows
 * the terminal's own theme, light or dark.
 */

import type { ActivityStationId, ActivityTextSegment, ActivityTone } from 'sidekick-shared';
import { escapeBlessed } from '../dashboard/formatters';

/** One terminal color per station, for lit stations and route stops. */
export const STATION_TERMINAL_COLORS: Record<ActivityStationId, string> = {
  you: 'magentaBright',
  model: 'blueBright',
  memory: 'cyan',
  files: 'blue',
  shell: 'green',
  network: 'cyanBright',
  browser: 'yellow',
  agents: 'magenta',
  skills: 'yellowBright',
  hooks: 'white',
  plan: 'redBright',
};

export interface ToneStyle {
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

const TONE_STYLES: Record<ActivityTone, ToneStyle> = {
  default: {},
  muted: { color: 'gray' },
  dim: { color: 'gray', dim: true },
  accent: { color: 'magentaBright' },
  hot: { color: 'yellow', bold: true },
  fault: { color: 'red', bold: true },
  memory: { color: 'cyan' },
  ok: { color: 'green' },
};

/** How one segment is painted. Unknown tones paint as `default`. */
export function toneStyle(
  segment: Pick<ActivityTextSegment, 'tone' | 'bold' | 'station'>,
): ToneStyle {
  const base = TONE_STYLES[segment.tone] ?? TONE_STYLES.default;
  const color =
    segment.tone === 'accent' && segment.station
      ? STATION_TERMINAL_COLORS[segment.station]
      : base.color;
  return {
    ...(color ? { color } : {}),
    ...(base.bold || segment.bold ? { bold: true } : {}),
    ...(base.dim ? { dim: true } : {}),
  };
}

/** Blessed tag name for a terminal color (the dashboard parser maps `grey`). */
function blessedColor(color: string): string {
  return color === 'gray' ? 'grey' : color;
}

/** One row as a blessed-tagged string. Every segment's text is escaped. */
export function segmentsToBlessed(row: readonly ActivityTextSegment[]): string {
  let out = '';
  for (const segment of row) {
    if (!segment.text) continue;
    const style = toneStyle(segment);
    let text = escapeBlessed(segment.text);
    if (style.bold) text = `{bold}${text}{/bold}`;
    if (style.color) {
      const tag = `${blessedColor(style.color)}-fg`;
      text = `{${tag}}${text}{/${tag}}`;
    }
    out += text;
  }
  return out;
}

export function rowsToBlessed(rows: readonly (readonly ActivityTextSegment[])[]): string[] {
  return rows.map(segmentsToBlessed);
}

/** The subset of chalk this module uses, so tests can pass a stub. */
export interface ChalkLike {
  (text: string): string;
  [style: string]: unknown;
}

function chalkStyle(chalk: ChalkLike, name: string): ((text: string) => string) | null {
  const fn = (chalk as unknown as Record<string, unknown>)[name];
  return typeof fn === 'function' ? (fn as (text: string) => string) : null;
}

/** One row as ANSI text through `chalk` (which honors NO_COLOR and non-TTYs itself). */
export function segmentsToAnsi(row: readonly ActivityTextSegment[], chalk: ChalkLike): string {
  let out = '';
  for (const segment of row) {
    if (!segment.text) continue;
    const style = toneStyle(segment);
    let text = segment.text;
    if (style.color) text = chalkStyle(chalk, style.color)?.(text) ?? text;
    if (style.bold) text = chalkStyle(chalk, 'bold')?.(text) ?? text;
    if (style.dim) text = chalkStyle(chalk, 'dim')?.(text) ?? text;
    out += text;
  }
  return out;
}

export function rowsToAnsi(
  rows: readonly (readonly ActivityTextSegment[])[],
  chalk: ChalkLike,
): string[] {
  return rows.map((row) => segmentsToAnsi(row, chalk));
}

/** One row as plain text (no colors). */
export function segmentsToPlain(row: readonly ActivityTextSegment[]): string {
  return row.map((segment) => segment.text).join('');
}
