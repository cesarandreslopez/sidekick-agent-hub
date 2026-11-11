/**
 * The insights section: a station table (where the time, the faults and the
 * context went) with each row a toggle button, the detected patterns, and
 * the plain-text summary.
 *
 * @module webview/activityMap/insights
 */

import {
  DEFAULT_ACTIVITY_STRINGS,
  describeActivityInsights,
  describeActivityPattern,
} from 'sidekick-shared/activity';
import type {
  ActivityInsights,
  ActivityPattern,
  ActivityStationId,
} from 'sidekick-shared/activity';
import { formatCount, formatDuration } from './format';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface InsightsHandlers {
  onSelectStation(station: ActivityStationId): void;
  onSelectPattern(pattern: ActivityPattern): void;
}

/** Stations worth a row (anything happened there), busiest first. */
export function rankedStations(insights: ActivityInsights): ActivityInsights['stations'] {
  return insights.stations
    .filter((station) => station.calls > 0 || station.busyMs > 0 || station.resultChars > 0)
    .slice()
    .sort((a, b) => b.busyMs - a.busyMs || b.calls - a.calls);
}

function swatch(doc: Document, station: ActivityStationId): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '8');
  svg.setAttribute('height', '8');
  svg.setAttribute('aria-hidden', 'true');
  const circle = doc.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '4');
  circle.setAttribute('cy', '4');
  circle.setAttribute('r', '4');
  circle.setAttribute('fill', `var(--sidekick-activity-station-${station})`);
  svg.appendChild(circle);
  return svg;
}

function cell(doc: Document, className: string, text: string): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

export function renderInsights(
  container: HTMLElement,
  insights: ActivityInsights,
  selected: ActivityStationId | undefined,
  handlers: InsightsHandlers,
  options: { maxRows?: number; summary?: boolean } = {},
): void {
  const doc = container.ownerDocument;
  const strings = DEFAULT_ACTIVITY_STRINGS;
  const nodes: Node[] = [];
  const rows = rankedStations(insights).slice(0, options.maxRows ?? 11);

  if (rows.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'am-summary';
    empty.textContent = strings.nothingYet;
    nodes.push(empty);
  } else {
    const header = doc.createElement('div');
    header.className = 'am-row';
    header.setAttribute('aria-hidden', 'true');
    header.style.cursor = 'default';
    for (const [cls, text] of [
      ['', ''],
      ['', 'Station'],
      ['am-num', 'Calls'],
      ['am-num', 'Busy'],
      ['am-num', 'Faults'],
      ['am-num', 'Context'],
    ] as const) {
      header.appendChild(cell(doc, cls, text));
    }
    nodes.push(header);
    for (const station of rows) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'am-row';
      button.dataset.station = station.id;
      button.setAttribute('aria-pressed', selected === station.id ? 'true' : 'false');
      const faults = station.errors + station.denials;
      button.setAttribute(
        'aria-label',
        `${strings.stations[station.id]}: ${station.calls} calls, busy ${formatDuration(station.busyMs) || '0s'}, ${faults} faults, about ${formatCount(station.estTokens)} tokens into context`,
      );
      button.appendChild(swatch(doc, station.id));
      button.appendChild(cell(doc, '', strings.stations[station.id]));
      button.appendChild(cell(doc, 'am-num', String(station.calls)));
      button.appendChild(cell(doc, 'am-num', formatDuration(station.busyMs) || '—'));
      button.appendChild(cell(doc, `am-num${faults > 0 ? ' am-faults' : ''}`, String(faults)));
      button.appendChild(
        cell(doc, 'am-num', station.estTokens > 0 ? `~${formatCount(station.estTokens)}` : '—'),
      );
      button.addEventListener('click', () => handlers.onSelectStation(station.id));
      nodes.push(button);
    }
  }

  if (insights.patterns.length > 0) {
    const list = doc.createElement('ul');
    list.className = 'am-patterns';
    for (const pattern of insights.patterns.slice(-6).reverse()) {
      const li = doc.createElement('li');
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.state = pattern.state;
      button.textContent = `${describeActivityPattern(pattern)}${pattern.state === 'open' ? ' — ongoing' : ''}`;
      button.addEventListener('click', () => handlers.onSelectPattern(pattern));
      li.appendChild(button);
      list.appendChild(li);
    }
    nodes.push(list);
  }

  if (options.summary !== false) {
    const summary = doc.createElement('p');
    summary.className = 'am-summary';
    summary.textContent = describeActivityInsights(insights, { maxLines: 8 });
    nodes.push(summary);
  }
  container.replaceChildren(...nodes);
}
