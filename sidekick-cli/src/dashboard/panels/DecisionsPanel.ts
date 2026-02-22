/**
 * Decisions panel — persisted decision log.
 * Read-only: shows description, rationale, alternatives, tags.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab } from './types';
import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { DecisionEntry } from 'sidekick-shared';
import { wordWrap, detailWidth } from '../formatters';

export class DecisionsPanel implements SidePanel {
  readonly id = 'decisions';
  readonly title = 'Decisions';
  readonly shortcutKey = 5;

  readonly detailTabs: DetailTab[] = [
    { label: 'Detail', render: (item) => this.renderDetail(item) },
  ];

  getItems(_metrics: DashboardMetrics, staticData: StaticData): PanelItem[] {
    return staticData.decisions.map((d, i) => {
      const preview = d.description.length > 45 ? d.description.substring(0, 42) + '...' : d.description;
      return {
        id: `dec-${i}`,
        label: preview,
        sortKey: i,
        data: d,
      };
    });
  }

  getActions(): PanelAction[] {
    return [];
  }

  getSearchableText(item: PanelItem): string {
    const d = item.data as DecisionEntry;
    return [d.description, d.rationale, d.chosenOption, ...(d.alternatives || []), ...(d.tags || [])].join(' ');
  }

  // ── Detail renderer ──

  private renderDetail(item: PanelItem): string {
    const d = item.data as DecisionEntry;
    const w = detailWidth();
    const lines = [
      `{bold}${wordWrap(d.description, w)}{/bold}`,
      '',
      `{bold}Chosen:{/bold}     ${d.chosenOption}`,
      '{bold}Rationale:{/bold}',
      `  ${wordWrap(d.rationale, w - 2)}`,
    ];

    if (d.alternatives && d.alternatives.length > 0) {
      lines.push('', '{bold}Alternatives Considered{/bold}');
      for (const alt of d.alternatives) {
        lines.push(`  {grey-fg}\u2022{/grey-fg} ${wordWrap(alt, w - 4)}`);
      }
    }

    if (d.tags && d.tags.length > 0) {
      lines.push('', `{bold}Tags:{/bold} ${d.tags.join(', ')}`);
    }

    if (d.timestamp) {
      lines.push('', `{grey-fg}Recorded: ${d.timestamp}{/grey-fg}`);
    }

    return lines.join('\n');
  }
}
