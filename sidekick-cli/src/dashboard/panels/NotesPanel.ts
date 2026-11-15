/**
 * Notes panel — knowledge notes from persisted data.
 * Read-only: displays notes grouped by file with detail view.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab, DetailRenderContext } from './types';
import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { KnowledgeNote } from 'sidekick-shared';
import { escapeBlessed, shortenPath, wordWrap, detailWidth } from '../formatters';

/** Notes that should not be trusted as-is read differently from active ones. */
const STATUS_BADGE: Record<string, string> = {
  needs_review: '{yellow-fg}[review]{/yellow-fg}',
  stale: '{yellow-fg}[stale]{/yellow-fg}',
  obsolete: '{grey-fg}[obsolete]{/grey-fg}',
};

const NOTE_ICON: Record<string, string> = {
  gotcha: '{red-fg}!{/red-fg}',
  pattern: '{cyan-fg}~{/cyan-fg}',
  guideline: '{green-fg}#{/green-fg}',
  tip: '{yellow-fg}@{/yellow-fg}',
};

export class NotesPanel implements SidePanel {
  readonly id = 'notes';
  readonly title = 'Notes';
  readonly shortTitle = 'Note';
  readonly shortcutKey = 4;
  readonly emptyStateHint = 'Knowledge notes saved by your agent appear here.';

  readonly detailTabs: DetailTab[] = [
    { label: 'Content', render: (item, _m, _sd, ctx) => this.renderContent(item, ctx) },
    { label: 'Related', render: (item, _m, sd, ctx) => this.renderRelated(item, sd, ctx) },
  ];

  getItems(_metrics: DashboardMetrics, staticData: StaticData): PanelItem[] {
    return staticData.notes.map((n, i) => {
      const icon = NOTE_ICON[n.noteType] || ' ';
      const text = n.title?.trim() || n.content;
      const preview = text.length > 40 ? text.substring(0, 37) + '...' : text;
      const badge = STATUS_BADGE[n.status] ? `${STATUS_BADGE[n.status]} ` : '';
      return {
        id: `note-${i}`,
        label: `${icon} ${badge}${escapeBlessed(preview)}`,
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
    return [n.title ?? '', n.content, n.noteType, n.status, n.filePath, ...(n.tags || [])].join(
      ' ',
    );
  }

  // ── Detail renderers ──

  private renderContent(item: PanelItem, ctx?: DetailRenderContext): string {
    const n = item.data as KnowledgeNote;
    const icon = NOTE_ICON[n.noteType] || '';
    const lines = [
      `{bold}[${n.noteType}]{/bold} ${icon}${n.title ? ` {bold}${escapeBlessed(n.title)}{/bold}` : ''}`,
      '',
      `{bold}File:{/bold}       ${n.filePath || '(global)'}`,
      `{bold}Status:{/bold}     ${STATUS_BADGE[n.status] ?? 'active'}`,
      `{bold}Importance:{/bold} ${n.importance || 'normal'}`,
      '',
      '{bold}Content{/bold}',
      wordWrap(n.content, ctx?.width ?? detailWidth()),
    ];

    if (n.tags && n.tags.length > 0) {
      lines.push('', `{bold}Tags:{/bold} ${n.tags.join(', ')}`);
    }

    return lines.join('\n');
  }

  private renderRelated(
    item: PanelItem,
    staticData: StaticData,
    ctx?: DetailRenderContext,
  ): string {
    const n = item.data as KnowledgeNote;
    if (!n.filePath) return '{grey-fg}(global note — no file-specific relations){/grey-fg}';

    const related = staticData.notes.filter(
      (other) => other !== n && other.filePath === n.filePath,
    );

    if (related.length === 0) {
      return '{grey-fg}(no other notes for this file){/grey-fg}';
    }

    const lines = [`{bold}Other notes for ${shortenPath(n.filePath)}{/bold}`, ''];
    for (const r of related) {
      const icon = NOTE_ICON[r.noteType] || ' ';
      const preview = wordWrap(r.content, (ctx?.width ?? detailWidth()) - 6);
      lines.push(`${icon} {bold}[${r.noteType}]{/bold} ${preview}`);
    }

    return lines.join('\n');
  }
}
