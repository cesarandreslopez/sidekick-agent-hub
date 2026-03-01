/**
 * Event Stream panel — scrollable, auto-tailing view of raw session events.
 *
 * Each item = one FollowEvent with timestamp, type badge, and highlighted summary.
 * Detail tabs show full event JSON and surrounding context.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab } from './types';
import type { DashboardMetrics } from '../DashboardState';
import { formatTime, sectionHeader, wordWrap, detailWidth } from '../formatters';
import { highlightEvent } from 'sidekick-shared';

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
  readonly shortcutKey = 7;
  readonly emptyStateHint = 'Events will appear here as the session runs.';

  readonly detailTabs: DetailTab[] = [
    { label: 'Full Event', render: (item, m) => this.renderFullEvent(item, m) },
    { label: 'Context', render: (item, m) => this.renderContext(item, m) },
  ];

  getItems(metrics: DashboardMetrics): PanelItem[] {
    const events = metrics.timeline;
    if (events.length === 0) return [];

    return events.map((ev, i) => {
      const time = formatTime(ev.timestamp);
      const badge = EVENT_TYPE_BADGES[ev.type] || '{grey-fg}[???]{/grey-fg}';
      const summary = highlightEvent(ev.summary || '', 'blessed');
      const label = `{grey-fg}${time}{/grey-fg} ${badge} ${summary}`;

      return {
        id: `ev-${i}`,
        label,
        sortKey: i, // chronological order
        data: { index: i, event: ev },
      };
    });
  }

  getActions(): PanelAction[] {
    return [];
  }

  getSearchableText(item: PanelItem): string {
    const d = item.data as { event: { summary?: string; type?: string; toolName?: string } };
    return [d.event.summary, d.event.type, d.event.toolName].filter(Boolean).join(' ');
  }

  // ── Detail tab renderers ──

  private renderFullEvent(item: PanelItem, _metrics: DashboardMetrics): string {
    const d = item.data as { index: number; event: Record<string, unknown> };
    const ev = d.event;
    const w = detailWidth();
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
    if (tokens) {
      lines.push(`{bold}Tokens:{/bold}   in=${tokens.input ?? 0}  out=${tokens.output ?? 0}`);
    }
    if (typeof ev.cost === 'number') {
      lines.push(`{bold}Cost:{/bold}     $${(ev.cost as number).toFixed(4)}`);
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
      for (const jl of jsonLines) {
        lines.push(`{grey-fg}${jl}{/grey-fg}`);
      }
    } catch {
      lines.push('{grey-fg}(could not serialize){/grey-fg}');
    }

    return lines.join('\n');
  }

  private renderContext(item: PanelItem, metrics: DashboardMetrics): string {
    const d = item.data as { index: number };
    const idx = d.index;
    const events = metrics.timeline;
    const w = detailWidth();
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
        lines.push(`{bold}{magenta-fg}▸ ${time} ${badge} ${summary}{/magenta-fg}{/bold}`);
      } else {
        lines.push(`  {grey-fg}${time}{/grey-fg} ${badge} ${summary}`);
      }
    }

    if (start === 0 && end === events.length - 1 && events.length <= 7) {
      lines.push('');
      lines.push('{grey-fg}(showing all available events){/grey-fg}');
    }

    return lines.join('\n');
  }
}
