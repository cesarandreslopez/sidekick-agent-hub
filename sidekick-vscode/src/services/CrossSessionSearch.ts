/**
 * @fileoverview Cross-session search service.
 *
 * Provides full-text search across all session files for the active provider.
 * Uses VS Code QuickPick for interactive search
 * with context snippets and session navigation.
 *
 * @module services/CrossSessionSearch
 */

import * as vscode from 'vscode';
import * as os from 'os';
import { searchSessions, type SearchResult } from 'sidekick-shared';
import { log } from './Logger';
import type { SessionProvider } from '../types/sessionProvider';

/**
 * Provides cross-session text search using VS Code QuickPick.
 */
export class CrossSessionSearch implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _sessionMonitor: {
      getSessionPath(): string | null;
      getProvider(): SessionProvider;
    },
  ) {}

  /**
   * Opens the cross-session search QuickPick.
   */
  async search(): Promise<void> {
    const quickPick = vscode.window.createQuickPick<SearchResultItem>();
    const provider = this._sessionMonitor.getProvider();
    quickPick.placeholder = `Search across all ${provider.displayName} sessions...`;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let searchGeneration = 0;
    let searchController: AbortController | undefined;

    quickPick.onDidChangeValue((query) => {
      searchGeneration++;
      searchController?.abort();
      const generation = searchGeneration;
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = undefined;
      }
      if (query.length < 3) {
        quickPick.items = [];
        quickPick.busy = false;
        return;
      }
      quickPick.busy = true;
      const controller = new AbortController();
      searchController = controller;
      searchTimer = setTimeout(async () => {
        searchTimer = undefined;
        try {
          const results = await searchSessions(provider, query, {
            maxResults: 50,
            signal: controller.signal,
          });
          if (generation === searchGeneration) {
            quickPick.items = results.map((r) => new SearchResultItem(r));
          }
        } catch (error) {
          if (generation === searchGeneration) {
            quickPick.items = [];
            quickPick.placeholder = 'Search failed. Use Sidekick: Run Doctor for details.';
            log(`CrossSessionSearch error: ${error}`);
          }
        } finally {
          if (generation === searchGeneration) quickPick.busy = false;
        }
      }, 300);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        // The conversation viewer can read both files and synthetic database paths.
        vscode.commands.executeCommand('sidekick.openConversation', selected.result.sessionPath);
      }
      quickPick.hide();
    });

    quickPick.onDidHide(() => {
      searchGeneration++;
      searchController?.abort();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = undefined;
      quickPick.busy = false;
      quickPick.dispose();
    });
    quickPick.show();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

/**
 * QuickPick item wrapping a SearchResult.
 */
class SearchResultItem implements vscode.QuickPickItem {
  label: string;
  description: string;
  detail: string;

  constructor(public readonly result: SearchResult) {
    // Show event type icon + snippet
    const icon =
      result.eventType === 'user'
        ? '$(person)'
        : result.eventType === 'assistant'
          ? '$(hubot)'
          : result.eventType === 'tool_use'
            ? '$(tools)'
            : '$(file)';

    this.label = `${icon} ${result.snippet}`;

    // Show project + timestamp
    const displayPath = result.projectPath.replace(os.homedir(), '~');
    const time = result.timestamp ? new Date(result.timestamp).toLocaleString() : '';
    this.description = displayPath;
    this.detail = time;
  }
}
