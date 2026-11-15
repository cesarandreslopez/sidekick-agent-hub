/**
 * Event Stream panel — scrollable, auto-tailing view of raw session events.
 *
 * Each item = one FollowEvent with timestamp, type badge, and highlighted summary.
 * Detail tabs show full event JSON and surrounding context.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab, DetailRenderContext } from './types';
import type { DashboardMetrics } from '../DashboardState';
import {
  detailWidth,
  escapeBlessed,
  fmtNum,
  formatTime,
  sectionHeader,
  wordWrap,
} from '../formatters';
import { truncateTagged } from '../blessedText';
import { formatCost, highlightEvent } from 'sidekick-shared';

const EVENT_TYPE_BADGES: Record<string, string> = {
  user: '{green-fg}[USR]{/green-fg}',
  assistant: '{blue-fg}[AST]{/blue-fg}',
  tool_use: '{cyan-fg}[TOOL]{/cyan-fg}',
  tool_result: '{yellow-fg}[RES]{/yellow-fg}',
  summary: '{grey-fg}[SUM]{/grey-fg}',
  system: '{grey-fg}[SYS]{/grey-fg}',
};

export class EventStreamPanel implements SidePanel {
  readonly id = 'events';
  readonly title = 'Events';
  readonly shortTitle = 'Evt';
  readonly shortcutKey = 7;
  readonly emptyStateHint = 'Events will appear here as the session runs.';

  readonly detailTabs: DetailTab[] = [
    { label: 'Full Event', render: (item, m, _sd, ctx) => this.renderFullEvent(item, m, ctx) },
    { label: 'Context', render: (item, m, _sd, ctx) => this.renderContext(item, m, ctx) },
  ];

  getItems(metrics: DashboardMetrics): PanelItem[] {
    const events = metrics.timeline;
    if (events.length === 0) return [];

    // Ids follow the event, not its slot: once the 200-event ring is full every
    // new event shifts the list, and an index id would move the selection.
    const firstAbsolute = Math.max(0, metrics.timelineAppendCount - events.length);
    return events.map((ev, i) => {
      const time = formatTime(ev.timestamp);
      const badge = EVENT_TYPE_BADGES[ev.type] || '{grey-fg}[???]{/grey-fg}';
      const summary = highlightEvent(ev.summary || '', 'blessed');
      const label = `{grey-fg}${time}{/grey-fg} ${badge} ${summary}`;

      return {
        id: `ev-${firstAbsolute + i}`,
        label,
        sortKey: i, // chronological order
        data: { index: i, event: ev },
      };
    });
  }

  getItemTimestamp(item: PanelItem): number | null {
    const { event } = item.data as { event?: { timestamp?: string } };
    const ms = event?.timestamp ? Date.parse(event.timestamp) : NaN;
    return Number.isNaN(ms) ? null : ms;
  }

  getActions(): PanelAction[] {
    return [];
  }

  getSearchableText(item: PanelItem): string {
    const d = item.data as { event: { summary?: string; type?: string; toolName?: string } };
    return [d.event.summary, d.event.type, d.event.toolName].filter(Boolean).join(' ');
  }

  // ── Detail tab renderers ──

  private renderFullEvent(
    item: PanelItem,
    _metrics: DashboardMetrics,
    ctx?: DetailRenderContext,
  ): string {
    const d = item.data as { index: number; event: Record<string, unknown> };
    const ev = d.event;
    const w = ctx?.width ?? detailWidth();
    const lines: string[] = [];

    lines.push(sectionHeader('Event Details', w));
    lines.push('');

    // Key fields
    lines.push(`{bold}Type:{/bold}     ${ev.type || 'unknown'}`);
    lines.push(`{bold}Time:{/bold}     ${ev.timestamp || 'unknown'}`);
    if (ev.toolName) lines.push(`{bold}Tool:{/bold}     {cyan-fg}${ev.toolName}{/cyan-fg}`);
    if (ev.model) lines.push(`{bold}Model:{/bold}    ${ev.model}`);

    // Tokens
    const tokens = ev.tokens as { input?: number; output?: number } | undefined;
    const cache = ev.cacheTokens as { read?: number; write?: number } | undefined;
    if (tokens) {
      const total =
        (tokens.input ?? 0) + (tokens.output ?? 0) + (cache?.read ?? 0) + (cache?.write ?? 0);
      const breakdown = `in ${fmtNum(tokens.input ?? 0)} · cache read ${fmtNum(cache?.read ?? 0)} · cache write ${fmtNum(cache?.write ?? 0)} · out ${fmtNum(tokens.output ?? 0)}`;
      if (w >= 75) {
        lines.push(`{bold}Tokens:{/bold}   ${fmtNum(total)} total incl. cache (${breakdown})`);
      } else {
        lines.push(`{bold}Tokens:{/bold}   ${fmtNum(total)} total incl. cache`);
        for (const part of wordWrap(breakdown, Math.max(10, w - 2)).split('\n')) {
          lines.push(`  {grey-fg}${part}{/grey-fg}`);
        }
      }
      if (ev.usageKind === 'correction') {
        lines.push(
          '{grey-fg}          (top-up: a later line of this response reported more tokens){/grey-fg}',
        );
      }
    }
    // An event's cost is the provider-reported figure (OpenCode), never an estimate.
    if (typeof ev.cost === 'number') {
      lines.push(`{bold}Cost:{/bold}     ${formatCost(ev.cost)}`);
    }

    lines.push('');
    lines.push(sectionHeader('Summary', w));
    lines.push('');
    const summary = String(ev.summary || '(no summary)');
    lines.push(wordWrap(highlightEvent(summary, 'blessed'), w));

    // Raw JSON
    lines.push('');
    lines.push(sectionHeader('Raw JSON', w));
    lines.push('');
    try {
      const json = JSON.stringify(ev, null, 2);
      const jsonLines = json.split('\n');
      // Escaped: JSON braces are data, not style tags. Long lines wrap in the
      // pane with a hanging indent that follows the JSON nesting.
      for (const jl of jsonLines) {
        lines.push(`{grey-fg}${escapeBlessed(jl)}{/grey-fg}`);
      }
    } catch {
      lines.push('{grey-fg}(could not serialize){/grey-fg}');
    }

    return lines.join('\n');
  }

  private renderContext(
    item: PanelItem,
    metrics: DashboardMetrics,
    ctx?: DetailRenderContext,
  ): string {
    const d = item.data as { index: number };
    const idx = d.index;
    const events = metrics.timeline;
    const w = ctx?.width ?? detailWidth();
    const lines: string[] = [];

    lines.push(sectionHeader('Surrounding Context', w));
    lines.push('');

    // Show 3 events before, current (highlighted), 3 events after
    const start = Math.max(0, idx - 3);
    const end = Math.min(events.length - 1, idx + 3);

    for (let i = start; i <= end; i++) {
      const ev = events[i];
      const time = formatTime(ev.timestamp);
      const badge = EVENT_TYPE_BADGES[ev.type] || '{grey-fg}[???]{/grey-fg}';
      const summary = highlightEvent(ev.summary || '', 'blessed');

      if (i === idx) {
        lines.push(
          truncateTagged(`{bold}{magenta-fg}▸ ${time} ${badge} ${summary}{/magenta-fg}{/bold}`, w),
        );
      } else {
        lines.push(truncateTagged(`  {grey-fg}${time}{/grey-fg} ${badge} ${summary}`, w));
      }
    }

    if (start === 0 && end === events.length - 1 && events.length <= 7) {
      lines.push('');
      lines.push('{grey-fg}(showing all available events){/grey-fg}');
    }

    return lines.join('\n');
  }
}
