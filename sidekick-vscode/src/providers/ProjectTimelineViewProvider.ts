/**
 * @fileoverview Project timeline webview provider.
 *
 * Displays a chronological timeline of all sessions for the current project
 * with time-range filtering, session bars, and expandable detail panels.
 *
 * @module providers/ProjectTimelineViewProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import { ProjectTimelineDataService } from '../services/ProjectTimelineDataService';
import type {
  ProjectTimelineState,
  ProjectTimelineMessage,
  WebviewTimelineMessage,
  TimelineRange,
} from '../types/projectTimeline';
import { log } from '../services/Logger';
import { getNonce } from '../utils/nonce';
import { getRandomPhrase } from '../utils/phrases';

/**
 * WebviewViewProvider for the multi-session project timeline.
 */
export class ProjectTimelineViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sidekick.projectTimeline';

  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];
  private _dataService: ProjectTimelineDataService;
  private _currentRange: TimelineRange = '7d';
  private _refreshTimer?: ReturnType<typeof setTimeout>;

  /** Interval for rotating header phrase */
  private _phraseInterval?: ReturnType<typeof setInterval>;

  /** Interval for rotating empty-state phrase */
  private _emptyPhraseInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionMonitor: SessionMonitor
  ) {
    this._dataService = new ProjectTimelineDataService(this._sessionMonitor.getProvider());

    // Subscribe to session events
    this._disposables.push(
      this._sessionMonitor.onSessionStart(() => this._debouncedRefresh()),
      this._sessionMonitor.onSessionEnd(() => this._debouncedRefresh()),
      this._sessionMonitor.onTokenUsage(() => this._debouncedRefresh())
    );

    log('ProjectTimelineViewProvider initialized');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'out', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'images')
      ]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewTimelineMessage) => this._handleWebviewMessage(message),
      undefined,
      this._disposables
    );

    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._sendTimeline();
        }
      },
      undefined,
      this._disposables
    );

    this._startPhraseTimers();
    log('Project timeline webview resolved');
  }

  private _startPhraseTimers(): void {
    this._clearPhraseTimers();
    this._phraseInterval = setInterval(() => {
      this._postMessage({ type: 'updatePhrase', phrase: getRandomPhrase() });
    }, 60_000);
    this._emptyPhraseInterval = setInterval(() => {
      this._postMessage({ type: 'updateEmptyPhrase', phrase: getRandomPhrase() });
    }, 30_000);
  }

  private _clearPhraseTimers(): void {
    if (this._phraseInterval) { clearInterval(this._phraseInterval); this._phraseInterval = undefined; }
    if (this._emptyPhraseInterval) { clearInterval(this._emptyPhraseInterval); this._emptyPhraseInterval = undefined; }
  }

  private _handleWebviewMessage(message: WebviewTimelineMessage): void {
    switch (message.type) {
      case 'ready':
        this._sendTimeline();
        break;
      case 'setRange':
        this._currentRange = message.range;
        this._sendTimeline();
        break;
      case 'expandSession':
        this._sendSessionDetail(message.sessionId);
        break;
      case 'openSession':
        this._openSessionFile(message.sessionPath);
        break;
      case 'refresh':
        this._dataService.clearCache();
        this._sendTimeline();
        break;
    }
  }

  private _debouncedRefresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._sendTimeline();
    }, 10000); // 10s debounce for token usage updates
  }

  private _sendTimeline(): void {
    if (!this._view) {
      log('[Timeline] No webview view available, skipping update');
      return;
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
      log('[Timeline] No workspace folder open, skipping update');
      return;
    }

    try {
      const currentSessionPath = this._sessionMonitor.getSessionPath();
      const sessions = this._dataService.getTimelineEntries(
        workspacePath,
        this._currentRange,
        currentSessionPath
      );

      const projectName = vscode.workspace.workspaceFolders?.[0]?.name || 'Project';

      const state: ProjectTimelineState = {
        sessions,
        range: this._currentRange,
        projectName,
        lastUpdated: new Date().toISOString(),
      };

      log(`[Timeline] Sending ${sessions.length} sessions to webview`);
      this._postMessage({ type: 'updateTimeline', state });
    } catch (error) {
      log(`[Timeline] Error building timeline: ${error}`);
    }
  }

  private _sendSessionDetail(sessionId: string): void {
    // Find the session path from our cached entries
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) return;

    const currentSessionPath = this._sessionMonitor.getSessionPath();
    const sessions = this._dataService.getTimelineEntries(
      workspacePath,
      this._currentRange,
      currentSessionPath
    );

    const session = sessions.find(s => s.sessionId === sessionId);
    if (!session) return;

    const detail = this._dataService.getSessionDetail(session.sessionPath);
    if (detail) {
      this._postMessage({ type: 'sessionDetail', detail });
    }
  }

  private _openSessionFile(sessionPath: string): void {
    const uri = vscode.Uri.file(sessionPath);
    vscode.workspace.openTextDocument(uri).then(
      doc => vscode.window.showTextDocument(doc),
      () => log(`Could not open session file: ${sessionPath}`)
    );
  }

  private _postMessage(message: ProjectTimelineMessage): void {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'images', 'icon.png')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 img-src ${webview.cspSource};
                 script-src 'nonce-${nonce}';">
  <title>Project Timeline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow-y: auto;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      z-index: 10;
    }

    .header img { width: 20px; height: 20px; }
    .header h1 { font-size: 13px; font-weight: 600; }

    .header-phrase, .empty-state-phrase {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      margin: 0;
    }

    .header-phrase {
      padding: 2px 12px 6px 40px;
    }

    .range-controls {
      margin-left: auto;
      display: flex;
      gap: 4px;
    }

    .range-btn {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 3px;
      cursor: pointer;
    }

    .range-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .range-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 20px;
    }

    .empty-state p { margin-top: 8px; font-size: 12px; }

    .session-list { padding: 8px; }

    .session-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
      transition: border-color 0.15s;
    }

    .session-card:hover { border-color: var(--vscode-focusBorder); }
    .session-card.current { border-left: 3px solid var(--vscode-charts-green, #4caf50); }
    .session-card.active-session { border-left: 3px solid var(--vscode-charts-blue, #2196F3); }

    .session-header {
      padding: 10px 12px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .session-header:hover { background: var(--vscode-list-hoverBackground); }

    .session-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .session-label {
      font-weight: 600;
      font-size: 12px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-status {
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 500;
    }

    .session-status.active {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }

    .session-meta {
      display: flex;
      gap: 12px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      flex-wrap: wrap;
    }

    .meta-item { display: flex; align-items: center; gap: 3px; }

    .session-badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .badge.error { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
    .badge.tokens { background: var(--vscode-badge-background); }

    .session-detail {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 10px 12px;
      display: none;
      font-size: 11px;
    }

    .session-detail.visible { display: block; }

    .detail-section { margin-bottom: 10px; }
    .detail-section:last-child { margin-bottom: 0; }
    .detail-section h3 {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--vscode-foreground);
    }

    .detail-list { list-style: none; padding: 0; }
    .detail-list li {
      padding: 2px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    .detail-list li .count {
      color: var(--vscode-foreground);
      font-weight: 600;
    }

    .open-file-btn {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 3px;
      cursor: pointer;
      margin-top: 6px;
    }

    .open-file-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .timeline-bar {
      height: 4px;
      background: var(--vscode-charts-blue, #2196F3);
      border-radius: 2px;
      margin-top: 4px;
      min-width: 4px;
    }

    .timeline-bar.short { background: var(--vscode-descriptionForeground); opacity: 0.4; }

    .loading {
      text-align: center;
      padding: 20px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="Sidekick" />
    <h1>Timeline</h1>
    <div class="range-controls">
      <button class="range-btn" data-range="24h">24h</button>
      <button class="range-btn active" data-range="7d">7d</button>
      <button class="range-btn" data-range="30d">30d</button>
      <button class="range-btn" data-range="all">All</button>
    </div>
  </div>
  <p id="header-phrase" class="header-phrase">${getRandomPhrase()}</p>

  <div id="empty" class="empty-state" style="display: none;">
    <p>No sessions found in selected time range.</p>
    <p>Start a session or expand the time range.</p>
    <p id="empty-state-phrase" class="empty-state-phrase">${getRandomPhrase()}</p>
  </div>

  <div id="loading" class="loading" style="display: none;">Loading sessions...</div>

  <div id="session-list" class="session-list"></div>

  <script nonce="${nonce}">
  (function() {
    var vscode = acquireVsCodeApi();
    var sessionListEl = document.getElementById('session-list');
    var emptyEl = document.getElementById('empty');
    var loadingEl = document.getElementById('loading');
    var rangeButtons = document.querySelectorAll('.range-btn');
    var expandedSessions = {};

    // Range button handlers
    rangeButtons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        rangeButtons.forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        vscode.postMessage({ type: 'setRange', range: btn.dataset.range });
      });
    });

    function formatDuration(ms) {
      if (ms < 60000) return Math.round(ms / 1000) + 's';
      if (ms < 3600000) return Math.round(ms / 60000) + 'm';
      var h = Math.floor(ms / 3600000);
      var m = Math.round((ms % 3600000) / 60000);
      return h + 'h ' + m + 'm';
    }

    function formatTokens(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }

    function formatTime(iso) {
      var d = new Date(iso);
      var now = new Date();
      var sameDay = d.toDateString() === now.toDateString();
      if (sameDay) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function renderTimeline(state) {
      if (!state.sessions || state.sessions.length === 0) {
        emptyEl.style.display = 'flex';
        sessionListEl.style.display = 'none';
        loadingEl.style.display = 'none';
        return;
      }

      emptyEl.style.display = 'none';
      sessionListEl.style.display = 'block';
      loadingEl.style.display = 'none';

      // Find max duration for relative bar sizing
      var maxDuration = Math.max.apply(null, state.sessions.map(function(s) { return s.durationMs; }));

      var html = '';
      for (var i = 0; i < state.sessions.length; i++) {
        var s = state.sessions[i];
        var cardClass = 'session-card';
        if (s.isCurrent && s.isActive) cardClass += ' active-session';
        else if (s.isCurrent) cardClass += ' current';

        var barWidth = maxDuration > 0 ? Math.max(4, (s.durationMs / maxDuration) * 100) : 4;
        var barClass = s.durationMs < 60000 ? 'timeline-bar short' : 'timeline-bar';

        html += '<div class="' + cardClass + '" data-session-id="' + s.sessionId + '" data-session-path="' + escapeHtml(s.sessionPath) + '">';
        html += '<div class="session-header" onclick="toggleSession(this)">';

        // Title row
        html += '<div class="session-title-row">';
        html += '<span class="session-label">' + escapeHtml(s.label) + '</span>';
        if (s.isActive) {
          html += '<span class="session-status active">Active</span>';
        }
        html += '</div>';

        // Duration bar
        html += '<div class="' + barClass + '" style="width: ' + barWidth + '%;"></div>';

        // Meta row
        html += '<div class="session-meta">';
        html += '<span class="meta-item">' + formatTime(s.startTime) + '</span>';
        html += '<span class="meta-item">' + formatDuration(s.durationMs) + '</span>';
        html += '<span class="meta-item">' + s.messageCount + ' msgs</span>';
        html += '</div>';

        // Badges
        html += '<div class="session-badges">';
        html += '<span class="badge tokens">' + formatTokens(s.totalTokens) + ' tokens</span>';
        if (s.taskCount > 0) {
          html += '<span class="badge">' + s.taskCount + ' task' + (s.taskCount > 1 ? 's' : '') + '</span>';
        }
        if (s.errorCount > 0) {
          html += '<span class="badge error">' + s.errorCount + ' error' + (s.errorCount > 1 ? 's' : '') + '</span>';
        }
        if (s.models.length > 0) {
          html += '<span class="badge">' + escapeHtml(s.models[0].split('/').pop() || s.models[0]) + '</span>';
        }
        html += '</div>';

        html += '</div>'; // session-header

        // Detail section (hidden by default)
        var detailVisible = expandedSessions[s.sessionId] ? ' visible' : '';
        html += '<div class="session-detail' + detailVisible + '" id="detail-' + s.sessionId + '">';
        if (expandedSessions[s.sessionId]) {
          html += renderDetailContent(expandedSessions[s.sessionId]);
        } else {
          html += '<div class="loading">Loading details...</div>';
        }
        html += '</div>';

        html += '</div>'; // session-card
      }

      sessionListEl.innerHTML = html;
    }

    function renderDetailContent(detail) {
      var html = '';

      // Key files
      if (detail.toolBreakdown && detail.toolBreakdown.length > 0) {
        html += '<div class="detail-section">';
        html += '<h3>Tool Usage</h3>';
        html += '<ul class="detail-list">';
        var tools = detail.toolBreakdown.slice(0, 8);
        for (var i = 0; i < tools.length; i++) {
          html += '<li><span class="count">' + tools[i].calls + 'x</span> ' + escapeHtml(tools[i].tool) + '</li>';
        }
        html += '</ul></div>';
      }

      // Tasks
      if (detail.tasks && detail.tasks.length > 0) {
        html += '<div class="detail-section">';
        html += '<h3>Tasks (' + detail.tasks.length + ')</h3>';
        html += '<ul class="detail-list">';
        for (var j = 0; j < detail.tasks.length && j < 5; j++) {
          html += '<li>' + escapeHtml(detail.tasks[j].subject) + ' <span class="count">(' + detail.tasks[j].status + ')</span></li>';
        }
        html += '</ul></div>';
      }

      // Errors
      if (detail.errors && detail.errors.length > 0) {
        html += '<div class="detail-section">';
        html += '<h3>Errors</h3>';
        html += '<ul class="detail-list">';
        for (var k = 0; k < detail.errors.length; k++) {
          html += '<li><span class="count">' + detail.errors[k].count + 'x</span> ' + escapeHtml(detail.errors[k].category) + '</li>';
        }
        html += '</ul></div>';
      }

      return html;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Toggle session detail (exposed globally for onclick)
    window.toggleSession = function(headerEl) {
      var card = headerEl.closest('.session-card');
      var sessionId = card.dataset.sessionId;
      var detailEl = document.getElementById('detail-' + sessionId);

      if (detailEl.classList.contains('visible')) {
        detailEl.classList.remove('visible');
        delete expandedSessions[sessionId];
      } else {
        detailEl.classList.add('visible');
        if (!expandedSessions[sessionId]) {
          vscode.postMessage({ type: 'expandSession', sessionId: sessionId });
        }
      }
    };

    // Handle messages from extension
    window.addEventListener('message', function(event) {
      var message = event.data;
      switch (message.type) {
        case 'updateTimeline':
          renderTimeline(message.state);
          break;
        case 'sessionDetail':
          expandedSessions[message.detail.sessionId] = message.detail;
          var detailEl = document.getElementById('detail-' + message.detail.sessionId);
          if (detailEl) {
            detailEl.innerHTML = renderDetailContent(message.detail);
          }
          break;
        case 'loading':
          loadingEl.style.display = message.loading ? 'block' : 'none';
          break;
        case 'updatePhrase':
          var hp = document.getElementById('header-phrase');
          if (hp) hp.textContent = message.phrase;
          break;
        case 'updateEmptyPhrase':
          var ep = document.getElementById('empty-state-phrase');
          if (ep) ep.textContent = message.phrase;
          break;
      }
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  })();
  </script>
</body>
</html>`;
  }

  dispose(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._clearPhraseTimers();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    log('ProjectTimelineViewProvider disposed');
  }
}
