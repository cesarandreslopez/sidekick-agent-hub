/**
 * The activity feed list: newest first, finished calls in a row at one
 * station folded into one line. Text only (`textContent`), never markup.
 *
 * @module webview/activityMap/feed
 */

import { DEFAULT_ACTIVITY_STRINGS } from 'sidekick-shared/activity';
import type { ActivityFeedRow } from 'sidekick-shared/activity';
import { formatDuration } from './format';

export type FeedRowState = 'running' | 'ok' | 'fault' | 'mark';

export interface FeedLine {
  mark: string;
  station: string;
  label: string;
  took: string;
  state: FeedRowState;
}

/** One feed row as text: the mark, the station, the label (`+N` when folded), the duration. */
export function feedLine(row: ActivityFeedRow, now: number): FeedLine {
  const { entry } = row;
  const strings = DEFAULT_ACTIVITY_STRINGS;
  const label = entry.labelKey ? strings.labels[entry.labelKey] : entry.label;
  const running = entry.endedAt === undefined;
  const fault = entry.outcome === 'error' || entry.outcome === 'denied';
  let mark = '·';
  let state: FeedRowState = 'ok';
  if (entry.mark === 'switch' || entry.mark === 'compaction') {
    mark = '◆';
    state = 'mark';
  } else if (running) {
    mark = '●';
    state = 'running';
  } else if (fault) {
    mark = '✕';
    state = 'fault';
  } else if (entry.outcome === 'cancelled') {
    mark = '⊘';
  }
  const took = running
    ? formatDuration(Math.max(0, now - entry.startedAt)) || strings.running
    : row.tookMs > 0
      ? formatDuration(row.tookMs)
      : '';
  return {
    mark,
    station: strings.stations[entry.station],
    label: `${label}${row.times > 1 ? `  +${row.times - 1}` : ''}${entry.deniedBy ? ` (denied by ${entry.deniedBy})` : ''}`,
    took,
    state,
  };
}

export function renderFeed(
  list: HTMLElement,
  rows: readonly ActivityFeedRow[],
  now: number,
  emptyText: string = DEFAULT_ACTIVITY_STRINGS.nothingYet,
): void {
  const doc = list.ownerDocument;
  const items: HTMLElement[] = [];
  if (rows.length === 0) {
    const li = doc.createElement('li');
    li.className = 'am-placeholder';
    li.textContent = emptyText;
    items.push(li);
  }
  for (const row of rows) {
    const line = feedLine(row, now);
    const li = doc.createElement('li');
    li.dataset.state = line.state;
    li.dataset.station = row.entry.station;
    for (const [cls, text] of [
      ['am-mark', line.mark],
      ['am-station', line.station],
      ['am-label', line.label],
      ['am-took', line.took],
    ] as const) {
      const span = doc.createElement('span');
      span.className = cls;
      span.textContent = text;
      if (cls === 'am-label') span.title = text;
      li.appendChild(span);
    }
    items.push(li);
  }
  list.replaceChildren(...items);
}
