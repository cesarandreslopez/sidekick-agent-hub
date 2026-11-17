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
import * as fs from 'fs';
import type {
  ProjectTimelineState,
  ProjectTimelineMessage,
  WebviewTimelineMessage,
  TimelineRange,
  TimelineSessionEntry,
} from '../types/projectTimeline';
import { formatDurationMs, formatTokenCount } from 'sidekick-shared/browser';
import { log } from '../services/Logger';
import { getNonce } from '../utils/nonce';
import { getDesignTokenCSS, getSharedStyles } from '../utils/designTokens';
import { getRandomPhrase } from 'sidekick-shared/phrases';
import { PhraseRotationManager } from '../utils/PhraseRotationManager';
import { getSessionLiveness, LivenessTicker, type SessionLiveness } from '../utils/sessionLiveness';
import type { SessionProvider } from '../types/sessionProvider';

/** True when a session path is a real file (DB-backed providers use synthetic paths). */
function isRealFile(sessionPath: string): boolean {
  try {
    return fs.statSync(sessionPath).isFile();
  } catch {
    return false;
  }
}

/**
 * WebviewViewProvider for the multi-session project timeline.
 */
export class ProjectTimelineViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sidekick.projectTimeline';

  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];
  private _dataService: ProjectTimelineDataService;
  /** The provider `_dataService` reads; a live provider switch replaces both. */
  private _dataProvider: SessionProvider;
  private _currentRange: TimelineRange = '7d';
  /** Bumped per timeline request; an older scan that finishes late is dropped. */
  private _timelineGeneration = 0;
  /** Liveness of the attached session when the timeline was last posted. */
  private _postedLiveness?: SessionLiveness;
  /** Re-sends the timeline when the attached session's Live/Viewing flips. */
  private readonly _livenessTicker = new LivenessTicker(() => this._checkLiveness());
  private _refreshTimer?: ReturnType<typeof setTimeout>;
  /** Entries from the last timeline post, used to resolve expand requests. */
  private _lastSessions: TimelineSessionEntry[] = [];

  /** Manages rotating phrase timers */
  private readonly _phrases: PhraseRotationManager;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionMonitor: SessionMonitor,
  ) {
    this._phrases = new PhraseRotationManager((msg) => this._postMessage(msg));
    this._dataProvider = this._sessionMonitor.getProvider();
    this._dataService = new ProjectTimelineDataService(this._dataProvider);

    // Subscribe to session events
    this._disposables.push(
      this._sessionMonitor.onSessionStart(() => this._debouncedRefresh()),
      this._sessionMonitor.onSessionEnd(() => this._debouncedRefresh()),
      this._sessionMonitor.onTokenUsage(() => this._debouncedRefresh()),
    );

    log('ProjectTimelineViewProvider initialized');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'out', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'images'),
      ],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewTimelineMessage) => this._handleWebviewMessage(message),
      undefined,
      this._disposables,
    );

    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._sendTimeline();
        }
      },
      undefined,
      this._disposables,
    );

    // The view is destroyed when its container closes; drop the reference
    // and the timers so session events stop scheduling work for nobody.
    webviewView.onDidDispose(
      () => {
        if (this._view !== webviewView) return;
        this._view = undefined;
        if (this._refreshTimer) {
          clearTimeout(this._refreshTimer);
          this._refreshTimer = undefined;
        }
        this._phrases.stop();
        this._livenessTicker.stop();
      },
      undefined,
      this._disposables,
    );

    this._phrases.start();
    this._livenessTicker.start();
    log('Project timeline webview resolved');
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
        // Entries are cached by mtime, so changed sessions are re-read anyway;
        // clearing would re-parse every session on each click.
        this._sendTimeline();
        break;
    }
  }

  private _debouncedRefresh(): void {
    // A hidden or unresolved view re-requests the timeline when it shows.
    if (!this._view?.visible) return;
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = undefined;
      this._sendTimeline();
    }, 10000); // 10s debounce for token usage updates
  }

  /**
   * The data service for the monitor's current provider. A live provider
   * switch disposes the old provider, so the service is rebuilt around the new
   * one (with an empty cache) instead of reading the old provider's sessions.
   */
  private _currentDataService(): ProjectTimelineDataService {
    const provider = this._sessionMonitor.getProvider();
    if (provider !== this._dataProvider) {
      this._dataProvider = provider;
      this._dataService = new ProjectTimelineDataService(provider);
      this._lastSessions = [];
    }
    return this._dataService;
  }

  /** Tick: re-send only when the attached session's Live/Viewing changed. */
  private _checkLiveness(): void {
    if (!this._view?.visible) return;
    if (getSessionLiveness(this._sessionMonitor) !== this._postedLiveness) this._sendTimeline();
  }

  private _sendTimeline(): void {
    if (!this._view?.visible) {
      log('[Timeline] No visible webview view, skipping update');
      return;
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
      log('[Timeline] No workspace folder open');
      this._postMessage({ type: 'noWorkspace' });
      return;
    }

    const generation = ++this._timelineGeneration;
    const isStale = () => generation !== this._timelineGeneration || !this._view;
    const range = this._currentRange;
    const currentSessionPath = this._sessionMonitor.getSessionPath();
    const liveness = getSessionLiveness(this._sessionMonitor);

    this._currentDataService()
      .loadTimelineEntries(workspacePath, range, currentSessionPath, {
        isStale,
        onParseStart: () => this._postMessage({ type: 'loading', loading: true }),
      })
      .then((entries) => {
        if (!entries || isStale()) return;
        const sessions = entries.map((entry) => ({
          ...entry,
          durationLabel: formatDurationMs(entry.durationMs, { invalid: '—' }),
          tokensLabel: formatTokenCount(entry.totalTokens),
          canOpenFile: isRealFile(entry.sessionPath),
        }));
        this._lastSessions = sessions;
        this._postedLiveness = liveness;

        const projectName = vscode.workspace.workspaceFolders?.[0]?.name || 'Project';

        const state: ProjectTimelineState = {
          sessions,
          range,
          projectName,
          lastUpdated: new Date().toISOString(),
        };

        log(`[Timeline] Sending ${sessions.length} sessions to webview`);
        this._postMessage({ type: 'updateTimeline', state });
      })
      .catch((error) => {
        log(`[Timeline] Error building timeline: ${error}`);
        if (!isStale()) this._postMessage({ type: 'loading', loading: false });
      });
  }

  private _sendSessionDetail(sessionId: string): void {
    // Resolve from the list the webview is showing; no rescan per expand.
    const session = this._lastSessions.find((s) => s.sessionId === sessionId);
    const detail = session
      ? this._currentDataService().getSessionDetail(session.sessionPath)
      : null;
    if (detail) {
      // The webview keys its cards by the timeline entry's id.
      this._postMessage({ type: 'sessionDetail', detail: { ...detail, sessionId } });
    } else {
      this._postMessage({ type: 'sessionDetailUnavailable', sessionId });
    }
  }

  private _openSessionFile(sessionPath: string): void {
    // Only paths the webview was shown are opened.
    if (!this._lastSessions.some((s) => s.sessionPath === sessionPath)) return;
    const uri = vscode.Uri.file(sessionPath);
    vscode.workspace.openTextDocument(uri).then(
      (doc) => vscode.window.showTextDocument(doc),
      () => {
        log(`Could not open session file: ${sessionPath}`);
        void vscode.window.showWarningMessage('Could not open this session file.');
      },
    );
  }

  private _postMessage(message: ProjectTimelineMessage): void {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'images', 'icon.png'),
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
  ${getDesignTokenCSS()}
  ${getSharedStyles()}
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
      gap: var(--sk-space-2);
      padding: var(--sk-space-2) var(--sk-space-3);
      border-bottom: 1px solid var(--sk-border-primary);
      position: sticky;
      top: 0;
      background: var(--sk-surface-primary);
      z-index: 10;
    }

    .header img { width: 20px; height: 20px; }
    .header h1 { font-size: var(--sk-font-lg); font-weight: 600; }

    .header-phrase, .empty-state-phrase {
      font-size: var(--sk-font-base);
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      margin: 0;
    }

    .header-phrase {
      padding: 2px var(--sk-space-3) var(--sk-space-2) 40px;
    }

    .range-controls {
      margin-left: auto;
      display: flex;
      gap: var(--sk-space-1);
      flex-wrap: wrap;
    }

    .range-btn {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: var(--sk-font-sm);
      padding: 3px var(--sk-space-2);
      border-radius: var(--sk-radius-sm);
      cursor: pointer;
      transition: background var(--sk-transition-fast);
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
      min-height: 200px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: var(--sk-space-5);
    }

    .empty-state p { margin-top: 8px; font-size: 12px; }

    .session-list { padding: 8px; }

    .session-card {
      background: var(--sk-surface-raised);
      border: 1px solid var(--sk-border-primary);
      border-radius: var(--sk-radius-lg);
      margin-bottom: var(--sk-space-2);
      overflow: hidden;
      transition: border-color var(--sk-transition-fast),
                  transform var(--sk-transition-fast),
                  box-shadow var(--sk-transition-fast);
      animation: sk-fade-in 0.25s ease-out both;
    }
    /* Only the first paint fades in; refreshes must not replay it. */
    .session-card.no-enter-animation { animation: none; }

    .session-card:hover {
      border-color: var(--vscode-focusBorder);
      transform: translateY(-1px);
      box-shadow: var(--sk-shadow-sm);
    }
    .session-card.current { border-left: 3px solid var(--sk-accent-success); }
    .session-card.active-session {
      border-left: 3px solid var(--sk-accent-info);
      box-shadow: 0 0 8px color-mix(in srgb, var(--sk-accent-info) 15%, transparent);
    }

    .session-header {
      padding: 10px 12px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .session-header:hover { background: var(--vscode-list-hoverBackground); }
    .session-header:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .icon-btn {
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: var(--sk-radius-sm);
      font-size: var(--sk-font-base);
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); }

    .detail-note {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-style: italic;
    }

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

    .session-status {
      border: 1px solid currentColor;
      background: transparent;
    }
    .session-status.live { color: var(--vscode-testing-iconPassed); }
    .session-status.viewing { color: var(--vscode-descriptionForeground); }

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
    <img src="${iconUri}" alt="" />
    <h1>Timeline</h1>
    <div class="range-controls" role="toolbar" aria-label="Time range">
      <button class="range-btn" data-range="24h" aria-pressed="false">24h</button>
      <button class="range-btn active" data-range="7d" aria-pressed="true">7d</button>
      <button class="range-btn" data-range="30d" aria-pressed="false">30d</button>
      <button class="range-btn" data-range="all" aria-pressed="false">All</button>
      <button class="icon-btn" id="refresh-btn" title="Refresh timeline" aria-label="Refresh timeline">&#x21bb;</button>
    </div>
  </div>
  <p id="header-phrase" class="header-phrase">${getRandomPhrase()}</p>

  <div id="empty" class="empty-state" style="display: none;">
    <p id="empty-title">No sessions found in this time range.</p>
    <p id="empty-hint">Try expanding the range, or start a new session to see it appear here.</p>
    <p id="empty-state-phrase" class="empty-state-phrase">${getRandomPhrase()}</p>
  </div>

  <div id="loading" class="loading" role="status">Loading sessions...</div>

  <div id="session-list" class="session-list"></div>

  <script nonce="${nonce}">
  (function() {
    var vscode = acquireVsCodeApi();
    var sessionListEl = document.getElementById('session-list');
    var emptyEl = document.getElementById('empty');
    var emptyTitleEl = document.getElementById('empty-title');
    var emptyHintEl = document.getElementById('empty-hint');
    var loadingEl = document.getElementById('loading');
    var rangeButtons = document.querySelectorAll('.range-btn');
    // Cards the user opened and details already fetched are tracked
    // separately, so a timeline refresh never closes an open card. Open cards
    // survive the view being hidden and shown again (it is not retained).
    var saved = vscode.getState() || {};
    var openIds = (saved.openIds && typeof saved.openIds === 'object') ? saved.openIds : {};
    var detailCache = {};
    var unavailableIds = {};
    var requestedIds = {};
    var hasRendered = false;

    function saveState() {
      vscode.setState({ openIds: openIds });
    }

    function syncRangeButtons(range) {
      rangeButtons.forEach(function(b) {
        var on = b.dataset.range === range;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    rangeButtons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        syncRangeButtons(btn.dataset.range);
        vscode.postMessage({ type: 'setRange', range: btn.dataset.range });
      });
    });

    document.getElementById('refresh-btn').addEventListener('click', function() {
      detailCache = {};
      unavailableIds = {};
      requestedIds = {};
      vscode.postMessage({ type: 'refresh' });
    });

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

    function readableStatus(status) {
      var map = { in_progress: 'In Progress', pending: 'Pending', completed: 'Completed', deleted: 'Deleted' };
      return map[status] || String(status || '');
    }

    function showEmpty(title, hint) {
      emptyTitleEl.textContent = title;
      emptyHintEl.textContent = hint;
      emptyEl.style.display = 'flex';
      sessionListEl.style.display = 'none';
      loadingEl.style.display = 'none';
    }

    function renderTimeline(state) {
      syncRangeButtons(state.range);
      if (!state.sessions || state.sessions.length === 0) {
        showEmpty('No sessions found in this time range.', 'Try expanding the range, or start a new session to see it appear here.');
        return;
      }

      emptyEl.style.display = 'none';
      sessionListEl.style.display = 'block';
      loadingEl.style.display = 'none';

      var maxDuration = Math.max.apply(null, state.sessions.map(function(s) { return s.durationMs; }));
      var listed = {};

      var html = '';
      for (var i = 0; i < state.sessions.length; i++) {
        var s = state.sessions[i];
        listed[s.sessionId] = true;
        var cardClass = 'session-card';
        if (hasRendered) cardClass += ' no-enter-animation';
        if (s.isCurrent && s.isActive) cardClass += ' active-session';
        else if (s.isCurrent) cardClass += ' current';

        var barWidth = maxDuration > 0 ? Math.max(4, (s.durationMs / maxDuration) * 100) : 4;
        var barClass = s.durationMs < 60000 ? 'timeline-bar short' : 'timeline-bar';
        var open = !!openIds[s.sessionId];
        var detailId = 'detail-' + i;

        html += '<div class="' + cardClass + '" data-session-id="' + escapeHtml(s.sessionId) + '" data-session-path="' + escapeHtml(s.sessionPath) + '" data-can-open="' + (s.canOpenFile ? '1' : '') + '">';
        html += '<div class="session-header" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="' + detailId + '">';

        html += '<div class="session-title-row">';
        html += '<span class="session-label" title="' + escapeHtml(s.label) + '">' + escapeHtml(s.label) + '</span>';
        if (s.isCurrent) {
          html += s.isActive
            ? '<span class="session-status live">Live</span>'
            : '<span class="session-status viewing">Viewing</span>';
        }
        html += '</div>';

        html += '<div class="' + barClass + '" style="width: ' + barWidth + '%;"></div>';

        html += '<div class="session-meta">';
        html += '<span class="meta-item">' + formatTime(s.startTime) + '</span>';
        html += '<span class="meta-item">' + escapeHtml(s.durationLabel || '') + '</span>';
        html += '<span class="meta-item">' + s.messageCount + ' msg' + (s.messageCount === 1 ? '' : 's') + '</span>';
        html += '</div>';

        html += '<div class="session-badges">';
        html += '<span class="badge tokens" title="' + Number(s.totalTokens).toLocaleString() + ' tokens">' + escapeHtml(s.tokensLabel || String(s.totalTokens)) + ' tokens</span>';
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

        html += '<div class="session-detail' + (open ? ' visible' : '') + '" id="' + detailId + '">';
        html += detailBody(s.sessionId, !!s.canOpenFile);
        html += '</div>';

        html += '</div>'; // session-card
      }

      // Forget open cards that left the list (range change).
      Object.keys(openIds).forEach(function(id) { if (!listed[id]) delete openIds[id]; });
      saveState();
      var focus = captureFocus();
      sessionListEl.innerHTML = html;
      hasRendered = true;
      restoreFocus(focus);
      // Fetch details for cards restored open from saved state.
      Object.keys(openIds).forEach(function(id) {
        if (!detailCache[id] && !unavailableIds[id] && !requestedIds[id]) {
          requestedIds[id] = true;
          vscode.postMessage({ type: 'expandSession', sessionId: id });
        }
      });
    }

    // A refresh rebuilds the list; keep keyboard focus on the same control.
    function captureFocus() {
      var el = document.activeElement;
      if (!el || !sessionListEl.contains(el)) return null;
      var card = el.closest('.session-card');
      if (!card) return null;
      return {
        sessionId: card.dataset.sessionId,
        selector: el.classList.contains('open-file-btn') ? '.open-file-btn' : '.session-header',
      };
    }

    function restoreFocus(focus) {
      if (!focus) return;
      var card = findCard(focus.sessionId);
      var target = card && card.querySelector(focus.selector);
      if (target) target.focus({ preventScroll: true });
    }

    function detailBody(sessionId, canOpen) {
      var html;
      if (detailCache[sessionId]) html = renderDetailContent(detailCache[sessionId]);
      else if (unavailableIds[sessionId]) html = '<div class="detail-note">Details are unavailable for this session.</div>';
      else html = '<div class="loading">Loading details...</div>';
      if (canOpen) html += '<button type="button" class="open-file-btn">Open session file</button>';
      return html;
    }

    function renderDetailContent(detail) {
      var html = '';

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

      if (detail.tasks && detail.tasks.length > 0) {
        html += '<div class="detail-section">';
        html += '<h3>Tasks (' + detail.tasks.length + ')</h3>';
        html += '<ul class="detail-list">';
        for (var j = 0; j < detail.tasks.length && j < 5; j++) {
          html += '<li>' + escapeHtml(detail.tasks[j].subject) + ' <span class="count">(' + escapeHtml(readableStatus(detail.tasks[j].status)) + ')</span></li>';
        }
        html += '</ul></div>';
      }

      if (detail.errors && detail.errors.length > 0) {
        html += '<div class="detail-section">';
        html += '<h3>Errors</h3>';
        html += '<ul class="detail-list">';
        for (var k = 0; k < detail.errors.length; k++) {
          html += '<li><span class="count">' + detail.errors[k].count + 'x</span> ' + escapeHtml(detail.errors[k].category) + '</li>';
        }
        html += '</ul></div>';
      }

      if (!html) html = '<div class="detail-note">No details recorded for this session.</div>';
      return html;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function findCard(sessionId) {
      var cards = sessionListEl.querySelectorAll('.session-card');
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].dataset.sessionId === sessionId) return cards[i];
      }
      return null;
    }

    function toggleSession(headerEl) {
      var card = headerEl.closest('.session-card');
      if (!card) return;
      var sessionId = card.dataset.sessionId;
      var detailEl = card.querySelector('.session-detail');
      var open = !openIds[sessionId];
      if (open) openIds[sessionId] = true;
      else delete openIds[sessionId];
      saveState();
      detailEl.classList.toggle('visible', open);
      headerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !detailCache[sessionId]) {
        delete unavailableIds[sessionId];
        detailEl.innerHTML = detailBody(sessionId, card.dataset.canOpen === '1');
        requestedIds[sessionId] = true;
        vscode.postMessage({ type: 'expandSession', sessionId: sessionId });
      }
    }

    // Delegated handlers: the CSP blocks inline on* attributes.
    sessionListEl.addEventListener('click', function(e) {
      var openBtn = e.target.closest('.open-file-btn');
      if (openBtn) {
        var card = openBtn.closest('.session-card');
        if (card) vscode.postMessage({ type: 'openSession', sessionPath: card.dataset.sessionPath });
        return;
      }
      var header = e.target.closest('.session-header');
      if (header) toggleSession(header);
    });
    sessionListEl.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var header = e.target.closest('.session-header');
      if (!header || e.target !== header) return;
      e.preventDefault();
      toggleSession(header);
    });

    function updateDetail(sessionId) {
      var card = findCard(sessionId);
      if (!card) return;
      var detailEl = card.querySelector('.session-detail');
      if (detailEl) detailEl.innerHTML = detailBody(sessionId, card.dataset.canOpen === '1');
    }

    window.addEventListener('message', function(event) {
      var message = event.data;
      switch (message.type) {
        case 'updateTimeline':
          renderTimeline(message.state);
          break;
        case 'noWorkspace':
          showEmpty('Open a folder to see its session timeline.', 'The timeline lists the agent sessions recorded for the open workspace.');
          break;
        case 'sessionDetail':
          detailCache[message.detail.sessionId] = message.detail;
          delete requestedIds[message.detail.sessionId];
          updateDetail(message.detail.sessionId);
          break;
        case 'sessionDetailUnavailable':
          unavailableIds[message.sessionId] = true;
          delete requestedIds[message.sessionId];
          updateDetail(message.sessionId);
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

    vscode.postMessage({ type: 'ready' });
  })();
  </script>
</body>
</html>`;
  }

  dispose(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._phrases.stop();
    this._livenessTicker.stop();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
    log('ProjectTimelineViewProvider disposed');
  }
}
