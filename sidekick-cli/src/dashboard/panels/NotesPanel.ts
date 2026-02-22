/**
 * Notes panel — knowledge notes from persisted data.
 * Read-only: displays notes grouped by file with detail view.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab } from './types';
import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { KnowledgeNote } from 'sidekick-shared';
import { shortenPath, wordWrap, detailWidth } from '../formatters';

const NOTE_ICON: Record<string, string> = {
  gotcha: '{red-fg}!{/red-fg}',
  pattern: '{cyan-fg}~{/cyan-fg}',
  guideline: '{green-fg}#{/green-fg}',
  convention: '{yellow-fg}@{/yellow-fg}',
};

export class NotesPanel implements SidePanel {
  readonly id = 'notes';
  readonly title = 'Notes';
  readonly shortcutKey = 4;

  readonly detailTabs: DetailTab[] = [
    { label: 'Content', render: (item) => this.renderContent(item) },
    { label: 'Related', render: (item, _m, sd) => this.renderRelated(item, sd) },
  ];

  getItems(_metrics: DashboardMetrics, staticData: StaticData): PanelItem[] {
    return staticData.notes.map((n, i) => {
      const icon = NOTE_ICON[n.noteType] || ' ';
      const preview = n.content.length > 40 ? n.content.substring(0, 37) + '...' : n.content;
      return {
        id: `note-${i}`,
        label: `${icon} ${preview}`,
        sortKey: i,
        data: n,
      };
    });
  }

  getActions(): PanelAction[] {
    return [];
  }

  getSearchableText(item: PanelItem): string {
    const n = item.data as KnowledgeNote;
    return [n.content, n.noteType, n.filePath, ...(n.tags || [])].join(' ');
  }

  // ── Detail renderers ──

  private renderContent(item: PanelItem): string {
    const n = item.data as KnowledgeNote;
    const icon = NOTE_ICON[n.noteType] || '';
    const lines = [
      `{bold}[${n.noteType}]{/bold} ${icon}`,
      '',
      `{bold}File:{/bold}       ${n.filePath || '(global)'}`,
      `{bold}Importance:{/bold} ${n.importance || 'normal'}`,
      '',
      '{bold}Content{/bold}',
      wordWrap(n.content, detailWidth()),
    ];

    if (n.tags && n.tags.length > 0) {
      lines.push('', `{bold}Tags:{/bold} ${n.tags.join(', ')}`);
    }

    return lines.join('\n');
  }

  private renderRelated(item: PanelItem, staticData: StaticData): string {
    const n = item.data as KnowledgeNote;
    if (!n.filePath) return '{grey-fg}(global note — no file-specific relations){/grey-fg}';

    const related = staticData.notes.filter(
      other => other !== n && other.filePath === n.filePath
    );

    if (related.length === 0) {
      return '{grey-fg}(no other notes for this file){/grey-fg}';
    }

    const lines = [`{bold}Other notes for ${shortenPath(n.filePath)}{/bold}`, ''];
    for (const r of related) {
      const icon = NOTE_ICON[r.noteType] || ' ';
      const preview = wordWrap(r.content, detailWidth() - 6);
      lines.push(`${icon} {bold}[${r.noteType}]{/bold} ${preview}`);
    }

    return lines.join('\n');
  }
}

