/**
 * Charts panel — ASCII analytics visualizations.
 *
 * Four detail tabs:
 * 1. Tool Frequency — horizontal bars of top tools
 * 2. Event Distribution — event type counts over time
 * 3. Activity Heatmap — 60-minute rolling activity display
 * 4. Patterns — detected event patterns with frequency bars
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab } from './types';
import type { DashboardMetrics } from '../DashboardState';
import { makeColorBar, makeHeatmap, makeSparkline, sectionHeader, fmtNum, detailWidth } from '../formatters';

export class ChartsPanel implements SidePanel {
  readonly id = 'charts';
  readonly title = 'Charts';
  readonly shortcutKey = 8;
  readonly emptyStateHint = 'Charts will appear as data accumulates.';

  readonly detailTabs: DetailTab[] = [
    { label: 'Tools', render: (item, m) => this.renderToolFrequency(item, m) },
    { label: 'Events', render: (item, m) => this.renderEventDistribution(item, m) },
    { label: 'Heatmap', render: (item, m) => this.renderHeatmap(item, m) },
    { label: 'Patterns', render: (item, m) => this.renderPatterns(item, m) },
  ];

  getItems(_metrics: DashboardMetrics): PanelItem[] {
    // Single item: the current session's analytics
    return [{
      id: 'analytics',
      label: '{bold}Session Analytics{/bold}',
      sortKey: 0,
      data: { type: 'analytics' },
    }];
  }

  getActions(): PanelAction[] {
    return [];
  }

  // ── Detail tab renderers ──

  private renderToolFrequency(_item: PanelItem, metrics: DashboardMetrics): string {
    const w = detailWidth();
    const lines: string[] = [];
    lines.push(sectionHeader('Tool Frequency', w));
    lines.push('');

    const toolFreq = metrics.toolFrequency;
    if (!toolFreq || toolFreq.length === 0) {
      lines.push('{grey-fg}(no tool usage data yet){/grey-fg}');
      return lines.join('\n');
    }

    const top = toolFreq.slice(0, 15);
    const maxCount = top[0]?.count ?? 1;
    const maxNameLen = Math.min(20, Math.max(...top.map(t => t.name.length)));
    const barWidth = Math.max(10, w - maxNameLen - 15);

    for (const tool of top) {
      const name = tool.name.padEnd(maxNameLen);
      const percent = (tool.count / maxCount) * 100;
      const bar = makeColorBar(percent, barWidth, 'cyan');
      const count = fmtNum(tool.count).padStart(6);
      lines.push(`{cyan-fg}${name}{/cyan-fg} ${bar} ${count}`);
    }

    lines.push('');
    lines.push(`{grey-fg}Total unique tools: ${toolFreq.length}{/grey-fg}`);

    return lines.join('\n');
  }

  private renderEventDistribution(_item: PanelItem, metrics: DashboardMetrics): string {
    const w = detailWidth();
    const lines: string[] = [];
    lines.push(sectionHeader('Event Distribution', w));
    lines.push('');

    // Count events by type from timeline
    const typeCounts = new Map<string, number>();
    for (const ev of metrics.timeline) {
      typeCounts.set(ev.type, (typeCounts.get(ev.type) ?? 0) + 1);
    }

    if (typeCounts.size === 0) {
      lines.push('{grey-fg}(no events yet){/grey-fg}');
      return lines.join('\n');
    }

    const total = metrics.timeline.length;
    const sorted = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]);
    const colors: Record<string, string> = {
      user: 'green',
      assistant: 'blue',
      tool_use: 'cyan',
      tool_result: 'yellow',
      summary: 'grey',
      system: 'grey',
    };

    const barWidth = Math.max(10, w - 25);
    for (const [type, count] of sorted) {
      const pct = (count / total) * 100;
      const color = colors[type] || 'white';
      const label = type.padEnd(12);
      const bar = makeColorBar(pct, barWidth, color);
      const countStr = `${fmtNum(count)} (${pct.toFixed(0)}%)`;
      lines.push(`{${color}-fg}${label}{/${color}-fg} ${bar} ${countStr}`);
    }

    lines.push('');
    lines.push(`{grey-fg}Total events: ${fmtNum(total)}{/grey-fg}`);

    // Burn rate sparkline
    if (metrics.burnRate.length > 1) {
      lines.push('');
      lines.push(sectionHeader('Burn Rate', w));
      lines.push('');
      const { spark, max, latest } = makeSparkline(metrics.burnRate, Math.min(w - 10, 50));
      lines.push(`{cyan-fg}${spark}{/cyan-fg}  {grey-fg}max: ${fmtNum(max)} | latest: ${fmtNum(latest)} tok/min{/grey-fg}`);
    }

    return lines.join('\n');
  }

  private renderHeatmap(_item: PanelItem, metrics: DashboardMetrics): string {
    const w = detailWidth();
    const lines: string[] = [];
    lines.push(sectionHeader('Activity Heatmap (60 min)', w));
    lines.push('');

    const buckets = metrics.heatmapBuckets;
    if (!buckets || buckets.length === 0) {
      lines.push('{grey-fg}(no activity data yet){/grey-fg}');
      return lines.join('\n');
    }

    lines.push(makeHeatmap(buckets, Math.min(w - 5, 60)));
    lines.push('');

    // Stats
    const maxCount = Math.max(...buckets.map(b => b.count));
    const totalEvents = buckets.reduce((sum, b) => sum + b.count, 0);
    const activeMins = buckets.filter(b => b.count > 0).length;

    lines.push('{grey-fg}Legend: \u2591 low  \u2592 medium  \u2593 high  \u2588 peak{/grey-fg}');
    lines.push('');
    lines.push(`{bold}Peak:{/bold}    ${fmtNum(maxCount)} events/min`);
    lines.push(`{bold}Total:{/bold}   ${fmtNum(totalEvents)} events`);
    lines.push(`{bold}Active:{/bold}  ${activeMins}/${buckets.length} minutes`);

    return lines.join('\n');
  }

  private renderPatterns(_item: PanelItem, metrics: DashboardMetrics): string {
    const w = detailWidth();
    const lines: string[] = [];
    lines.push(sectionHeader('Event Patterns', w));
    lines.push('');

    const patterns = metrics.patterns;
    if (!patterns || patterns.length === 0) {
      lines.push('{grey-fg}(patterns emerge after repeated events){/grey-fg}');
      return lines.join('\n');
    }

    const top = patterns.slice(0, 12);
    const maxCount = top[0]?.count ?? 1;
    const barWidth = Math.max(8, Math.floor(w * 0.3));

    for (const pattern of top) {
      const pct = (pattern.count / maxCount) * 100;
      const bar = makeColorBar(pct, barWidth, 'magenta');
      const count = fmtNum(pattern.count).padStart(5);
      lines.push(`${bar} ${count}  {magenta-fg}${pattern.template}{/magenta-fg}`);

      // Show first example in grey
      if (pattern.examples.length > 0) {
        const example = pattern.examples[0].length > w - 15
          ? pattern.examples[0].substring(0, w - 18) + '...'
          : pattern.examples[0];
        lines.push(`${''.padStart(barWidth + 8)}{grey-fg}e.g. ${example}{/grey-fg}`);
      }
    }

    lines.push('');
    lines.push(`{grey-fg}Total patterns: ${patterns.length} (showing top ${top.length}){/grey-fg}`);

    return lines.join('\n');
  }
}
