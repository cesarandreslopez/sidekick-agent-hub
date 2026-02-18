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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from './Logger';
import type { SessionProvider } from '../types/sessionProvider';

/** Search result with context */
interface SearchResult {
  /** Session file path */
  sessionPath: string;
  /** Project path (decoded from directory name) */
  projectPath: string;
  /** Matched line content (truncated) */
  snippet: string;
  /** Event type (user, assistant, tool_use, etc.) */
  eventType: string;
  /** Timestamp of the matching event */
  timestamp: string;
}

/**
 * Provides cross-session text search using VS Code QuickPick.
 */
export class CrossSessionSearch implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _sessionMonitor: { getSessionPath(): string | null; getProvider(): SessionProvider }
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

    quickPick.onDidChangeValue(query => {
      if (searchTimer) clearTimeout(searchTimer);
      if (query.length < 3) {
        quickPick.items = [];
        return;
      }
      quickPick.busy = true;
      searchTimer = setTimeout(async () => {
        const results = await this.performSearch(query);
        quickPick.items = results.map(r => new SearchResultItem(r));
        quickPick.busy = false;
      }, 300);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        // Open the session file at the matching location
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(selected.result.sessionPath));
      }
      quickPick.hide();
    });

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
  }

  /**
   * Searches across all session files for the given query.
   */
  private async performSearch(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const provider = this._sessionMonitor.getProvider();
    const projectsDir = provider.getProjectsBaseDir();
    const MAX_RESULTS = 50;
    const MAX_FILES_PER_PROJECT = 20;

    try {
      if (!fs.existsSync(projectsDir)) return results;

      const projectDirs = fs.readdirSync(projectsDir);

      for (const projectDir of projectDirs) {
        if (results.length >= MAX_RESULTS) break;

        const projectPath = path.join(projectsDir, projectDir);
        try {
          const stat = fs.statSync(projectPath);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }

        // Find session files in this project directory
        const sessionFiles = provider.findSessionsInDirectory(projectPath)
          .slice(0, MAX_FILES_PER_PROJECT);

        for (const filePath of sessionFiles) {
          if (results.length >= MAX_RESULTS) break;

          const remaining = MAX_RESULTS - results.length;
          const hits = provider.searchInSession(filePath, query, remaining);

          for (const hit of hits) {
            if (results.length >= MAX_RESULTS) break;

            const displayPath = hit.projectPath || this.decodeProjectPath(projectDir);

            results.push({
              sessionPath: hit.sessionPath,
              projectPath: displayPath,
              snippet: hit.line,
              eventType: hit.eventType,
              timestamp: hit.timestamp
            });
          }
        }
      }
    } catch (err) {
      log(`CrossSessionSearch error: ${err}`);
    }

    return results;
  }

  /**
   * Decodes an encoded project path directory name.
   */
  private decodeProjectPath(encoded: string): string {
    // Project dirs are encoded as: -home-user-code-myproject
    return encoded.replace(/^-/, '/').replace(/-/g, '/');
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
    const icon = result.eventType === 'user' ? '$(person)' :
      result.eventType === 'assistant' ? '$(hubot)' :
      result.eventType === 'tool_use' ? '$(tools)' : '$(file)';

    this.label = `${icon} ${result.snippet}`;

    // Show project + timestamp
    const displayPath = result.projectPath.replace(os.homedir(), '~');
    const time = result.timestamp ? new Date(result.timestamp).toLocaleString() : '';
    this.description = displayPath;
    this.detail = time;
  }
}
