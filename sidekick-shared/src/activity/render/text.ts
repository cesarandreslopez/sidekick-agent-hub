/**
 * Lays the activity map out as rows of tone-tagged text for terminals.
 * The host colors and escapes the segments.
 *
 * `ring` places each station on a character ellipse around a boxed core
 * (core name, model, context bar), with the main loop's route on the last
 * row. `list` gives one row per station with a log-scaled bar, for narrow
 * or short areas. `auto` picks `ring` when the area is at least 64 × 15.
 *
 * Station marks: a spinner frame while a call runs (it turns with `now`),
 * `●` lit in the last few seconds, `○` used, `·` never used; then `✕n` for
 * faults since the last prompt and `×n` for calls at once.
 *
 * Pure and deterministic.
 *
 * @module activity/render/text
 */

import { ACTIVITY_STATIONS } from '../stations';
import type { ActivityStationId } from '../stations';
import { resolveActivityStrings } from '../strings';
import type { ActivityStrings } from '../strings';
import type {
  ActivitySnapshot,
  ActivityStationSnapshot,
  ActivityTextLayout,
  ActivityTextSegment,
  ActivityTone,
  LayoutActivityMapTextOptions,
} from '../types';
import { formatActivityDuration, resolveActivityCoreName, shortActivityModel } from './format';

const SPINNER = ['◐', '◓', '◑', '◒'];
const LIT_MS = 3200;
const ALARM_MS = 6000;
const N = ACTIVITY_STATIONS.length;

interface Cell {
  ch: string;
  tone: ActivityTone;
  bold?: boolean;
  station?: ActivityStationId;
}

type Measure = (text: string) => number;

function codePointWidth(text: string): number {
  return Array.from(text).length;
}

/** Cuts `text` so that `measure(text) <= max`, ending with `…` when cut. */
function fit(text: string, max: number, measure: Measure): string {
  if (max <= 0) return '';
  if (measure(text) <= max) return text;
  const chars = Array.from(text);
  let out = '';
  for (const ch of chars) {
    if (measure(`${out}${ch}…`) > max) break;
    out += ch;
  }
  return max >= 1 ? `${out}…` : out;
}

/** Merges neighbouring cells of one style into segments. */
function toSegments(cells: readonly Cell[]): ActivityTextSegment[] {
  const out: ActivityTextSegment[] = [];
  for (const cell of cells) {
    if (cell.ch === '') continue; // continuation of a wide character
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.tone === cell.tone &&
      (last.bold ?? false) === (cell.bold ?? false) &&
      last.station === cell.station
    ) {
      last.text += cell.ch;
    } else {
      out.push({
        text: cell.ch,
        tone: cell.tone,
        ...(cell.bold ? { bold: true } : {}),
        ...(cell.station ? { station: cell.station } : {}),
      });
    }
  }
  // Trailing spaces carry nothing.
  while (out.length > 0) {
    const last = out[out.length - 1];
    const trimmed = last.text.replace(/ +$/, '');
    if (trimmed === '') {
      out.pop();
      continue;
    }
    last.text = trimmed;
    break;
  }
  return out;
}

function segmentsWidth(row: readonly ActivityTextSegment[], measure: Measure): number {
  return row.reduce((sum, seg) => sum + measure(seg.text), 0);
}

/** Truncates a row to `width` visible columns. */
function clipRow(
  row: ActivityTextSegment[],
  width: number,
  measure: Measure,
): ActivityTextSegment[] {
  if (segmentsWidth(row, measure) <= width) return row;
  const out: ActivityTextSegment[] = [];
  let used = 0;
  for (const seg of row) {
    const room = width - used;
    if (room <= 0) break;
    const w = measure(seg.text);
    if (w <= room) {
      out.push(seg);
      used += w;
      continue;
    }
    out.push({ ...seg, text: fit(seg.text, room, measure) });
    break;
  }
  return out;
}

interface StationLook {
  mark: string;
  tone: ActivityTone;
  bold: boolean;
}

function lookOf(
  s: ActivityStationSnapshot,
  snapshot: ActivitySnapshot,
  now: number,
  dimmed: boolean,
): StationLook {
  const thinking =
    s.id === 'model' && snapshot.turn.working && snapshot.turn.thinkingSince !== undefined;
  const running = s.running > 0 || thinking;
  const lit = running || (s.lastAt !== undefined && now - s.lastAt >= 0 && now - s.lastAt < LIT_MS);
  const alarm =
    s.lastFaultAt !== undefined && now - s.lastFaultAt >= 0 && now - s.lastFaultAt < ALARM_MS;
  const mark = running
    ? SPINNER[Math.floor(Math.max(0, now) / 250) % SPINNER.length]
    : lit
      ? '●'
      : s.count > 0
        ? '○'
        : '·';
  if (dimmed) return { mark, tone: 'dim', bold: false };
  if (alarm) return { mark, tone: 'fault', bold: true };
  if (running) return { mark, tone: 'hot', bold: true };
  if (lit) return { mark, tone: s.id === 'memory' ? 'memory' : 'accent', bold: false };
  if (s.count > 0) return { mark, tone: s.id === 'memory' ? 'memory' : 'default', bold: false };
  return { mark, tone: 'dim', bold: false };
}

function stationParts(
  s: ActivityStationSnapshot,
  look: StationLook,
  strings: ActivityStrings,
  compact: boolean,
): Array<{ text: string; tone: ActivityTone; bold?: boolean }> {
  const parts: Array<{ text: string; tone: ActivityTone; bold?: boolean }> = [
    { text: `${look.mark} `, tone: look.tone, bold: look.bold },
    {
      text: strings.stations[s.id],
      tone: look.tone === 'dim' ? 'dim' : look.tone,
      bold: look.bold,
    },
  ];
  if (s.count > 0) {
    const pushed = s.id === 'memory' ? Math.min(s.count, s.pushed ?? 0) : 0;
    if (s.count - pushed > 0) parts.push({ text: ` ${s.count - pushed}`, tone: 'muted' });
    if (pushed > 0) parts.push({ text: ` ↓${pushed}`, tone: 'memory' });
  }
  if (s.faults > 0) parts.push({ text: ` ✕${s.faults}`, tone: 'fault', bold: true });
  if (s.running > 1 && !compact) parts.push({ text: ` ×${s.running}`, tone: 'hot' });
  return parts;
}

function contextBar(
  snapshot: ActivitySnapshot,
  width: number,
): Array<{ text: string; tone: ActivityTone }> {
  if (snapshot.context === undefined) return [];
  const pct = Math.max(0, Math.min(100, snapshot.context.percent));
  const tone: ActivityTone = pct >= 90 ? 'fault' : pct >= 70 ? 'hot' : 'accent';
  const label = ` ${Math.round(pct)}%`;
  const cells = Math.max(3, width - label.length);
  const filled = Math.round((pct / 100) * cells);
  return [
    { text: '█'.repeat(filled), tone },
    { text: '░'.repeat(cells - filled), tone: 'dim' },
    { text: label, tone: 'muted' },
  ];
}

function routeRow(snapshot: ActivitySnapshot, strings: ActivityStrings): ActivityTextSegment[] {
  if (snapshot.route.length < 2) return [];
  const row: ActivityTextSegment[] = [{ text: '↝ ', tone: 'dim' }];
  snapshot.route.forEach((stop, i) => {
    if (i > 0) row.push({ text: ' → ', tone: 'dim' });
    row.push({
      text: strings.stations[stop.station],
      tone: i === snapshot.route.length - 1 ? 'accent' : 'muted',
      station: stop.station,
    });
  });
  return row;
}

function layoutList(
  snapshot: ActivitySnapshot,
  stations: ActivityStationSnapshot[],
  opts: Resolved,
): ActivityTextLayout {
  const { strings, measure, width, now } = opts;
  const rows: ActivityTextSegment[][] = [];
  const header: ActivityTextSegment[] = [{ text: opts.coreName, tone: 'accent', bold: true }];
  if (snapshot.model)
    header.push({ text: ` ${opts.modelLabel(snapshot.model.id)}`, tone: 'muted' });
  const bar = contextBar(
    snapshot,
    Math.min(16, Math.max(6, width - measure(header.map((s) => s.text).join('')) - 3)),
  );
  if (bar.length > 0) header.push({ text: '  ', tone: 'default' }, ...bar);
  rows.push(header);

  const nameWidth = Math.max(...stations.map((s) => measure(strings.stations[s.id])));
  const maxCount = Math.max(1, ...stations.map((s) => s.count));
  const barWidth = Math.max(0, Math.min(12, width - nameWidth - 18));
  for (const s of stations) {
    const look = lookOf(s, snapshot, now, opts.dimmed(s.id));
    const name = strings.stations[s.id];
    const row: ActivityTextSegment[] = [
      {
        text: `${look.mark} `,
        tone: look.tone,
        ...(look.bold ? { bold: true } : {}),
        station: s.id,
      },
      {
        text: name + ' '.repeat(Math.max(0, nameWidth - measure(name))),
        tone: look.tone,
        ...(look.bold ? { bold: true } : {}),
        station: s.id,
      },
    ];
    if (barWidth > 0) {
      const filled =
        s.count === 0
          ? 0
          : Math.max(1, Math.round((Math.log2(1 + s.count) / Math.log2(1 + maxCount)) * barWidth));
      row.push({ text: ' ', tone: 'default' });
      if (filled > 0)
        row.push({
          text: '▮'.repeat(filled),
          tone: look.tone === 'dim' ? 'dim' : s.id === 'memory' ? 'memory' : 'accent',
          station: s.id,
        });
      if (barWidth - filled > 0) row.push({ text: '·'.repeat(barWidth - filled), tone: 'dim' });
    }
    const pushed = s.id === 'memory' ? Math.min(s.count, s.pushed ?? 0) : 0;
    row.push({
      text: ` ${String(s.count - pushed).padStart(4)}`,
      tone: s.count > 0 ? 'default' : 'dim',
    });
    if (pushed > 0) row.push({ text: ` ↓${pushed}`, tone: 'memory' });
    if (s.faults > 0) row.push({ text: ` ✕${s.faults}`, tone: 'fault', bold: true });
    if (s.running > 1) row.push({ text: ` ×${s.running}`, tone: 'hot' });
    if (s.running > 0 && s.runningSince !== undefined) {
      row.push({ text: ` ${formatActivityDuration(now - s.runningSince)}`, tone: 'hot' });
    }
    rows.push(row);
  }
  const route = routeRow(snapshot, strings);
  if (route.length > 0) rows.push(route);
  return finish('list', rows, opts);
}

function finish(
  mode: 'ring' | 'list',
  rows: ActivityTextSegment[][],
  opts: Resolved,
): ActivityTextLayout {
  const limited = opts.height !== undefined ? rows.slice(0, Math.max(0, opts.height)) : rows;
  return {
    mode,
    width: opts.width,
    rows: limited.map((row) => clipRow(row, opts.width, opts.measure)),
  };
}

function layoutRing(
  snapshot: ActivitySnapshot,
  stations: ActivityStationSnapshot[],
  opts: Resolved,
): ActivityTextLayout {
  const { width, strings, measure, now } = opts;
  const route = routeRow(snapshot, strings);
  const height = Math.max(15, opts.height ?? 17);
  const mapRows = route.length > 0 ? height - 1 : height;
  const grid: Cell[][] = Array.from({ length: mapRows }, () =>
    Array.from({ length: width }, () => ({ ch: ' ', tone: 'default' as ActivityTone })),
  );

  const put = (
    row: number,
    col: number,
    text: string,
    tone: ActivityTone,
    bold?: boolean,
    station?: ActivityStationId,
  ): number => {
    let c = col;
    for (const ch of Array.from(text)) {
      const w = Math.max(1, measure(ch));
      if (row < 0 || row >= mapRows || c < 0 || c + w > width) return c;
      grid[row][c] = { ch, tone, ...(bold ? { bold: true } : {}), ...(station ? { station } : {}) };
      for (let k = 1; k < w; k++) grid[row][c + k] = { ch: '', tone };
      c += w;
    }
    return c;
  };
  const free = (row: number, col: number, w: number): boolean => {
    if (row < 0 || row >= mapRows || col < 0 || col + w > width) return false;
    for (let c = Math.max(0, col - 1); c < Math.min(width, col + w + 1); c++) {
      if (grid[row][c].ch !== ' ') return false;
    }
    return true;
  };

  // The core box.
  const cx = Math.floor(width / 2);
  const cy = Math.floor(mapRows / 2);
  const inner = Math.min(20, Math.max(12, Math.floor(width * 0.26)));
  const coreLines: Array<Array<{ text: string; tone: ActivityTone; bold?: boolean }>> = [
    [{ text: fit(opts.coreName, inner, measure), tone: 'accent', bold: true }],
  ];
  if (snapshot.model) {
    const extra = snapshot.compactions > 0 ? ` ⟲${snapshot.compactions}` : '';
    coreLines.push([
      { text: fit(`${opts.modelLabel(snapshot.model.id)}${extra}`, inner, measure), tone: 'muted' },
    ]);
  }
  const bar = contextBar(snapshot, inner);
  if (bar.length > 0) coreLines.push(bar);
  const boxTop = cy - Math.ceil(coreLines.length / 2) - 1;
  const left = cx - Math.floor(inner / 2) - 2;
  const horizontal = '─'.repeat(inner + 2);
  put(boxTop, left, `╭${horizontal}╮`, 'dim');
  coreLines.forEach((line, i) => {
    const text = line.map((p) => p.text).join('');
    const pad = Math.max(0, inner - measure(text));
    let c = put(boxTop + 1 + i, left, '│ ', 'dim');
    c = put(boxTop + 1 + i, c, ' '.repeat(Math.floor(pad / 2)), 'default');
    for (const part of line) c = put(boxTop + 1 + i, c, part.text, part.tone, part.bold);
    c = put(boxTop + 1 + i, c, ' '.repeat(pad - Math.floor(pad / 2)), 'default');
    put(boxTop + 1 + i, c, ' │', 'dim');
  });
  put(boxTop + coreLines.length + 1, left, `╰${horizontal}╯`, 'dim');

  // Stations on the ellipse; a crowded spot moves a row toward the middle.
  const shift = opts.layout === 'you-bottom' ? N / 2 : 0;
  const rx = Math.max(10, Math.floor(width / 2) - 9);
  const ry = Math.max(4, (mapRows - 1) / 2);
  stations.forEach((s, i) => {
    const look = lookOf(s, snapshot, now, opts.dimmed(s.id));
    const parts = stationParts(s, look, strings, width < 72);
    const text = parts.map((p) => p.text).join('');
    const w = measure(text);
    const angle = ((i + shift) * 2 * Math.PI) / N;
    const x = cx + rx * Math.sin(angle);
    const y = Math.round(cy - ry * Math.cos(angle));
    let col = Math.round(x - w / 2);
    col = Math.max(0, Math.min(width - w, col));
    const toward = y < cy ? 1 : -1;
    for (const dy of [0, toward, -toward, 2 * toward]) {
      if (free(y + dy, col, w)) {
        let c = col;
        for (const part of parts) c = put(y + dy, c, part.text, part.tone, part.bold, s.id);
        return;
      }
    }
  });

  const rows = grid.map(toSegments);
  if (route.length > 0) rows.push(route);
  return finish('ring', rows, opts);
}

interface Resolved {
  now: number;
  width: number;
  height?: number;
  layout?: LayoutActivityMapTextOptions['layout'];
  strings: ActivityStrings;
  measure: Measure;
  coreName: string;
  modelLabel: (id: string) => string;
  dimmed: (station: ActivityStationId) => boolean;
}

export function layoutActivityMapText(
  snapshot: ActivitySnapshot,
  options: LayoutActivityMapTextOptions,
): ActivityTextLayout {
  const width = Math.max(1, Math.floor(options.width));
  const height = options.height === undefined ? undefined : Math.max(0, Math.floor(options.height));
  const highlight = new Set<ActivityStationId>(
    options.highlight === undefined
      ? []
      : typeof options.highlight === 'string'
        ? [options.highlight]
        : options.highlight,
  );
  const resolved: Resolved = {
    now: options.now,
    width,
    height,
    layout: options.layout,
    strings: resolveActivityStrings(options.strings),
    measure: options.measure ?? codePointWidth,
    coreName: resolveActivityCoreName(options.coreName, snapshot.providerId),
    modelLabel: options.modelLabel ?? shortActivityModel,
    dimmed: (station) => highlight.size > 0 && !highlight.has(station),
  };
  const byId = new Map(snapshot.stations.map((s) => [s.id, s]));
  const stations = ACTIVITY_STATIONS.map(
    (id) => byId.get(id) ?? { id, count: 0, running: 0, faults: 0 },
  );
  const mode =
    options.mode === 'ring' || options.mode === 'list'
      ? options.mode
      : width >= 64 && (height === undefined || height >= 15)
        ? 'ring'
        : 'list';
  return mode === 'ring' && width >= 40
    ? layoutRing(snapshot, stations, resolved)
    : layoutList(snapshot, stations, resolved);
}
