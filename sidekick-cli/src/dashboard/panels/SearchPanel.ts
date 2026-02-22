/**
 * Search panel — full-text search across sessions.
 * When active, `/` acts as a search query (not just a filter).
 * Results come from searchSessions() in sidekick-shared.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab } from './types';
import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import { shortenPath, wordWrap, detailWidth } from '../formatters';

interface SearchResultData {
  snippet: string;
  eventType: string;
  timestamp: string;
  sessionPath: string;
  projectPath: string;
}

export class SearchPanel implements SidePanel {
  readonly id = 'search';
  readonly title = 'Search';
  readonly shortcutKey = 6;

  private results: SearchResultData[] = [];
  private lastQuery = '';

  readonly detailTabs: DetailTab[] = [
    { label: 'Match', render: (item) => this.renderMatch(item) },
    { label: 'Session', render: (item) => this.renderSession(item) },
  ];

  getItems(_metrics: DashboardMetrics, _staticData: StaticData): PanelItem[] {
    if (this.results.length === 0) {
      if (!this.lastQuery) {
        return [{
          id: 'hint',
          label: '{grey-fg}Press / to search...{/grey-fg}',
          sortKey: 0,
          data: null,
        }];
      }
      return [{
        id: 'no-results',
        label: '{grey-fg}(no results){/grey-fg}',
        sortKey: 0,
        data: null,
      }];
    }

    return this.results.map((r, i) => {
      const preview = r.snippet.length > 40 ? r.snippet.substring(0, 37) + '...' : r.snippet;
      const typeTag = r.eventType ? `{grey-fg}[${r.eventType}]{/grey-fg} ` : '';
      return {
        id: `search-${i}`,
        label: `${typeTag}${preview}`,
        sortKey: i,
        data: r,
      };
    });
  }

  getActions(): PanelAction[] {
    return [];
  }

  getStatusHints(): string {
    const queryHint = this.lastQuery ? `  {grey-fg}query: "${this.lastQuery}"{/grey-fg}` : '';
    return `{bold}/{/bold} search${queryHint}`;
  }

  /**
   * Called externally to update search results.
   * The dashboard command can hook into the filter callback to trigger searches.
   */
  setResults(results: SearchResultData[], query: string): void {
    this.results = results;
    this.lastQuery = query;
  }

  // ── Detail renderers ──

  private renderMatch(item: PanelItem): string {
    const r = item.data as SearchResultData | null;
    if (!r) return '{grey-fg}Press / to search across sessions{/grey-fg}';

    return [
      '{bold}Match{/bold}',
      '',
      `{bold}Type:{/bold}  ${r.eventType}`,
      `{bold}Time:{/bold}  ${r.timestamp}`,
      '',
      '{bold}Content{/bold}',
      wordWrap(r.snippet, detailWidth()),
    ].join('\n');
  }

  private renderSession(item: PanelItem): string {
    const r = item.data as SearchResultData | null;
    if (!r) return '{grey-fg}(no session info){/grey-fg}';

    return [
      '{bold}Session Info{/bold}',
      '',
      `{bold}Session:{/bold}  ${shortenPath(r.sessionPath)}`,
      `{bold}Project:{/bold}  ${r.projectPath}`,
    ].join('\n');
  }
}

