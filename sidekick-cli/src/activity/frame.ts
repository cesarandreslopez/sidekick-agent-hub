/**
 * Terminal frames of the activity map, as rows of tone-tagged segments.
 *
 * Pure: everything is a function of the snapshot, the insights, `now` and the
 * size, so the live `map --follow` view, the `--format text` export and the
 * dashboard's Map panel draw the same map, and tests need no terminal.
 */

import {
  DEFAULT_ACTIVITY_STRINGS,
  describeActivityInsights,
  describeActivityNow,
  foldActivityFeed,
  layoutActivityMapText,
} from 'sidekick-shared';
import type {
  ActivityFeedRow,
  ActivityInsights,
  ActivitySnapshot,
  ActivityStationId,
  ActivityTextSegment,
  ActivityTone,
} from 'sidekick-shared';

export type FrameRow = ActivityTextSegment[];

/** Smallest terminal the live view draws in; below it, it asks for more room. */
export const FOLLOW_MIN_WIDTH = 40;
export const FOLLOW_MIN_HEIGHT = 14;

/** `90ms`, `4.2s`, `3m05s`, `1h07m`. */
export function formatSpan(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1_000);
    return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}

function visible(row: readonly ActivityTextSegment[]): number {
  return row.reduce((sum, segment) => sum + Array.from(segment.text).length, 0);
}

/** Cuts a row to `width` visible characters, ending with `…` when cut. */
export function fitRow(row: readonly ActivityTextSegment[], width: number): FrameRow {
  if (width <= 0) return [];
  if (visible(row) <= width) return row.slice();
  const out: FrameRow = [];
  let used = 0;
  for (const segment of row) {
    const chars = Array.from(segment.text);
    if (used + chars.length < width) {
      out.push(segment);
      used += chars.length;
      continue;
    }
    const room = width - used - 1;
    if (room > 0) out.push({ ...segment, text: chars.slice(0, room).join('') });
    out.push({ text: '…', tone: 'dim' });
    return out;
  }
  return out;
}

function text(value: string, tone: ActivityTone = 'default', extra?: Partial<ActivityTextSegment>) {
  return { text: value, tone, ...extra } satisfies ActivityTextSegment;
}

function rule(title: string, width: number): FrameRow {
  const head = `── ${title} `;
  return [
    text(head, 'muted'),
    text('─'.repeat(Math.max(0, width - Array.from(head).length)), 'dim'),
  ];
}

const STATION_NAMES = DEFAULT_ACTIVITY_STRINGS.stations;
const NAME_WIDTH = Math.max(...Object.values(STATION_NAMES).map((name) => name.length));

/** One feed row: mark, station, label, `+N` folded, and how long it took. */
export function feedRowSegments(row: ActivityFeedRow, now: number): FrameRow {
  const { entry, times, tookMs } = row;
  const running = entry.endedAt === undefined && entry.outcome === undefined;
  const fault = entry.outcome === 'error' || entry.outcome === 'denied';
  const mark = entry.mark === 'switch' ? '◆' : running ? '●' : fault ? '✕' : '·';
  const markTone: ActivityTone = running ? 'hot' : fault ? 'fault' : entry.mark ? 'accent' : 'dim';
  const station: ActivityStationId = entry.station;
  const label =
    entry.label || (entry.labelKey ? DEFAULT_ACTIVITY_STRINGS.labels[entry.labelKey] : '');
  const segments: FrameRow = [
    text(`${mark} `, markTone, { bold: running || fault }),
    text(STATION_NAMES[station].padEnd(NAME_WIDTH), 'accent', { station }),
    text(` ${label}`, fault ? 'fault' : running ? 'default' : 'muted'),
  ];
  if (times > 1) segments.push(text(`  +${times - 1}`, 'dim'));
  if (running) segments.push(text(`  ${formatSpan(now - entry.startedAt)}`, 'hot'));
  else if (tookMs > 0) segments.push(text(`  ${formatSpan(tookMs)}`, 'dim'));
  if (entry.outcome === 'denied') segments.push(text('  denied', 'fault'));
  return segments;
}

/** Up to `max` folded feed rows, newest first. */
export function feedRows(
  snapshot: ActivitySnapshot,
  options: { now: number; max: number; width: number; station?: ActivityStationId },
): FrameRow[] {
  if (options.max <= 0) return [];
  const rows = foldActivityFeed(snapshot.entries, {
    max: options.max,
    ...(options.station ? { station: options.station } : {}),
  });
  if (rows.length === 0)
    return [fitRow([text(DEFAULT_ACTIVITY_STRINGS.nothingYet, 'dim')], options.width)];
  return rows.map((row) => fitRow(feedRowSegments(row, options.now), options.width));
}

/** The insight summary as rows. */
export function insightRows(insights: ActivityInsights, max: number, width: number): FrameRow[] {
  if (max <= 0) return [];
  return describeActivityInsights(insights, { maxLines: max })
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(0, max)
    .map((line) => fitRow([text(line, 'muted')], width));
}

function mapRows(
  snapshot: ActivitySnapshot,
  options: {
    now: number;
    width: number;
    height: number;
    coreName?: string;
    highlight?: ActivityStationId;
  },
): FrameRow[] {
  const layout = layoutActivityMapText(snapshot, {
    now: options.now,
    width: options.width,
    height: options.height,
    ...(options.coreName ? { coreName: options.coreName } : {}),
    ...(options.highlight ? { highlight: options.highlight } : {}),
  });
  return layout.rows.slice(0, Math.max(0, options.height)).map((row) => fitRow(row, options.width));
}

// ── The live view ────────────────────────────────────────────────────────

export type FollowPanel = 'feed' | 'insights' | 'none';
export type FollowMode = 'live' | 'paused' | 'waiting';

export interface FollowFrameInput {
  snapshot: ActivitySnapshot | null;
  insights: ActivityInsights | null;
  /** The moment drawn: the clock when live, the cursor when paused. */
  now: number;
  width: number;
  height: number;
  panel: FollowPanel;
  mode: FollowMode;
  providerLabel?: string;
  /** Short session id. */
  sessionLabel?: string;
  coreName?: string;
  /** One line of news (a session switch, an error). */
  notice?: string;
  /** Shown while waiting for a session. */
  workspaceLabel?: string;
}

function headerRow(input: FollowFrameInput): FrameRow {
  const { snapshot } = input;
  const row: FrameRow = [];
  if (input.mode === 'live') row.push(text(' ● LIVE ', 'ok', { bold: true }));
  else if (input.mode === 'paused') row.push(text(' ‖ PAUSED ', 'hot', { bold: true }));
  else row.push(text(' ○ WAITING ', 'muted', { bold: true }));
  const parts: string[] = [];
  if (input.providerLabel) parts.push(input.providerLabel);
  if (input.sessionLabel) parts.push(input.sessionLabel);
  if (snapshot?.model) parts.push(snapshot.model.id);
  if (snapshot?.context) parts.push(`ctx ${Math.round(snapshot.context.percent)}%`);
  if (snapshot?.startedAt !== undefined) {
    // Paused: where the cursor is. Live and working: time since the start.
    // Live and quiet: the session's own span, not hours of idle clock.
    const working = snapshot.turn.working || snapshot.running.length > 0;
    const end = input.mode === 'paused' || working ? input.now : Math.min(input.now, snapshot.at);
    const span = formatSpan(end - snapshot.startedAt);
    parts.push(input.mode === 'paused' ? `at +${span}` : span);
  }
  if (parts.length > 0) row.push(text(` ${parts.join(' · ')}`, 'muted'));
  return fitRow(row, input.width);
}

const KEYS_LIVE = 'q quit · f feed · i insights · p pause';
const KEYS_PAUSED = 'q quit · ←/→ 10s · ⇧ 60s · l live · f/i panels';

function footerRows(input: FollowFrameInput): FrameRow[] {
  const keys = input.mode === 'paused' ? KEYS_PAUSED : KEYS_LIVE;
  const now = input.snapshot ? describeActivityNow(input.snapshot, { now: input.now }) : '';
  return [fitRow([text(now, 'default')], input.width), fitRow([text(keys, 'dim')], input.width)];
}

/** One full frame of `map --follow`, exactly `height` rows (or fewer when too small). */
export function buildFollowFrame(input: FollowFrameInput): FrameRow[] {
  const width = Math.max(1, Math.floor(input.width));
  const height = Math.max(1, Math.floor(input.height));
  if (width < FOLLOW_MIN_WIDTH || height < FOLLOW_MIN_HEIGHT) {
    return [
      fitRow([text('Enlarge the terminal for the activity map', 'hot')], width),
      fitRow(
        [
          text(
            `(at least ${FOLLOW_MIN_WIDTH}×${FOLLOW_MIN_HEIGHT}; now ${width}×${height})`,
            'dim',
          ),
        ],
        width,
      ),
    ];
  }

  const rows: FrameRow[] = [headerRow({ ...input, width })];
  if (input.notice) rows.push(fitRow([text(input.notice, 'accent')], width));

  if (!input.snapshot || input.mode === 'waiting') {
    rows.push([]);
    rows.push(
      fitRow(
        [
          text('Waiting for a session', 'muted'),
          text(input.workspaceLabel ? ` in ${input.workspaceLabel}` : '', 'dim'),
          text('…', 'muted'),
        ],
        width,
      ),
    );
    rows.push(fitRow([text('Start the agent here; the map follows it.', 'dim')], width));
    while (rows.length < height - 1) rows.push([]);
    rows.push(fitRow([text('q quit', 'dim')], width));
    return rows.slice(0, height);
  }

  const footer = footerRows({ ...input, width });
  const panelRows = input.panel === 'none' ? 0 : Math.max(3, Math.min(8, Math.floor(height / 4)));
  const mapHeight = Math.max(
    4,
    height - rows.length - footer.length - (panelRows > 0 ? panelRows + 1 : 0),
  );
  rows.push(
    ...mapRows(input.snapshot, {
      now: input.now,
      width,
      height: mapHeight,
      ...(input.coreName ? { coreName: input.coreName } : {}),
    }),
  );
  while (rows.length < height - footer.length - (panelRows > 0 ? panelRows + 1 : 0)) rows.push([]);

  if (panelRows > 0) {
    if (input.panel === 'feed') {
      rows.push(rule('Activity', width));
      rows.push(...feedRows(input.snapshot, { now: input.now, max: panelRows, width }));
    } else if (input.insights) {
      rows.push(rule('Insights', width));
      rows.push(...insightRows(input.insights, panelRows, width));
    }
    while (rows.length < height - footer.length) rows.push([]);
  }
  rows.push(...footer);
  return rows.slice(0, height);
}

// ── The text export ─────────────────────────────────────────────────────

export interface TextReportInput {
  snapshot: ActivitySnapshot;
  insights: ActivityInsights;
  now: number;
  width: number;
  /** Rows for the map itself. */
  mapHeight: number;
  coreName?: string;
  /** Feed rows after the map. Default 10. */
  feed?: number;
}

/** `sidekick map --format text`: the map, the moment, the feed and the insights. */
export function buildTextReport(input: TextReportInput): FrameRow[] {
  const width = Math.max(20, Math.floor(input.width));
  const rows: FrameRow[] = mapRows(input.snapshot, {
    now: input.now,
    width,
    height: Math.max(4, input.mapHeight),
    ...(input.coreName ? { coreName: input.coreName } : {}),
  });
  while (rows.length > 0 && rows[rows.length - 1].every((segment) => !segment.text.trim())) {
    rows.pop();
  }
  rows.push([]);
  rows.push(
    fitRow([text(describeActivityNow(input.snapshot, { now: input.now }), 'default')], width),
  );
  rows.push([]);
  rows.push(rule('Activity', width));
  rows.push(...feedRows(input.snapshot, { now: input.now, max: input.feed ?? 10, width }));
  rows.push([]);
  rows.push(rule('Insights', width));
  rows.push(...insightRows(input.insights, 12, width));
  return rows;
}
