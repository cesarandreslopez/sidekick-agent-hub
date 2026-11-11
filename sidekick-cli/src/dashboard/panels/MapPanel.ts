/**
 * Map panel — the activity map of the followed session.
 *
 * Items: an overview, then one row per station in ring order. Two detail tabs:
 * 1. Map — the map (the selected station emphasised) with the moment and the
 *    folded feed, filtered to the station when one is selected.
 * 2. Insights — where the time, faults and context went, station by station,
 *    and any detected patterns.
 *
 * Durations and spinners move on their own, so while anything runs the panel
 * asks for a redraw a few times a second (and every few seconds otherwise).
 */

import {
  ACTIVITY_STATIONS,
  DEFAULT_ACTIVITY_STRINGS,
  describeActivityInsights,
  describeActivityNow,
  describeActivityPattern,
  layoutActivityMapText,
} from 'sidekick-shared';
import type {
  ActivityInsights,
  ActivitySnapshot,
  ActivityStationId,
  ActivityStationInsight,
} from 'sidekick-shared';
import type { DashboardMetrics } from '../DashboardState';
import type { DetailRenderContext, DetailTab, PanelAction, PanelItem, SidePanel } from './types';
import { detailWidth, escapeBlessed, makeColorBar, sectionHeader, wordWrap } from '../formatters';
import { feedRows, fitRow, formatSpan } from '../../activity/frame';
import { rowsToBlessed, segmentsToBlessed, STATION_TERMINAL_COLORS } from '../../activity/tones';

type MapItem = { type: 'overview' } | { type: 'station'; station: ActivityStationId };

const NAMES = DEFAULT_ACTIVITY_STRINGS.stations;
const TICK_MS = 400;
/** While nothing moves, redraw every this many ticks (≈ 5 s). */
const IDLE_TICKS = 12;

function blessedColor(color: string): string {
  return color === 'gray' ? 'grey' : color;
}

function stationDot(station: ActivityStationId): string {
  const color = blessedColor(STATION_TERMINAL_COLORS[station]);
  return `{${color}-fg}●{/${color}-fg}`;
}

function grey(text: string): string {
  return `{grey-fg}${escapeBlessed(text)}{/grey-fg}`;
}

export class MapPanel implements SidePanel {
  readonly id = 'map';
  readonly title = 'Map';
  readonly shortcutKey = 9;
  readonly emptyStateHint = 'The activity map appears once the session is read.';

  readonly detailTabs: DetailTab[] = [
    { label: 'Map', render: (item, m, _sd, ctx) => this.renderMap(item, m, ctx) },
    { label: 'Insights', render: (item, m, _sd, ctx) => this.renderInsights(item, m, ctx) },
  ];

  private _viewVersion = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private idleTicks = 0;
  private lastSnapshot: ActivitySnapshot | null = null;

  constructor(
    private readonly requestRender: () => void = () => {},
    private readonly options: { coreName?: string; now?: () => number } = {},
  ) {}

  get viewVersion(): number {
    return this._viewVersion;
  }

  getItems(metrics: DashboardMetrics): PanelItem[] {
    const activity = metrics.activity;
    if (!activity) return [];
    this.lastSnapshot = activity.snapshot;
    const byId = new Map(activity.snapshot.stations.map((s) => [s.id, s]));
    const totals = activity.snapshot.totals;
    const items: PanelItem[] = [
      {
        id: 'overview',
        label: `{bold}Overview{/bold} ${grey(`${totals.calls} calls`)}`,
        sortKey: 0,
        data: { type: 'overview' } satisfies MapItem,
      },
    ];
    ACTIVITY_STATIONS.forEach((station, index) => {
      const s = byId.get(station);
      const count = s?.count ?? 0;
      const running = s?.running ?? 0;
      const faults = s?.faults ?? 0;
      let label = `${stationDot(station)} ${escapeBlessed(NAMES[station])}`;
      label += count > 0 ? ` ${grey(String(count))}` : '';
      if (running > 0) label += ' {yellow-fg}●{/yellow-fg}';
      if (faults > 0) label += ` {red-fg}!${faults}{/red-fg}`;
      items.push({
        id: `station:${station}`,
        label,
        sortKey: index + 1,
        data: { type: 'station', station } satisfies MapItem,
      });
    });
    return items;
  }

  getActions(): PanelAction[] {
    return [];
  }

  getSearchableText(item: PanelItem): string {
    const data = item.data as MapItem;
    return data.type === 'station' ? NAMES[data.station] : 'Overview';
  }

  onActivate(): void {
    this.stopTicker();
    this.idleTicks = 0;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref?.();
  }

  onDeactivate(): void {
    this.stopTicker();
  }

  dispose(): void {
    this.stopTicker();
  }

  // ── Ticker ──

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private inMotion(): boolean {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return false;
    if (snapshot.running.length > 0 || snapshot.turn.working) return true;
    return Number.isFinite(snapshot.at) && this.now() - snapshot.at < 3_000;
  }

  private tick(): void {
    if (this.inMotion()) {
      this.idleTicks = 0;
    } else if (++this.idleTicks < IDLE_TICKS) {
      return;
    } else {
      this.idleTicks = 0;
    }
    this._viewVersion++;
    this.requestRender();
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  // ── Map tab ──

  private renderMap(item: PanelItem, metrics: DashboardMetrics, ctx?: DetailRenderContext): string {
    const activity = metrics.activity;
    if (!activity) return grey('(no activity yet)');
    const snapshot = activity.snapshot;
    this.lastSnapshot = snapshot;
    const data = item.data as MapItem;
    const station = data.type === 'station' ? data.station : undefined;
    const width = ctx?.width ?? detailWidth();
    const height = Math.max(20, ctx?.height ?? 30);
    const now = this.now();

    const feedMax = Math.max(4, Math.min(12, Math.floor(height / 3)));
    const mapHeight = Math.max(15, height - feedMax - 4);
    const layout = layoutActivityMapText(snapshot, {
      now,
      width,
      height: mapHeight,
      ...(this.options.coreName ? { coreName: this.options.coreName } : {}),
      ...(station ? { highlight: station } : {}),
    });
    const lines = rowsToBlessed(layout.rows.map((row) => fitRow(row, width)));
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('');
    lines.push(wordWrap(escapeBlessed(describeActivityNow(snapshot, { now })), width, '  '));
    lines.push('');
    lines.push(sectionHeader(station ? `${NAMES[station]} activity` : 'Activity', width));
    lines.push(
      ...rowsToBlessed(
        feedRows(snapshot, { now, max: feedMax, width, ...(station ? { station } : {}) }),
      ),
    );
    return lines.join('\n');
  }

  // ── Insights tab ──

  private renderInsights(
    item: PanelItem,
    metrics: DashboardMetrics,
    ctx?: DetailRenderContext,
  ): string {
    const activity = metrics.activity;
    if (!activity) return grey('(no activity yet)');
    const width = ctx?.width ?? detailWidth();
    const data = item.data as MapItem;
    return data.type === 'station'
      ? this.renderStationInsight(data.station, activity, width)
      : this.renderOverviewInsights(activity.insights, width);
  }

  private renderOverviewInsights(insights: ActivityInsights, width: number): string {
    const lines: string[] = [sectionHeader('Where the time went', width), ''];
    const rows = insights.stations.filter((s) => s.calls > 0);
    if (rows.length === 0) {
      lines.push(grey('(no calls yet)'));
    } else {
      const sorted = rows.slice().sort((a, b) => b.busyMs - a.busyMs || b.calls - a.calls);
      const maxChars = Math.max(1, ...rows.map((s) => s.resultChars));
      const barWidth = Math.max(6, Math.min(20, width - 52));
      lines.push(
        grey(
          `${'Station'.padEnd(10)}${'Calls'.padStart(6)}${'Time'.padStart(9)}${'Err'.padStart(5)}${'Den'.padStart(5)}  Context`,
        ),
      );
      for (const s of sorted) lines.push(this.stationRow(s, maxChars, barWidth));
    }
    if (insights.patterns.length > 0) {
      lines.push('', sectionHeader('Patterns', width), '');
      for (const pattern of insights.patterns.slice(-6)) {
        const open = pattern.state === 'open';
        const text = escapeBlessed(describeActivityPattern(pattern));
        const mark = open ? '{yellow-fg}▲{/yellow-fg}' : '{grey-fg}△{/grey-fg}';
        lines.push(wordWrap(`${mark} ${text}`, width, '  '));
      }
    }
    lines.push('', sectionHeader('Summary', width), '');
    for (const line of describeActivityInsights(insights, { maxLines: 10 }).split('\n')) {
      if (line) lines.push(wordWrap(escapeBlessed(line), width, '  '));
    }
    return lines.join('\n');
  }

  private stationRow(s: ActivityStationInsight, maxChars: number, barWidth: number): string {
    const name = `${stationDot(s.id)} ${escapeBlessed(NAMES[s.id].padEnd(8))}`;
    const calls = String(s.calls).padStart(6);
    const time = formatSpan(s.busyMs).padStart(9);
    const errors =
      s.errors > 0 ? `{red-fg}${String(s.errors).padStart(5)}{/red-fg}` : grey('0'.padStart(5));
    const denials =
      s.denials > 0
        ? `{yellow-fg}${String(s.denials).padStart(5)}{/yellow-fg}`
        : grey('0'.padStart(5));
    const bar = makeColorBar((s.resultChars / maxChars) * 100, barWidth, 'cyan');
    const tokens = s.estTokens > 0 ? grey(` ~${formatTokens(s.estTokens)}`) : '';
    return `${name}${calls}${time}${errors}${denials}  ${bar}${tokens}`;
  }

  private renderStationInsight(
    station: ActivityStationId,
    activity: { snapshot: ActivitySnapshot; insights: ActivityInsights },
    width: number,
  ): string {
    const s = activity.insights.stations.find((entry) => entry.id === station);
    const lines: string[] = [sectionHeader(NAMES[station], width), ''];
    if (!s || s.calls === 0) {
      lines.push(grey('(no calls at this station yet)'));
      return lines.join('\n');
    }
    const facts: Array<[string, string]> = [
      ['Calls', String(s.calls)],
      ['Busy', `${formatSpan(s.busyMs)} (${Math.round(s.shareOfBusy * 100)}% of busy time)`],
      ['Call time', formatSpan(s.callMs)],
      ...(s.avgMs !== undefined
        ? ([['Average', formatSpan(s.avgMs)]] as Array<[string, string]>)
        : []),
      ...(s.p95Ms !== undefined ? ([['p95', formatSpan(s.p95Ms)]] as Array<[string, string]>) : []),
      ['Errors', String(s.errors)],
      ['Denied', String(s.denials)],
      ['Cancelled', String(s.cancelled)],
      ['Context', `${formatTokens(s.estTokens)} tokens (est.) of tool output`],
    ];
    for (const [label, value] of facts) {
      lines.push(
        wordWrap(`${grey(label.padEnd(10))} ${escapeBlessed(value)}`, width, ' '.repeat(11)),
      );
    }
    if (s.topLabels.length > 0) {
      lines.push('', sectionHeader('Most used', width), '');
      for (const top of s.topLabels) {
        lines.push(wordWrap(`${escapeBlessed(top.label)} ${grey(`×${top.count}`)}`, width, '  '));
      }
    }
    const faults = activity.snapshot.entries
      .filter((e) => e.station === station && (e.outcome === 'error' || e.outcome === 'denied'))
      .slice(-5)
      .reverse();
    if (faults.length > 0) {
      lines.push('', sectionHeader('Recent faults', width), '');
      for (const entry of faults) {
        lines.push(
          segmentsToBlessed([
            { text: entry.outcome === 'denied' ? 'denied ' : 'error  ', tone: 'fault' },
            { text: entry.label, tone: 'default' },
          ]),
        );
      }
    }
    return lines.join('\n');
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
