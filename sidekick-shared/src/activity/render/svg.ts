/**
 * Draws the activity map as one self-contained SVG string.
 *
 * The agent is a hexagonal core in the middle, wearing a segmented ring that
 * fills with its context window. The eleven stations sit on a ring around
 * it. A call sends a pulse from the core (or from the Agents station, for a
 * subagent's call) out along the station's spoke, and a smaller one back
 * when it ends; red when it failed or was denied. Spokes wear in with use,
 * an arc around each station shows its share of the session's calls, and a
 * thin route joins the last stations the main loop went through.
 *
 * Timing never depends on when the SVG is drawn: every animation starts at
 * `(eventTime + delay − now) / speed` seconds on the document timeline (a
 * negative `begin`), so a redraw continues each flight where the last frame
 * left it. One-shot animations that have already finished are left out, or
 * drawn in their end state; rhythms shared by the whole map (the core's
 * breath, subagent orbits) start at `−(now mod period)` so every redraw
 * lands on the same phase. `motion: 'none'` emits no `<animate>` at all and
 * draws each moving thing where it is at `now`.
 *
 * Pure and deterministic: the same snapshot and options give the same bytes.
 *
 * @module activity/render/svg
 */

import {
  describeActivityInsights,
  describeActivityNow,
  describeActivityPattern,
} from '../describe';
import { ACTIVITY_STATIONS } from '../stations';
import type { ActivityStationId } from '../stations';
import { resolveActivityStrings } from '../strings';
import type { ActivityStrings } from '../strings';
import type {
  ActivityEntry,
  ActivityMotion,
  ActivityPalette,
  ActivitySnapshot,
  ActivityStationSnapshot,
  ActivityTheme,
  RenderActivityMapSvgOptions,
} from '../types';
import { escapeActivityXml, resolveActivityCoreName, shortActivityModel } from './format';
import {
  ACTIVITY_DARK_PALETTE,
  ACTIVITY_LIGHT_PALETTE,
  activityLightOverrideRules,
  activityMapStyles,
  mergeActivityPalette,
  paletteColor,
} from './palette';
import type { ActivityPaintKey } from './palette';

// ── Geometry ────────────────────────────────────────────────────────────

const W = 480;
const H = 460;
const CX = 240;
const CY = 228;
const RX = 182;
const RY = 166;
const NODE = 20;
const CORE = 42;
/** Where spokes and pulses meet the core: outside the context ring. */
const HUB = CORE + 11;
const N = ACTIVITY_STATIONS.length;

// ── Timing (ms) ─────────────────────────────────────────────────────────

const PULSE_MS = 800;
const RIPPLE_MS = 450;
const BEAM_MS = 1600;
const GLOW_MS = 3200;
const ALARM_MS = 6000;
const SWITCH_MS = 8000;
const SWITCH_LAP_MS = 1600;
const DONE_MS = 1100;
const COMPACT_MS = 1600;
const LEG_MS = 500;
const BEAT_MS = 1400;
const ORBIT_MS = 7000;
const MAX_FLIGHTS = 14;
const MAX_ORBITERS = 6;
const CONTEXT_SEGMENTS = 24;

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

interface Point {
  x: number;
  y: number;
}

/** One decimal, never `-0`. */
function n1(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded === 0 ? 0 : rounded);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function edge(from: Point, to: Point, r: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d };
}

/** The same segment moved sideways by `off`, so concurrent pulses fly side by side. */
function aside(a: Point, b: Point, off: number): [Point, Point] {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dx = (-(b.y - a.y) * off) / d;
  const dy = ((b.x - a.x) * off) / d;
  return [
    { x: a.x + dx, y: a.y + dy },
    { x: b.x + dx, y: b.y + dy },
  ];
}

function ringPath(x: number, y: number, r: number): string {
  return `M${n1(x - r)} ${n1(y)}a${r} ${r} 0 1 0 ${n1(2 * r)} 0a${r} ${r} 0 1 0 ${n1(-2 * r)} 0`;
}

/** Station glyphs, drawn in a 16×16 box around the origin with round strokes. */
const ICONS: Record<ActivityStationId, string> = {
  you: `${ringPath(0, -3.4, 3.2)}M-6 7c0-3.8 2.7-5.8 6-5.8s6 2 6 5.8`,
  model: 'M0-7.2C.9-2.4 2.4-.9 7.2 0 2.4.9.9 2.4 0 7.2-.9 2.4-2.4.9-7.2 0-2.4-.9-.9-2.4 0-7.2Z',
  memory:
    'M-6-4.4a6 2.3 0 1 0 12 0a6 2.3 0 1 0-12 0M-6-4.4v8.8a6 2.3 0 0 0 12 0v-8.8M-6 0a6 2.3 0 0 0 12 0',
  files: 'M-5-7.2h6.2l3.8 3.8v10.6h-10ZM1.2-7.2v3.8h3.8M-2.5 1h5M-2.5 3.8h5',
  shell: 'M-6.5-4.6l4.2 4.2-4.2 4.2M.4 5h6.2',
  network: `${ringPath(0, 0, 7)}M-7 0h14M0-7c-3.4 3.4-3.4 10.6 0 14M0-7c3.4 3.4 3.4 10.6 0 14`,
  browser: 'M-7.4-6h14.8v12h-14.8ZM-7.4-2.6h14.8M-5.2-4.3h.1M-3-4.3h.1',
  agents: `M0-3.4v3M0-.4l-4.6 3.6M0-.4l4.6 3.6${ringPath(0, -5.4, 2)}${ringPath(-5.4, 4.6, 2)}${ringPath(5.4, 4.6, 2)}`,
  skills: 'M1.6-7.6L-4.8 1.2h4.4L-1.8 7.6 4.8-1.2H.4Z',
  hooks: `M2.4-4.4v6.2a3.9 3.9 0 1 1-7.8 0v-1.4${ringPath(2.4, -6.3, 1.9)}`,
  plan: 'M-6.6-5.2l1.4 1.4 2.4-2.8M-.6-4.6h6.8M-6.6.8l1.4 1.4 2.4-2.8M-.6 1.4h6.8M-.6 6h6.8M-6.2 6h2.6',
};

// ── Painting ────────────────────────────────────────────────────────────

type Paint = ActivityPaintKey | 'none';

interface Painter {
  /** Attributes that set the fill and stroke of an element. */
  (fill: Paint | undefined, stroke?: Paint): string;
  readonly styles: string;
}

function makePainter(
  theme: ActivityTheme,
  dark: ActivityPalette,
  light: ActivityPalette,
  prefix: string,
  embedStyles: boolean,
): Painter {
  const base = theme === 'light' ? light : dark;
  const attr = (name: string, key: Paint | undefined): string =>
    key === undefined ? '' : ` ${name}="${key === 'none' ? 'none' : paletteColor(base, key)}"`;
  const painter = ((fill: Paint | undefined, stroke?: Paint): string => {
    if (theme === 'dark' || theme === 'light') return attr('fill', fill) + attr('stroke', stroke);
    const classes: string[] = [];
    if (fill !== undefined && fill !== 'none') classes.push(`${prefix}-f-${fill}`);
    if (stroke !== undefined && stroke !== 'none') classes.push(`${prefix}-s-${stroke}`);
    const none =
      (fill === 'none' ? ' fill="none"' : '') + (stroke === 'none' ? ' stroke="none"' : '');
    const cls = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
    // `auto` keeps dark presentation attributes; its light rules are classes.
    return theme === 'auto' ? attr('fill', fill) + attr('stroke', stroke) + cls : cls + none;
  }) as Painter;
  let styles = '';
  if (theme === 'auto') {
    styles = `<style>@media (prefers-color-scheme: light){${activityLightOverrideRules(prefix, light)}}</style>`;
  } else if (theme === 'css-vars' && embedStyles) {
    styles = `<style>${activityMapStyles({ classPrefix: prefix, palette: dark })}</style>`;
  }
  Object.defineProperty(painter, 'styles', { value: styles });
  return painter;
}

// ── Animation ───────────────────────────────────────────────────────────

interface Clock {
  now: number;
  speed: number;
  offsetMs: number;
  motion: ActivityMotion;
}

/** `begin` of an animation meant to start at `startAt` (document seconds). */
function beginAt(clock: Clock, startAt: number): string {
  return secs(clock.offsetMs / 1000 + (startAt - clock.now) / clock.speed / 1000);
}

function secs(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return `${(rounded === 0 ? 0 : rounded).toFixed(3)}s`;
}

function durOf(clock: Clock, ms: number): string {
  return secs(ms / clock.speed / 1000);
}

interface Track {
  attr: string;
  values: readonly number[];
  keyTimes?: readonly number[];
}

/** Value of a `values`/`keyTimes` track at progress `p` (0–1), linear between keys. */
function valueAt(track: Track, p: number): number {
  const { values } = track;
  if (values.length === 1) return values[0];
  const times = track.keyTimes ?? values.map((_, i) => i / (values.length - 1));
  for (let i = 1; i < values.length; i++) {
    if (p <= times[i]) {
      const span = times[i] - times[i - 1] || 1;
      return values[i - 1] + ((values[i] - values[i - 1]) * (p - times[i - 1])) / span;
    }
  }
  return values[values.length - 1];
}

function fmtValue(attr: string, value: number): string {
  return attr === 'opacity' ? String(Math.round(clamp(value, 0, 1) * 100) / 100) : n1(value);
}

function trackAnimate(track: Track, timing: string): string {
  const values = track.values.map((v) => fmtValue(track.attr, v)).join(';');
  const keyTimes = track.keyTimes ? ` keyTimes="${track.keyTimes.join(';')}"` : '';
  return `<animate attributeName="${track.attr}" values="${values}"${keyTimes} ${timing}/>`;
}

interface OneShot {
  tag: 'circle' | 'line' | 'path';
  /** Static attributes (no animated ones). */
  attrs: string;
  startAt: number;
  durMs: number;
  tracks: readonly Track[];
  /** A flight from `from` to `to`; the element is positioned by `cx`/`cy` when static. */
  flight?: { from: Point; to: Point };
}

/**
 * A one-shot animation: SMIL in `full`, opacity only (at the destination) in
 * `reduced`, the frame at `now` in `none`. Nothing once it has ended, since
 * every one-shot here fades out.
 */
function oneShot(clock: Clock, shot: OneShot): string {
  const elapsed = clock.now - shot.startAt;
  if (elapsed >= shot.durMs) return '';
  const position = (p: number): string => {
    if (!shot.flight) return '';
    const { from, to } = shot.flight;
    return ` cx="${n1(from.x + (to.x - from.x) * p)}" cy="${n1(from.y + (to.y - from.y) * p)}"`;
  };
  if (clock.motion === 'none') {
    if (elapsed < 0) return '';
    const p = elapsed / shot.durMs;
    const animated = shot.tracks
      .map((t) => ` ${t.attr}="${fmtValue(t.attr, valueAt(t, p))}"`)
      .join('');
    return `<${shot.tag}${shot.attrs}${position(p)}${animated}/>`;
  }
  const timing = `begin="${beginAt(clock, shot.startAt)}" dur="${durOf(clock, shot.durMs)}" fill="freeze"`;
  // Before `begin` an element shows its base attributes: keep it invisible.
  const bases = shot.tracks
    .filter((t) => t.attr !== 'opacity')
    .map((t) => ` ${t.attr}="${fmtValue(t.attr, t.values[0])}"`)
    .join('');
  if (clock.motion === 'reduced') {
    // Opacity fades only: no flight, no growth.
    const opacity = shot.tracks.find((t) => t.attr === 'opacity');
    const place = shot.flight ? position(1) : '';
    if (opacity === undefined) return `<${shot.tag}${shot.attrs}${place}${bases}/>`;
    return `<${shot.tag}${shot.attrs}${place}${bases} opacity="0">${trackAnimate(opacity, timing)}</${shot.tag}>`;
  }
  let children = shot.tracks.map((t) => trackAnimate(t, timing)).join('');
  if (shot.flight) {
    const { from, to } = shot.flight;
    children =
      `<animateMotion path="M${n1(from.x)} ${n1(from.y)}L${n1(to.x)} ${n1(to.y)}" ${timing}/>` +
      children;
  }
  return `<${shot.tag}${shot.attrs}${bases} opacity="0">${children}</${shot.tag}>`;
}

/** Phase (0–1) of a repeating rhythm of `periodMs` that started at `origin`. */
function phase(clock: Clock, origin: number, periodMs: number): number {
  const elapsed = clock.now - origin;
  return (((elapsed % periodMs) + periodMs) % periodMs) / periodMs;
}

function repeatBegin(clock: Clock, origin: number, periodMs: number): string {
  return secs(
    clock.offsetMs / 1000 - (phase(clock, origin, periodMs) * periodMs) / clock.speed / 1000,
  );
}

// ── Scene ───────────────────────────────────────────────────────────────

interface Scene {
  snapshot: ActivitySnapshot;
  clock: Clock;
  paint: Painter;
  strings: ActivityStrings;
  shift: number;
  dimmed: (station: ActivityStationId) => boolean;
  stationIndex: Map<ActivityStationId, number>;
  totalCalls: number;
}

function angleOf(scene: Scene, index: number): number {
  return ((index + scene.shift) * 2 * Math.PI) / N;
}

function at(angle: number, f = 1): Point {
  return { x: CX + RX * f * Math.sin(angle), y: CY - RY * f * Math.cos(angle) };
}

function placeOf(scene: Scene, station: ActivityStationId): Point {
  return at(angleOf(scene, scene.stationIndex.get(station) ?? 0));
}

const CORE_POINT: Point = { x: CX, y: CY };

/** Bend of a route leg, by how many stations apart its ends are. */
const BEND = [0.5, 0.5, 0.44, 0.47, 0.56, 0.7];

function leg(scene: Scene, from: ActivityStationId, to: ActivityStationId) {
  const i = scene.stationIndex.get(from) ?? 0;
  const j = scene.stationIndex.get(to) ?? 0;
  let steps = (((j - i) % N) + N) % N;
  if (steps > N / 2) steps -= N;
  const bend = at(angleOf(scene, i + steps / 2), BEND[Math.abs(steps)] ?? 0.5);
  const a = edge(placeOf(scene, from), bend, NODE + 5);
  const b = edge(placeOf(scene, to), bend, NODE + 5);
  return {
    path: `M${n1(a.x)} ${n1(a.y)}Q${n1(bend.x)} ${n1(bend.y)} ${n1(b.x)} ${n1(b.y)}`,
    mid: { x: (a.x + 2 * bend.x + b.x) / 4, y: (a.y + 2 * bend.y + b.y) / 4 },
    end: b,
  };
}

function hueOf(station: ActivityStationId): ActivityPaintKey {
  return `st-${station}`;
}

function isBad(entry: ActivityEntry): boolean {
  return entry.outcome === 'error' || entry.outcome === 'denied';
}

function wrapDim(scene: Scene, station: ActivityStationId, body: string): string {
  return body === '' ? '' : scene.dimmed(station) ? `<g opacity=".28">${body}</g>` : body;
}

// ── Pieces ──────────────────────────────────────────────────────────────

function background(scene: Scene): string {
  const { paint } = scene;
  let out = `<rect width="${W}" height="${H}" rx="16"${paint('ground')}/>`;
  // A faint dial: the station orbit and an inner ring.
  out += `<ellipse cx="${CX}" cy="${CY}" rx="${RX}" ry="${RY}"${paint('none', 'line')} stroke-width=".8" stroke-dasharray="1 7" stroke-linecap="round" opacity=".7"/>`;
  out += `<ellipse cx="${CX}" cy="${CY}" rx="${n1(RX * 0.56)}" ry="${n1(RY * 0.56)}"${paint('none', 'line')} stroke-width=".6" opacity=".35"/>`;
  return out;
}

function spokes(scene: Scene): string {
  const { snapshot, paint } = scene;
  let out = '';
  const maxCount = Math.max(1, ...snapshot.stations.map((s) => s.count));
  for (const s of snapshot.stations) {
    const p = placeOf(scene, s.id);
    const a = edge(CORE_POINT, p, HUB);
    const b = edge(p, CORE_POINT, NODE + 1);
    const worn =
      s.count > 0 ? clamp(Math.log2(1 + s.count) / Math.log2(1 + Math.max(maxCount, 64)), 0, 1) : 0;
    const line = `<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke-linecap="round"`;
    let body = `${line}${paint(undefined, 'spoke')} stroke-width="${n1(1.1 + 2.8 * worn)}"/>`;
    if (worn > 0) {
      body += `${line}${paint(undefined, hueOf(s.id))} stroke-width="${n1(1.1 + 2.8 * worn)}" opacity="${n1(0.12 + worn * 0.48)}"/>`;
    }
    out += wrapDim(scene, s.id, body);
  }
  return out;
}

function trail(scene: Scene): string {
  const { snapshot, clock, paint } = scene;
  const stops = snapshot.route;
  let out = '';
  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1];
    const to = stops[k];
    if (from.station === to.station) continue;
    const { path, end } = leg(scene, from.station, to.station);
    const isHead = k === stops.length - 1;
    const opacity = n1(0.14 + (0.5 * k) / Math.max(1, stops.length - 1));
    const base = `<path d="${path}"${paint('none', 'text')} stroke-width="${isHead ? 1.6 : 1.1}" stroke-linecap="round" opacity="${opacity}"`;
    const elapsed = clock.now - to.at;
    if (isHead && elapsed < LEG_MS && clock.motion !== 'reduced') {
      if (clock.motion === 'none') {
        const left = elapsed < 0 ? 1 : 1 - elapsed / LEG_MS;
        out += `${base} pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="${n1(left)}"/>`;
      } else {
        out += `${base} pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" values="1;0" begin="${beginAt(clock, to.at)}" dur="${durOf(clock, LEG_MS)}" fill="freeze"/></path>`;
      }
    } else {
      out += `${base}/>`;
    }
    if (isHead) {
      const dotAt = to.at + 400;
      const dot = `<circle cx="${n1(end.x)}" cy="${n1(end.y)}" r="2.5"${paint('text')}`;
      if (clock.now - dotAt >= 150 || clock.motion === 'reduced') {
        out += `${dot} opacity=".85"/>`;
      } else if (clock.motion === 'none') {
        if (clock.now >= dotAt)
          out += `${dot} opacity="${n1(((clock.now - dotAt) / 150) * 0.85)}"/>`;
      } else {
        out += `${dot} opacity="0"><animate attributeName="opacity" values="0;.85" begin="${beginAt(clock, dotAt)}" dur="${durOf(clock, 150)}" fill="freeze"/></circle>`;
      }
    }
  }
  return out;
}

/** Retry streaks glow on their station; A↔B loops draw a double arc between the two. */
function patterns(scene: Scene): { under: string; over: string } {
  const { snapshot, paint } = scene;
  let under = '';
  let over = '';
  for (const pattern of snapshot.patterns) {
    if (pattern.state !== 'open') continue;
    if (pattern.kind === 'retry-streak') {
      const p = placeOf(scene, pattern.station);
      over += wrapDim(
        scene,
        pattern.station,
        `<g data-pattern="retry-streak" data-station="${pattern.station}"><title>${escapeActivityXml(describeActivityPattern(pattern, scene.strings))}</title>` +
          `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${NODE + 12}"${paint('none', 'fault')} stroke-width="1.2" stroke-dasharray="2.5 3.5" opacity=".85"/>` +
          `<text x="${n1(p.x + NODE + 6)}" y="${n1(p.y + NODE + 4)}" font-size="9" font-weight="700" paint-order="stroke" stroke-width="3.5" stroke-linejoin="round"${paint('fault', 'ground')}>↻${pattern.failures}</text></g>`,
      );
    } else {
      const [a, b] = pattern.stations;
      const { path, mid } = leg(scene, a, b);
      const title = escapeActivityXml(describeActivityPattern(pattern, scene.strings));
      const glyph = `${pattern.flavor === 'edit-test' ? '⇄' : '↔'}×${pattern.cycles}`;
      under +=
        `<g data-pattern="alternation" data-stations="${a} ${b}">` +
        `<path d="${path}"${paint('none', hueOf(a))} stroke-width="2.2" stroke-dasharray="5 4" opacity=".75" transform="translate(-2 -2)"/>` +
        `<path d="${path}"${paint('none', hueOf(b))} stroke-width="2.2" stroke-dasharray="5 4" opacity=".75" transform="translate(2 2)"/></g>`;
      over +=
        `<g data-pattern="alternation" data-stations="${a} ${b}"><title>${title}</title>` +
        `<rect x="${n1(mid.x - 16)}" y="${n1(mid.y - 7)}" width="32" height="14" rx="7"${paint('raised', hueOf(a))} stroke-width="1"/>` +
        `<text x="${n1(mid.x)}" y="${n1(mid.y + 3)}" text-anchor="middle" font-size="9" font-weight="700"${paint('text')}>${glyph}</text></g>`;
    }
  }
  return { under, over };
}

function clockHands(scene: Scene, p: Point, since: number, hue: ActivityPaintKey): string {
  const { clock, paint } = scene;
  const elapsed = Math.max(0, clock.now - since);
  const hand = (r: number, width: number, lapMs: number, once: boolean): string => {
    const base = `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${r}"${paint('none', hue)} stroke-width="${width}" stroke-linecap="round" pathLength="1" stroke-dasharray="1 1" transform="rotate(-90 ${n1(p.x)} ${n1(p.y)})"`;
    const progress = once ? Math.min(elapsed, lapMs) / lapMs : (elapsed % lapMs) / lapMs;
    if (clock.motion !== 'full' || (once && elapsed >= lapMs)) {
      return `${base} stroke-dashoffset="${(1 - progress).toFixed(3)}"/>`;
    }
    const timing = once
      ? `begin="${secs(clock.offsetMs / 1000 - Math.min(elapsed, lapMs) / clock.speed / 1000)}" dur="${durOf(clock, lapMs)}" fill="freeze"`
      : `begin="${repeatBegin(clock, since, lapMs)}" dur="${durOf(clock, lapMs)}" repeatCount="indefinite"`;
    return `${base} stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" values="1;0" ${timing}/></circle>`;
  };
  return hand(NODE + 4.5, 2.1, 60_000, false) + hand(NODE + 8.5, 1.2, 600_000, true);
}

function beat(scene: Scene, p: Point, since: number, hue: ActivityPaintKey): string {
  const { clock, paint } = scene;
  const base = `<circle cx="${n1(p.x)}" cy="${n1(p.y)}"${paint('none', hue)} stroke-width="1.3"`;
  if (clock.motion === 'full') {
    const timing = `begin="${repeatBegin(clock, since, BEAT_MS)}" dur="${durOf(clock, BEAT_MS)}" repeatCount="indefinite"`;
    return `${base} r="${NODE}" opacity="0"><animate attributeName="r" values="${NODE};${NODE + 14}" ${timing}/><animate attributeName="opacity" values=".9;0" ${timing}/></circle>`;
  }
  if (clock.motion === 'reduced') return '';
  const ph = phase(clock, since, BEAT_MS);
  return `${base} r="${n1(NODE + 14 * ph)}" opacity="${n1(0.9 * (1 - ph))}"/>`;
}

interface StationDraw {
  under: string;
  over: string;
}

function station(scene: Scene, s: ActivityStationSnapshot): StationDraw {
  const { snapshot, clock, paint, strings } = scene;
  const p = placeOf(scene, s.id);
  const x = n1(p.x);
  const y = n1(p.y);
  const hue = hueOf(s.id);
  const thinking =
    s.id === 'model' && snapshot.turn.working && snapshot.turn.thinkingSince !== undefined;
  const runningSince =
    s.running > 0 ? s.runningSince : thinking ? snapshot.turn.thinkingSince : undefined;
  const isRunning = runningSince !== undefined;
  const since = s.lastAt === undefined ? Infinity : clock.now - s.lastAt;
  const alarmAge = s.lastFaultAt === undefined ? Infinity : clock.now - s.lastFaultAt;
  const isAlarm = alarmAge >= 0 && alarmAge < ALARM_MS;
  const isLit = isRunning || (since >= 0 && since < GLOW_MS);
  const ring: ActivityPaintKey = isAlarm ? 'fault' : hue;
  const fadeFrom = isAlarm ? (s.lastFaultAt as number) : (s.lastAt ?? clock.now);
  const span = isAlarm ? ALARM_MS : GLOW_MS;

  let under = '';
  if (isRunning && !isAlarm) {
    under += `<circle cx="${x}" cy="${y}" r="${NODE + 9}"${paint(ring)} opacity=".16"/>`;
  } else if (isLit || isAlarm) {
    under += oneShot(clock, {
      tag: 'circle',
      attrs: ` cx="${x}" cy="${y}" r="${NODE + 9}"${paint(ring)}`,
      startAt: fadeFrom,
      durMs: span,
      tracks: [{ attr: 'opacity', values: [0.3, 0] }],
    });
  }
  if (isRunning) {
    under += beat(scene, p, runningSince as number, ring);
    under += clockHands(scene, p, runningSince as number, isAlarm ? 'fault' : hue);
  }

  // Share of the session's calls, as an arc hugging the node.
  let over = `<circle cx="${x}" cy="${y}" r="${NODE}"${paint('raised', 'line')} stroke-width="1.2"/>`;
  if (s.count > 0 && scene.totalCalls > 0) {
    const share = Math.max(0.05, Math.min(1, s.count / scene.totalCalls));
    over += `<circle cx="${x}" cy="${y}" r="${NODE + 2.6}"${paint('none', hue)} stroke-width="1.8" stroke-linecap="round" pathLength="100" stroke-dasharray="${n1(share * 100)} 100" transform="rotate(-90 ${x} ${y})" opacity=".85"/>`;
  }
  if (isRunning) {
    over += `<circle cx="${x}" cy="${y}" r="${NODE}"${paint('none', ring)} stroke-width="1.4"/>`;
  } else if (isLit || isAlarm) {
    over += oneShot(clock, {
      tag: 'circle',
      attrs: ` cx="${x}" cy="${y}" r="${NODE}"${paint('none', ring)} stroke-width="1.4"`,
      startAt: fadeFrom,
      durMs: span,
      tracks: [{ attr: 'opacity', values: [1, 0] }],
    });
  }
  const glyph: ActivityPaintKey = isAlarm ? 'fault' : isLit || s.count > 0 ? hue : 'dim';
  over += `<path transform="translate(${x} ${y})" d="${ICONS[s.id]}"${paint('none', glyph)} stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"${isLit || isAlarm || s.count === 0 ? '' : ' opacity=".8"'}/>`;

  // Upper stations carry their words above the node, so no spoke crosses them.
  const above = p.y < CY - RY * 0.55;
  const rim = ` paint-order="stroke" stroke-width="3.5" stroke-linejoin="round"`;
  const nameY = above ? p.y - NODE - 9 : p.y + NODE + 15;
  const countY = above ? p.y - NODE - 21 : p.y + NODE + 27;
  over += `<text x="${x}" y="${n1(nameY)}" text-anchor="middle" font-size="11"${rim}${paint(isLit || isAlarm ? 'text' : 'muted', 'ground')}>${escapeActivityXml(strings.stations[s.id])}</text>`;
  if (s.count > 0) {
    const pushed = s.id === 'memory' ? Math.min(s.count, s.pushed ?? 0) : 0;
    const asked = s.count - pushed;
    const figures =
      pushed === 0
        ? String(s.count)
        : `${asked > 0 ? `${asked} ` : ''}<tspan${paint('memory')}>↓${pushed}</tspan>`;
    over += `<text x="${x}" y="${n1(countY)}" text-anchor="middle" font-size="9.5"${rim}${paint('dim', 'ground')}>${figures}</text>`;
  }

  // Top right: calls at once. Top left: faults since the last prompt.
  const corner = NODE * 0.76;
  const runningNow = s.running;
  if (runningNow > 1) {
    over += `<circle cx="${n1(p.x + corner)}" cy="${n1(p.y - corner)}" r="8"${paint('raised', ring)} stroke-width="1"/><text x="${n1(p.x + corner)}" y="${n1(p.y - corner + 3)}" text-anchor="middle" font-size="8.5"${paint('hot')}>×${runningNow > 99 ? '99' : runningNow}</text>`;
  }
  if (s.faults > 0) {
    over += `<circle cx="${n1(p.x - corner)}" cy="${n1(p.y - corner)}" r="7.5"${paint('fault')}/><text x="${n1(p.x - corner)}" y="${n1(p.y - corner + 3.1)}" text-anchor="middle" font-size="8.5" font-weight="700"${paint('ground')}>${s.faults > 99 ? '99+' : s.faults}</text>`;
  }

  const title = `<title>${escapeActivityXml(strings.stations[s.id])}: ${s.count}${s.running > 0 ? `, ${s.running} ${strings.running}` : ''}${s.faults > 0 ? `, ${s.faults} ✕` : ''}</title>`;
  return {
    under: wrapDim(scene, s.id, under),
    over: wrapDim(scene, s.id, `<g data-station="${s.id}">${title}${over}</g>`),
  };
}

/** The two ends of an entry's flight: its origin (core or Agents) and its station. */
function ends(scene: Scene, entry: ActivityEntry): [Point, Point] {
  const p = placeOf(scene, entry.station);
  const fromAgents = entry.from === 'agents';
  const start = fromAgents ? placeOf(scene, 'agents') : CORE_POINT;
  return [edge(start, p, fromAgents ? NODE : HUB), edge(p, start, NODE)];
}

function flights(scene: Scene): string {
  const { snapshot, clock, paint } = scene;
  const seen = new Set<string>();
  const all: ActivityEntry[] = [];
  for (const entry of [...snapshot.entries, ...snapshot.running]) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    all.push(entry);
  }
  all.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
  const window = PULSE_MS + RIPPLE_MS;
  const outbound = all
    .filter((e) => clock.now - e.startedAt >= 0 && clock.now - e.startedAt < window)
    .slice(-MAX_FLIGHTS);
  const inbound = all
    .filter(
      (e) =>
        e.endedAt !== undefined &&
        e.from !== 'inbound' &&
        clock.now - e.endedAt >= 0 &&
        clock.now - e.endedAt < window &&
        // An instant call lands and returns as one gesture.
        e.endedAt > e.startedAt,
    )
    .slice(-MAX_FLIGHTS);
  const beams = all
    .filter((e) => clock.now - e.startedAt >= 0 && clock.now - e.startedAt < BEAM_MS)
    .slice(-10);

  const lane = (list: ActivityEntry[], entry: ActivityEntry): number => {
    const peers = list.filter((x) => x.station === entry.station && x.from === entry.from);
    return (peers.indexOf(entry) - (peers.length - 1) / 2) * 5;
  };

  let out = '';
  for (const e of beams) {
    const [a, b] = ends(scene, e);
    const color: ActivityPaintKey = isBad(e)
      ? 'fault'
      : e.station === 'memory'
        ? 'memory'
        : hueOf(e.station);
    out += wrapDim(
      scene,
      e.station,
      oneShot(clock, {
        tag: 'line',
        attrs: ` x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}"${paint(undefined, color)} stroke-width="1.4"${e.from === 'inbound' ? ' stroke-dasharray="3 4"' : ''}`,
        startAt: e.startedAt,
        durMs: BEAM_MS,
        tracks: [{ attr: 'opacity', values: [0.7, 0] }],
      }),
    );
  }
  for (const e of outbound) {
    const [a, b] = aside(...ends(scene, e), lane(outbound, e));
    const color: ActivityPaintKey =
      e.outcome === 'denied' ? 'fault' : e.station === 'memory' ? 'memoryHot' : hueOf(e.station);
    const hollow = e.from === 'inbound';
    const [from, to] = hollow ? [b, a] : [a, b];
    let body = '';
    for (let k = hollow ? 0 : 2; k >= 0; k--) {
      const peak = 1 - 0.36 * k;
      body += oneShot(clock, {
        tag: 'circle',
        attrs: ` r="${n1(3.8 * (1 - 0.27 * k))}"${hollow ? `${paint('none', color)} stroke-width="1.4"` : paint(color)}`,
        startAt: e.startedAt + k * 45,
        durMs: PULSE_MS,
        tracks: [{ attr: 'opacity', values: [peak, peak, 0], keyTimes: [0, 0.82, 1] }],
        flight: { from, to },
      });
    }
    const landing = hollow
      ? edge(CORE_POINT, placeOf(scene, e.station), HUB - 3)
      : placeOf(scene, e.station);
    const rippleR = hollow ? HUB - 3 : NODE;
    body += oneShot(clock, {
      tag: 'circle',
      attrs: ` cx="${n1(hollow ? CX : landing.x)}" cy="${n1(hollow ? CY : landing.y)}"${paint('none', color)} stroke-width="1.2"`,
      startAt: e.startedAt + PULSE_MS,
      durMs: RIPPLE_MS,
      tracks: [
        { attr: 'r', values: [rippleR, rippleR + 11] },
        { attr: 'opacity', values: [0.7, 0] },
      ],
    });
    out += wrapDim(scene, e.station, body);
  }
  for (const e of inbound) {
    const [a, b] = aside(...ends(scene, e), lane(inbound, e));
    const color: ActivityPaintKey = isBad(e) ? 'fault' : 'muted';
    out += wrapDim(
      scene,
      e.station,
      oneShot(clock, {
        tag: 'circle',
        attrs: ` r="2.6"${paint(color)}`,
        startAt: e.endedAt as number,
        durMs: PULSE_MS,
        tracks: [{ attr: 'opacity', values: [1, 1, 0], keyTimes: [0, 0.82, 1] }],
        flight: { from: b, to: a },
      }),
    );
  }
  return out;
}

function orbit(scene: Scene): string {
  const { snapshot, clock, paint } = scene;
  if (snapshot.agents.length === 0) return '';
  const center = placeOf(scene, 'agents');
  const crew = snapshot.agents.slice(0, MAX_ORBITERS);
  const spin = `${n1(center.x)} ${n1(center.y)}`;
  let out = '';
  crew.forEach((agent, k) => {
    const offset = (k * ORBIT_MS) / crew.length;
    const dot = `<circle cx="${n1(center.x)}" cy="${n1(center.y - NODE - 7)}" r="3"${paint('st-agents', 'ground')} stroke-width="1"/>`;
    const id = escapeActivityXml(agent.agentId);
    const title = `<title>${escapeActivityXml(agent.label)}</title>`;
    if (clock.motion === 'full') {
      out += `<g data-agent="${id}">${title}<animateTransform attributeName="transform" type="rotate" from="0 ${spin}" to="360 ${spin}" begin="${repeatBegin(clock, -offset, ORBIT_MS)}" dur="${durOf(clock, ORBIT_MS)}" repeatCount="indefinite"/>${dot}</g>`;
    } else {
      const angle = phase(clock, -offset, ORBIT_MS) * 360;
      out += `<g data-agent="${id}" transform="rotate(${n1(angle)} ${spin})">${title}${dot}</g>`;
    }
  });
  if (snapshot.agents.length > crew.length) {
    out += `<text x="${n1(center.x + NODE + 10)}" y="${n1(center.y + 3)}" font-size="9"${paint('st-agents')}>+${snapshot.agents.length - crew.length}</text>`;
  }
  return wrapDim(scene, 'agents', out);
}

function core(scene: Scene, coreName: string, modelLabel: (id: string) => string): string {
  const { snapshot, clock, paint } = scene;
  const busy =
    snapshot.running.some((e) => e.endedAt === undefined) ||
    (snapshot.turn.working && snapshot.turn.thinkingSince !== undefined);
  let out = '';

  // Breath: slow at rest, quick while something runs.
  const period = busy ? 1600 : 4800;
  const glow = `<circle cx="${CX}" cy="${CY}"${paint('accent')}`;
  if (clock.motion === 'full') {
    const timing = `begin="${repeatBegin(clock, 0, period)}" dur="${durOf(clock, period)}" repeatCount="indefinite"`;
    out += `${glow} r="${CORE + 4}" opacity=".08"><animate attributeName="r" values="${CORE + 2};${CORE + 13};${CORE + 2}" ${timing}/><animate attributeName="opacity" values=".05;${busy ? '.24' : '.12'};.05" ${timing}/></circle>`;
  } else {
    out += `${glow} r="${CORE + 6}" opacity="${busy ? '.14' : '.08'}"/>`;
  }

  // Context window: 24 segments filling clockwise from the top.
  const ringR = CORE + 6;
  const segment = `cx="${CX}" cy="${CY}" r="${ringR}" stroke-width="3" pathLength="${CONTEXT_SEGMENTS * 4}" transform="rotate(-90 ${CX} ${CY})"`;
  out += `<circle ${segment}${paint('none', 'line')} stroke-dasharray="3 1" opacity=".9"/>`;
  if (snapshot.context !== undefined) {
    const full = clamp(snapshot.context.percent, 0, 100);
    const filled = Math.round((full / 100) * CONTEXT_SEGMENTS);
    if (filled > 0) {
      const tone: ActivityPaintKey = full >= 90 ? 'fault' : full >= 70 ? 'warn' : 'accent';
      out += `<circle ${segment}${paint('none', tone)} stroke-dasharray="${'3 1 '.repeat(filled)}0 ${CONTEXT_SEGMENTS * 4}"/>`;
    }
  }

  // The hexagon.
  const hex = Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k;
    return `${n1(CX + CORE * Math.sin(a))},${n1(CY - CORE * Math.cos(a))}`;
  }).join(' ');
  out += `<polygon points="${hex}"${paint('raised', busy ? 'accent' : 'line')} stroke-width="1.4" stroke-linejoin="round"/>`;

  if (snapshot.context !== undefined) {
    out += `<text x="${CX}" y="${CY - 17}" text-anchor="middle" font-size="8.5"${paint('dim')}>${Math.round(clamp(snapshot.context.percent, 0, 100))}%</text>`;
  }
  const size = Math.min(15, 62 / (0.62 * Math.max(1, coreName.length)));
  out += `<text x="${CX}" y="${n1(CY + (snapshot.model ? 2 : 5))}" text-anchor="middle" font-size="${n1(size)}" font-weight="600" letter-spacing="${n1(size * 0.12)}"${paint('text')}>${escapeActivityXml(coreName)}</text>`;

  const switchAge =
    snapshot.model?.switchedAt === undefined ? Infinity : clock.now - snapshot.model.switchedAt;
  const isSwitching = switchAge >= 0 && switchAge < SWITCH_MS;
  const extras: string[] = [];
  if (snapshot.model) extras.push(escapeActivityXml(modelLabel(snapshot.model.id)));
  if (snapshot.compactions > 0) extras.push(`⟲${snapshot.compactions}`);
  if (extras.length > 0) {
    out += `<text x="${CX}" y="${CY + 16}" text-anchor="middle" font-size="8.5"${paint(isSwitching ? 'hot' : 'muted')}>${extras.join(' · ')}</text>`;
  }

  // A changed model rings at the core and at the Model station.
  if (isSwitching && snapshot.model?.switchedAt !== undefined) {
    const model = placeOf(scene, 'model');
    for (let lap = 0; lap * SWITCH_LAP_MS < SWITCH_MS; lap++) {
      const startAt = snapshot.model.switchedAt + lap * SWITCH_LAP_MS;
      for (const [p, r] of [
        [CORE_POINT, CORE],
        [model, NODE],
      ] as const) {
        out += oneShot(clock, {
          tag: 'circle',
          attrs: ` cx="${n1(p.x)}" cy="${n1(p.y)}"${paint('none', 'hot')} stroke-width="1.4"`,
          startAt,
          durMs: SWITCH_LAP_MS,
          tracks: [
            { attr: 'r', values: [r, r + 24] },
            { attr: 'opacity', values: [0.7, 0] },
          ],
        });
      }
    }
  }

  // The turn's end leaves the core as one wide ring: calm when done, red when cut short.
  const end = snapshot.turn.lastEnd;
  if (end !== undefined) {
    out += oneShot(clock, {
      tag: 'circle',
      attrs: ` cx="${CX}" cy="${CY}"${paint('none', end.outcome === 'done' ? 'text' : 'fault')} stroke-width="1.6"`,
      startAt: end.at,
      durMs: DONE_MS,
      tracks: [
        { attr: 'r', values: [CORE, CORE + 40] },
        { attr: 'opacity', values: [0.6, 0] },
      ],
    });
  }

  // A compaction folds the context inward.
  if (snapshot.lastCompactionAt !== undefined) {
    out += oneShot(clock, {
      tag: 'circle',
      attrs: ` cx="${CX}" cy="${CY}"${paint('none', 'accent')} stroke-width="1.4" stroke-dasharray="3 3"`,
      startAt: snapshot.lastCompactionAt,
      durMs: COMPACT_MS,
      tracks: [
        { attr: 'r', values: [CORE + 36, CORE + 7] },
        { attr: 'opacity', values: [0.7, 0] },
      ],
    });
  }
  return `<g data-part="core">${out}</g>`;
}

// ── Entry point ─────────────────────────────────────────────────────────

export function renderActivityMapSvg(
  snapshot: ActivitySnapshot,
  options: RenderActivityMapSvgOptions,
): string {
  const theme = options.theme ?? 'auto';
  const prefix = (options.classPrefix ?? 'sam').replace(/[^a-zA-Z0-9_-]/g, '') || 'sam';
  const idPrefix =
    (options.idPrefix ?? 'activity-map').replace(/[^a-zA-Z0-9_-]/g, '') || 'activity-map';
  const dark = mergeActivityPalette(
    ACTIVITY_DARK_PALETTE,
    theme === 'light' ? undefined : options.palette,
  );
  const light = mergeActivityPalette(
    ACTIVITY_LIGHT_PALETTE,
    theme === 'light' ? options.palette : undefined,
  );
  const paint = makePainter(theme, dark, light, prefix, options.embedStyles ?? true);
  const strings = resolveActivityStrings(options.strings);
  const speed = options.speed !== undefined && options.speed > 0 ? options.speed : 1;
  const clock: Clock = {
    now: options.now,
    speed,
    offsetMs: options.clockOffsetMs ?? 0,
    motion: options.motion ?? 'full',
  };
  const highlight = new Set<ActivityStationId>(
    options.highlight === undefined
      ? []
      : typeof options.highlight === 'string'
        ? [options.highlight]
        : options.highlight,
  );
  const stationIndex = new Map<ActivityStationId, number>(
    ACTIVITY_STATIONS.map((id, i) => [id, i]),
  );
  // Draw every station, in ring order, even if the snapshot lists only some.
  const byId = new Map(snapshot.stations.map((s) => [s.id, s]));
  const stations: ActivityStationSnapshot[] = ACTIVITY_STATIONS.map(
    (id) => byId.get(id) ?? { id, count: 0, running: 0, faults: 0 },
  );
  const scene: Scene = {
    snapshot: { ...snapshot, stations },
    clock,
    paint,
    strings,
    shift: options.layout === 'you-bottom' ? N / 2 : 0,
    dimmed: (station) => highlight.size > 0 && !highlight.has(station),
    stationIndex,
    totalCalls: stations.reduce((sum, s) => sum + s.count, 0),
  };

  const drawn = stations.map((s) => station(scene, s));
  const pattern = patterns(scene);
  const coreName = resolveActivityCoreName(options.coreName, snapshot.providerId);
  const modelLabel = options.modelLabel ?? shortActivityModel;

  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;
  const title = `<title id="${titleId}">${escapeActivityXml(`${strings.title}. ${describeActivityNow(scene.snapshot, { now: clock.now, strings: options.strings })}`)}</title>`;
  const desc =
    options.insights !== undefined
      ? `<desc id="${descId}">${escapeActivityXml(describeActivityInsights(options.insights, { strings: options.strings }))}</desc>`
      : '';
  const labelledBy = options.insights !== undefined ? `${titleId} ${descId}` : titleId;

  const size =
    options.size === 'responsive'
      ? ' width="100%" preserveAspectRatio="xMidYMid meet"'
      : ` width="${Math.round(options.size?.width ?? W * 2)}" height="${Math.round(options.size?.height ?? H * 2)}"`;

  const body =
    background(scene) +
    spokes(scene) +
    pattern.under +
    drawn.map((d) => d.under).join('') +
    trail(scene) +
    flights(scene) +
    drawn.map((d) => d.over).join('') +
    pattern.over +
    orbit(scene) +
    core(scene, coreName, modelLabel);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"${size} role="img" aria-labelledby="${labelledBy}" font-family="${FONT}" data-theme="${theme}">` +
    title +
    desc +
    paint.styles +
    body +
    '</svg>'
  );
}

/** Size of the drawing's coordinate space, for hosts laying it out. */
export const ACTIVITY_MAP_VIEWBOX = { width: W, height: H } as const;
