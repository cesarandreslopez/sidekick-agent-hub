/**
 * @fileoverview Plan board webview provider for session plan visualization.
 *
 * Displays active and historical plans with step progress,
 * metrics, and raw markdown. Updates in real time from SessionMonitor.
 *
 * @module providers/PlanBoardViewProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { PlanPersistenceService } from '../services/PlanPersistenceService';
import type {
  PlanBoardState,
  PlanBoardMessage,
  WebviewPlanBoardMessage,
  ActivePlanDisplay,
  PlanHistoryEntry,
  PlanStepCard,
} from '../types/planBoard';
import type { PlanState } from '../types/claudeSession';
import type { PersistedPlan } from '../types/plan';
import { readClaudeCodePlanFiles } from 'sidekick-shared';
import { formatCost, formatDurationMs, formatTokenCount } from 'sidekick-shared/browser';
import { log } from '../services/Logger';
import {
  getSessionLiveness,
  LivenessTicker,
  SESSION_LIVENESS_LABELS,
} from '../utils/sessionLiveness';
import { getNonce } from '../utils/nonce';
import { getDesignTokenCSS, getSharedStyles } from '../utils/designTokens';

/**
 * WebviewViewProvider for the session plan board.
 */
type RawPlanFile = Awaited<ReturnType<typeof readClaudeCodePlanFiles>>[number];

export class PlanBoardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sidekick.planBoard';
  /** Trailing throttle for tool-call bursts. */
  private static readonly BOARD_UPDATE_MS = 250;

  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];
  private _state: PlanBoardState;
  private _claudeCodePlans: RawPlanFile[] = [];
  private _boardTimer?: ReturnType<typeof setTimeout>;
  /** Set when a session change arrived while the view was hidden. */
  private _dirty = false;
  /** Serialized form of the last state posted, to skip identical posts. */
  private _lastPosted = '';
  private _claudeCodePlansLoaded = false;
  private _planLoadGeneration = 0;
  /** Lets Live decay to Viewing when the session goes quiet (no event fires). */
  private readonly _livenessTicker = new LivenessTicker(() => this._checkLiveness());

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionMonitor: SessionMonitor,
    private readonly _planPersistence?: PlanPersistenceService,
  ) {
    this._state = {
      activePlan: null,
      historicalPlans: [],
      sessionActive: false,
    };

    this._disposables.push(this._sessionMonitor.onToolCall(() => this._updateBoard()));

    this._disposables.push(
      this._sessionMonitor.onSessionStart(() => {
        this._state.sessionActive = true;
        this._syncFromSessionMonitor();
        this._sendStateToWebview();
      }),
    );

    this._disposables.push(
      this._sessionMonitor.onSessionEnd(() => {
        this._state.sessionActive = false;
        this._syncFromSessionMonitor();
        this._postMessage({ type: 'sessionEnd' });
        this._sendStateToWebview();
      }),
    );

    this._syncFromSessionMonitor();

    // Load raw plan files from the Claude home's plans/ asynchronously
    this._loadClaudeCodePlans();

    log('PlanBoardViewProvider initialized');
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
      (message: WebviewPlanBoardMessage) => this._handleWebviewMessage(message),
      undefined,
      this._disposables,
    );

    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          if (this._dirty) {
            this._dirty = false;
            this._syncFromSessionMonitor();
          } else {
            this._state = { ...this._state, sessionStatus: this._livenessLabel() };
          }
          this._sendStateToWebview(true);
        }
      },
      undefined,
      this._disposables,
    );

    webviewView.onDidDispose(
      () => {
        if (this._view === webviewView) {
          this._view = undefined;
          this._lastPosted = '';
          this._livenessTicker.stop();
        }
      },
      undefined,
      this._disposables,
    );

    this._livenessTicker.start();
    log('Plan board webview resolved');
  }

  dispose(): void {
    if (this._boardTimer) clearTimeout(this._boardTimer);
    this._livenessTicker.stop();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }

  private _livenessLabel(): string {
    return SESSION_LIVENESS_LABELS[getSessionLiveness(this._sessionMonitor)];
  }

  /** Tick: re-post only when the status the board shows is out of date. */
  private _checkLiveness(): void {
    if (!this._view?.visible) return;
    const label = this._livenessLabel();
    if (label === this._state.sessionStatus) return;
    this._state = { ...this._state, sessionStatus: label };
    this._sendStateToWebview();
  }

  private _handleWebviewMessage(message: WebviewPlanBoardMessage): void {
    switch (message.type) {
      case 'webviewReady':
        log('Plan board webview ready, sending initial state');
        this._sendStateToWebview(true);
        break;

      case 'refresh':
        void this._loadClaudeCodePlans();
        break;

      case 'copyPlanMarkdown': {
        const markdown = this._findPlanMarkdown(message.planId);
        if (markdown) {
          void vscode.env.clipboard.writeText(markdown).then(() => {
            vscode.window.setStatusBarMessage('Plan markdown copied', 2000);
            this._postMessage({ type: 'copied', planId: message.planId });
          });
        }
        break;
      }
    }
  }

  private _findPlanMarkdown(planId: string): string | undefined {
    if (planId === 'active' && this._state.activePlan?.rawMarkdown) {
      return this._state.activePlan.rawMarkdown;
    }
    const hist = this._state.historicalPlans.find((p) => p.id === planId);
    return hist?.rawMarkdown;
  }

  private async _loadClaudeCodePlans(): Promise<void> {
    const generation = ++this._planLoadGeneration;
    try {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const plans = await readClaudeCodePlanFiles(workspacePath);
      if (generation !== this._planLoadGeneration) return;
      this._claudeCodePlans = plans;
      this._claudeCodePlansLoaded = true;
      this._syncFromSessionMonitor();
      this._sendStateToWebview(true);
    } catch {
      if (generation !== this._planLoadGeneration) return;
      this._claudeCodePlansLoaded = true;
    }
  }

  private _updateBoard(): void {
    // A hidden view syncs when it becomes visible again.
    if (!this._view?.visible) {
      this._dirty = true;
      return;
    }
    // Trailing throttle: a burst of tool calls rebuilds the board once.
    if (this._boardTimer) return;
    this._boardTimer = setTimeout(() => {
      this._boardTimer = undefined;
      this._syncFromSessionMonitor();
      this._sendStateToWebview();
    }, PlanBoardViewProvider.BOARD_UPDATE_MS);
  }

  private _syncFromSessionMonitor(): void {
    const stats = this._sessionMonitor.getStatsView();
    const planState = stats.planState;

    // Active plan from current session
    let activePlan: ActivePlanDisplay | null = null;
    if (planState && (planState.steps.length > 0 || planState.rawMarkdown)) {
      activePlan = this._planStateToDisplay(planState);
    }

    const persisted = this._planPersistence?.getPlans() ?? [];
    const activeSessionId = this._getActiveSessionId();
    // The active session only hides its plans from History when the Active
    // Plan card is there to show them instead.
    const historicalPlans = mergePlanHistory(
      persisted,
      this._claudeCodePlans,
      activePlan ? activeSessionId : null,
    ).map((entry) => this._persistedToHistoryEntry(entry.plan, entry.rawOnly));

    this._state = {
      activePlan,
      historicalPlans,
      sessionActive: this._sessionMonitor.isActive(),
      sessionStatus: this._livenessLabel(),
    };
  }

  private _getActiveSessionId(): string | null {
    const sessionPath = this._sessionMonitor.getSessionPath();
    if (!sessionPath) return null;
    return this._sessionMonitor.getProvider().getSessionId(sessionPath) || null;
  }

  private _planStateToDisplay(planState: PlanState): ActivePlanDisplay {
    const steps: PlanStepCard[] = planState.steps.map((s) => ({
      id: s.id,
      description: s.description,
      status: s.status,
      phase: s.phase,
      complexity: s.complexity,
    }));

    const completed = steps.filter((s) => s.status === 'completed').length;
    const rate = steps.length > 0 ? completed / steps.length : 0;

    return {
      title: planState.title || 'Untitled Plan',
      active: planState.active,
      completionRate: rate,
      steps,
      source: planState.source,
      rawMarkdown: planState.rawMarkdown,
    };
  }

  private _persistedToHistoryEntry(plan: PersistedPlan, rawOnly = false): PlanHistoryEntry {
    const steps: PlanStepCard[] = plan.steps.map((s) => ({
      id: s.id,
      description: s.description,
      status: s.status,
      phase: s.phase,
      complexity: s.complexity,
    }));

    return {
      id: plan.id,
      title: plan.title,
      status: plan.status,
      source: plan.source,
      completionRate: plan.completionRate,
      createdAt: plan.createdAt,
      completedAt: plan.completedAt,
      steps,
      totalDurationMs: plan.totalDurationMs,
      totalTokensUsed: plan.totalTokensUsed,
      totalToolCalls: plan.totalToolCalls,
      totalCostUsd: plan.totalCostUsd,
      rawMarkdown: plan.rawMarkdown,
      rawOnly,
      durationLabel: plan.totalDurationMs
        ? formatDurationMs(plan.totalDurationMs, { invalid: '' })
        : undefined,
      tokensLabel: plan.totalTokensUsed ? formatTokenCount(plan.totalTokensUsed) : undefined,
      costLabel: plan.totalCostUsd ? formatCost(plan.totalCostUsd) : undefined,
    };
  }

  /** Posts the state; an unchanged state is skipped unless `force`. */
  private _sendStateToWebview(force = false): void {
    if (!this._view?.visible) return;
    const serialized = JSON.stringify(this._state);
    if (!force && serialized === this._lastPosted) return;
    this._lastPosted = serialized;
    this._postMessage({ type: 'updatePlanBoard', state: this._state });
  }

  private _postMessage(message: PlanBoardMessage): void {
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
  <title>Plans</title>
  ${getDesignTokenCSS()}
  ${getSharedStyles()}
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .header {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      padding: var(--sk-space-2) var(--sk-space-3);
      border-bottom: 1px solid var(--sk-border-primary);
    }

    .header img {
      width: 20px;
      height: 20px;
    }

    .header h1 {
      font-size: var(--sk-font-lg);
      font-weight: 600;
    }

    .status {
      font-size: var(--sk-font-sm);
      padding: 2px var(--sk-space-2);
      border-radius: var(--sk-radius-sm);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* Outlined like the status chips: the status colour as text keeps
       contrast in light, dark and high-contrast themes. */
    .status.active {
      background: transparent;
      color: var(--vscode-testing-iconPassed, #388a34);
      box-shadow: inset 0 0 0 1px currentColor;
    }

    .header-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
    }

    .icon-button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: var(--sk-font-sm);
      line-height: 1;
      padding: var(--sk-space-1) 7px;
      border-radius: var(--sk-radius-sm);
      cursor: pointer;
      transition: background var(--sk-transition-fast);
    }

    .icon-button:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .plan-card {
      background: var(--sk-surface-raised);
      border: 1px solid var(--sk-border-primary);
      border-radius: var(--sk-radius-xl);
      padding: var(--sk-space-3);
      word-wrap: break-word;
      overflow-wrap: break-word;
      transition: transform var(--sk-transition-fast), box-shadow var(--sk-transition-fast);
      animation: sk-fade-in 0.25s ease-out both;
    }

    .plan-card.no-enter-animation {
      animation: none;
    }

    .plan-card:hover {
      transform: translateY(-1px);
      box-shadow: var(--sk-shadow-md);
    }

    .plan-card.active-plan {
      border-color: var(--sk-accent-primary);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--sk-accent-primary) 30%, transparent);
    }

    .plan-title {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
      margin-bottom: 6px;
    }

    .plan-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }

    .chip {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 12px;
      padding: 1px 6px;
      font-size: 9px;
      font-weight: 600;
    }

    /* Status chips are outlined: text and border in the status colour keep
       contrast in light, dark and high-contrast themes. */
    .chip.completed,
    .chip.in_progress,
    .chip.failed,
    .chip.abandoned {
      background: transparent;
      border: 1px solid currentColor;
    }
    .chip.completed { color: var(--vscode-testing-iconPassed, #2d8a4b); }
    .chip.in_progress { color: var(--vscode-editorWarning-foreground, #c59f1a); }
    .chip.failed { color: var(--vscode-errorForeground, #f14c4c); }
    .chip.abandoned { color: var(--vscode-descriptionForeground); }

    .progress-bar-container {
      width: 100%;
      height: 6px;
      background: var(--vscode-progressBar-background, #333);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 8px;
    }

    .progress-bar-fill {
      height: 100%;
      background: var(--vscode-testing-iconPassed, #2d8a4b);
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .step-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .step-item {
      font-size: 11px;
      padding: 3px 0;
      display: flex;
      gap: 6px;
      align-items: flex-start;
    }

    .step-icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }

    .step-description {
      word-wrap: break-word;
      overflow-wrap: break-word;
      white-space: pre-wrap;
      flex: 1;
      min-width: 0;
    }

    .history-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .collapsible-header {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0;
      flex: 1;
      min-width: 0;
      border: none;
      background: transparent;
      color: inherit;
      font-family: inherit;
      text-align: left;
    }

    .collapsible-header:hover {
      opacity: 0.8;
    }

    .collapsible-header:focus-visible,
    .filter-chip:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .collapsible-header .plan-title {
      margin-bottom: 0;
    }

    .collapsible-content {
      display: none;
      padding-top: 6px;
    }

    .collapsible-content.open {
      display: block;
    }

    .collapse-arrow {
      font-size: 10px;
      transition: transform 0.2s;
    }

    .collapse-arrow.open {
      transform: rotate(90deg);
    }

    .copy-btn {
      font-size: 9px;
      padding: 2px 5px;
      margin-left: auto;
      flex-shrink: 0;
    }

    .metrics-line {
      margin-bottom: 8px;
    }

    .empty-state .link-button {
      margin-top: 8px;
    }

    .search-container {
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .search-container input {
      width: 100%;
      padding: 4px 8px;
      font-size: 11px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      outline: none;
    }

    .search-container input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .filter-chip {
      font-family: var(--vscode-font-family);
      font-size: 9px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 12px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      user-select: none;
    }

    .filter-chip:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .filter-chip.active {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-color: var(--vscode-badge-background);
    }

    .filter-divider {
      width: 1px;
      background: var(--vscode-panel-border);
      margin: 0 2px;
      align-self: stretch;
    }

    .empty-state {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      padding: 16px;
    }

    .empty-state p {
      font-size: 12px;
      max-width: 240px;
    }

    .empty-state-inner {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="" />
    <h1>Plans</h1>
    <span id="status" class="status">No session</span>
    <div class="header-actions">
      <button id="refresh" class="icon-button">Refresh</button>
    </div>
  </div>
  <div class="search-container">
    <input id="search" type="text" placeholder="Search plans..." aria-label="Search plans" />
  </div>
  <div class="filter-bar" id="filterBar" role="toolbar" aria-label="Filter plans">
    <button type="button" class="filter-chip active" data-filter="date" data-value="all" aria-pressed="true">All</button>
    <button type="button" class="filter-chip" data-filter="date" data-value="today" aria-pressed="false">Today</button>
    <button type="button" class="filter-chip" data-filter="date" data-value="7d" aria-pressed="false">7d</button>
    <button type="button" class="filter-chip" data-filter="date" data-value="30d" aria-pressed="false">30d</button>
    <span class="filter-divider" aria-hidden="true"></span>
    <button type="button" class="filter-chip" data-filter="source" data-value="claude-code" aria-pressed="false">claude-code</button>
    <button type="button" class="filter-chip" data-filter="source" data-value="opencode" aria-pressed="false">opencode</button>
    <button type="button" class="filter-chip" data-filter="source" data-value="codex" aria-pressed="false">codex</button>
    <span class="filter-divider" aria-hidden="true"></span>
    <button type="button" class="filter-chip" data-filter="status" data-value="completed" aria-pressed="false">completed</button>
    <button type="button" class="filter-chip" data-filter="status" data-value="failed" aria-pressed="false">failed</button>
    <button type="button" class="filter-chip" data-filter="status" data-value="abandoned" aria-pressed="false">abandoned</button>
  </div>
  <div id="content" class="content"></div>
  <div id="empty" class="empty-state" hidden>
    <div class="empty-state-inner">
      <p id="empty-text">No plans yet. Plans will appear here when your agent enters plan mode during a session.</p>
      <button type="button" id="clear-filters" class="icon-button link-button" hidden>Clear filters</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const contentEl = document.getElementById('content');
    const emptyEl = document.getElementById('empty');
    const emptyTextEl = document.getElementById('empty-text');
    const clearFiltersBtn = document.getElementById('clear-filters');
    const statusEl = document.getElementById('status');
    const refreshBtn = document.getElementById('refresh');
    const searchInput = document.getElementById('search');
    const filterBar = document.getElementById('filterBar');

    var DEFAULT_FILTERS = { date: 'all', source: null, status: null };
    var saved = vscode.getState() || {};
    var lastState = null;
    var currentSearchQuery = typeof saved.search === 'string' ? saved.search : '';
    var activeFilters = Object.assign({}, DEFAULT_FILTERS, saved.filters || {});
    // History cards the user opened, kept across re-renders.
    var openPlans = {};
    (saved.openPlans || []).forEach(function(id) { openPlans[id] = true; });
    var hasRendered = false;

    const STATUS_ICONS = {
      completed: '\\u2713',
      in_progress: '\\u25B6',
      pending: '\\u25CB',
      failed: '\\u2717',
      skipped: '\\u2014'
    };

    const STATUS_COLORS = {
      completed: 'var(--vscode-gitDecoration-addedResourceForeground, #2d8a4b)',
      in_progress: 'var(--vscode-gitDecoration-modifiedResourceForeground, #c59f1a)',
      pending: 'var(--vscode-gitDecoration-ignoredResourceForeground, #888)',
      failed: 'var(--vscode-errorForeground, #f14c4c)',
      skipped: 'var(--vscode-gitDecoration-ignoredResourceForeground, #888)'
    };

    const STATUS_LABELS = {
      completed: 'Completed',
      in_progress: 'In Progress',
      failed: 'Failed',
      abandoned: 'Abandoned'
    };

    function persist() {
      vscode.setState({
        search: currentSearchQuery,
        filters: activeFilters,
        openPlans: Object.keys(openPlans)
      });
    }

    function filtersActive() {
      return Boolean(currentSearchQuery) || activeFilters.date !== 'all' || Boolean(activeFilters.source) || Boolean(activeFilters.status);
    }

    function syncFilterChips() {
      filterBar.querySelectorAll('.filter-chip').forEach(function(chip) {
        var on = activeFilters[chip.dataset.filter] === chip.dataset.value;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    function formatDate(value) {
      if (!value) return '';
      var d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function matchesSearch(plan, query) {
      if (!query) return true;
      var haystack = [plan.title || '', plan.source || '', plan.status || ''];
      if (plan.steps) {
        plan.steps.forEach(function(s) { haystack.push(s.description || ''); });
      }
      if (plan.rawMarkdown) haystack.push(plan.rawMarkdown);
      return haystack.join(' ').toLowerCase().includes(query);
    }

    function matchesDateFilter(plan, dateFilter) {
      if (dateFilter === 'all' || !plan.createdAt) return true;
      var created = new Date(plan.createdAt).getTime();
      if (Number.isNaN(created)) return true;
      var now = Date.now();
      var msPerDay = 86400000;
      if (dateFilter === 'today') {
        var todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        return created >= todayStart.getTime();
      }
      if (dateFilter === '7d') return created >= now - 7 * msPerDay;
      if (dateFilter === '30d') return created >= now - 30 * msPerDay;
      return true;
    }

    function filterHistoricalPlans(plans) {
      return plans.filter(function(plan) {
        if (!matchesSearch(plan, currentSearchQuery)) return false;
        if (!matchesDateFilter(plan, activeFilters.date)) return false;
        if (activeFilters.source && plan.source !== activeFilters.source) return false;
        if (activeFilters.status && (plan.rawOnly || plan.status !== activeFilters.status)) return false;
        return true;
      });
    }

    function render(state) {
      if (!state) return;
      lastState = state;

      statusEl.textContent = state.sessionStatus || (state.sessionActive ? 'Viewing' : 'No session');
      statusEl.classList.toggle('active', state.sessionStatus === 'Live');

      var allHistory = state.historicalPlans || [];
      var filtered = filterHistoricalPlans(allHistory);
      var hasPlans = state.activePlan || filtered.length > 0;

      if (!hasPlans) {
        var filteredOut = allHistory.length > 0 && filtersActive();
        emptyTextEl.textContent = filteredOut
          ? 'No plans match these filters.'
          : 'No plans yet. Plans will appear here when your agent enters plan mode during a session.';
        clearFiltersBtn.hidden = !filteredOut;
        emptyEl.hidden = false;
        emptyEl.style.display = 'flex';
        contentEl.style.display = 'none';
        return;
      }

      emptyEl.hidden = true;
      emptyEl.style.display = 'none';
      contentEl.style.display = 'flex';
      // A live update rebuilds the list; keep keyboard focus on the same control.
      var focus = focusedControl();
      contentEl.innerHTML = '';

      if (state.activePlan) {
        var sectionTitle = document.createElement('div');
        sectionTitle.className = 'section-title';
        sectionTitle.textContent = 'Active Plan';
        contentEl.appendChild(sectionTitle);

        contentEl.appendChild(renderActivePlan(state.activePlan));
      }

      if (filtered.length > 0) {
        var histTitle = document.createElement('div');
        histTitle.className = 'section-title';
        histTitle.textContent = 'History (' + filtered.length + ')';
        contentEl.appendChild(histTitle);

        filtered.forEach(function(plan) {
          contentEl.appendChild(renderHistoryCard(plan));
        });
      }

      // Only the first paint fades cards in; updates must not re-animate.
      if (hasRendered) {
        contentEl.querySelectorAll('.plan-card').forEach(function(card) {
          card.classList.add('no-enter-animation');
        });
      }
      hasRendered = true;
      restoreFocus(focus);
    }

    // Which control had focus, by attribute value (no selector escaping needed).
    function focusedControl() {
      var el = document.activeElement;
      if (!el || !contentEl.contains(el)) return null;
      if (el.classList.contains('copy-btn') && el.dataset.copyPlan) {
        return { selector: '.copy-btn', attr: 'data-copy-plan', value: el.dataset.copyPlan };
      }
      if (el.classList.contains('collapsible-header') && el.getAttribute('aria-controls')) {
        return { selector: '.collapsible-header', attr: 'aria-controls', value: el.getAttribute('aria-controls') };
      }
      return null;
    }

    function restoreFocus(focus) {
      if (!focus) return;
      var match = Array.prototype.find.call(contentEl.querySelectorAll(focus.selector), function(el) {
        return el.getAttribute(focus.attr) === focus.value;
      });
      if (match) match.focus({ preventScroll: true });
    }

    function makeCopyButton(label, planId) {
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'icon-button copy-btn';
      copyBtn.textContent = label;
      copyBtn.dataset.copyPlan = planId;
      copyBtn.dataset.label = label;
      copyBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'copyPlanMarkdown', planId: planId });
      });
      return copyBtn;
    }

    function renderActivePlan(plan) {
      var card = document.createElement('div');
      card.className = 'plan-card active-plan';

      var title = document.createElement('div');
      title.className = 'plan-title';
      title.textContent = plan.title;
      card.appendChild(title);

      var meta = document.createElement('div');
      meta.className = 'plan-meta';
      if (plan.source) {
        var srcChip = document.createElement('span');
        srcChip.className = 'chip';
        srcChip.textContent = plan.source;
        meta.appendChild(srcChip);
      }
      var statusChip = document.createElement('span');
      statusChip.className = 'chip ' + (plan.active ? 'in_progress' : 'completed');
      statusChip.textContent = plan.active ? 'In Progress' : 'Done';
      meta.appendChild(statusChip);

      var rateText = document.createElement('span');
      rateText.textContent = Math.round(plan.completionRate * 100) + '% complete';
      meta.appendChild(rateText);
      card.appendChild(meta);

      var barContainer = document.createElement('div');
      barContainer.className = 'progress-bar-container';
      var barFill = document.createElement('div');
      barFill.className = 'progress-bar-fill';
      barFill.style.width = Math.round(plan.completionRate * 100) + '%';
      barContainer.appendChild(barFill);
      card.appendChild(barContainer);

      card.appendChild(renderStepList(plan.steps));

      if (plan.rawMarkdown) card.appendChild(makeCopyButton('Copy Markdown', 'active'));

      return card;
    }

    function renderHistoryCard(plan) {
      var card = document.createElement('div');
      card.className = 'plan-card';
      var isOpen = !!openPlans[plan.id];
      var contentId = 'plan-body-' + String(plan.id).replace(/[^a-zA-Z0-9_-]/g, '_');

      // Header row: a disclosure button plus a sibling Copy button.
      var headerRow = document.createElement('div');
      headerRow.className = 'history-header';

      var header = document.createElement('button');
      header.type = 'button';
      header.className = 'collapsible-header';
      header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      header.setAttribute('aria-controls', contentId);

      var arrow = document.createElement('span');
      arrow.className = 'collapse-arrow' + (isOpen ? ' open' : '');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '\\u25B6';
      header.appendChild(arrow);

      var title = document.createElement('span');
      title.className = 'plan-title';
      title.textContent = plan.title;
      header.appendChild(title);

      // A raw plan file has no recorded run, so it gets no status chip.
      if (!plan.rawOnly) {
        var statusChip = document.createElement('span');
        statusChip.className = 'chip ' + plan.status;
        statusChip.textContent = STATUS_LABELS[plan.status] || String(plan.status).replace('_', ' ');
        header.appendChild(statusChip);
      }

      headerRow.appendChild(header);
      if (plan.rawMarkdown) headerRow.appendChild(makeCopyButton('Copy', plan.id));
      card.appendChild(headerRow);

      var meta = document.createElement('div');
      meta.className = 'plan-meta';
      var srcChip = document.createElement('span');
      srcChip.className = 'chip';
      srcChip.textContent = plan.source;
      meta.appendChild(srcChip);

      if (!plan.rawOnly || (plan.steps && plan.steps.length > 0)) {
        var rateText = document.createElement('span');
        rateText.textContent = Math.round(plan.completionRate * 100) + '%';
        meta.appendChild(rateText);
      }

      var dateText = document.createElement('span');
      dateText.textContent = formatDate(plan.createdAt);
      meta.appendChild(dateText);

      card.appendChild(meta);

      var content = document.createElement('div');
      content.className = 'collapsible-content' + (isOpen ? ' open' : '');
      content.id = contentId;

      var metrics = [];
      if (plan.durationLabel) metrics.push('Duration: ' + plan.durationLabel);
      if (plan.tokensLabel) metrics.push('Tokens: ' + plan.tokensLabel);
      if (plan.costLabel) metrics.push('Cost: ' + plan.costLabel);
      if (plan.totalToolCalls) metrics.push('Tool calls: ' + plan.totalToolCalls);

      if (metrics.length > 0) {
        var metricsEl = document.createElement('div');
        metricsEl.className = 'plan-meta metrics-line';
        metricsEl.textContent = metrics.join(' | ');
        content.appendChild(metricsEl);
      }

      var barContainer = document.createElement('div');
      barContainer.className = 'progress-bar-container';
      var barFill = document.createElement('div');
      barFill.className = 'progress-bar-fill';
      barFill.style.width = Math.round(plan.completionRate * 100) + '%';
      barContainer.appendChild(barFill);
      content.appendChild(barContainer);

      content.appendChild(renderStepList(plan.steps));

      card.appendChild(content);

      header.addEventListener('click', function() {
        var nowOpen = content.classList.toggle('open');
        arrow.classList.toggle('open', nowOpen);
        header.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
        if (nowOpen) openPlans[plan.id] = true;
        else delete openPlans[plan.id];
        persist();
      });

      return card;
    }

    function renderStepList(steps) {
      var list = document.createElement('ul');
      list.className = 'step-list';

      steps.forEach(function(step) {
        var item = document.createElement('li');
        item.className = 'step-item';

        var icon = document.createElement('span');
        icon.className = 'step-icon';
        icon.textContent = STATUS_ICONS[step.status] || STATUS_ICONS.pending;
        icon.style.color = STATUS_COLORS[step.status] || STATUS_COLORS.pending;
        item.appendChild(icon);

        var desc = document.createElement('span');
        desc.className = 'step-description';
        desc.textContent = step.description;
        item.appendChild(desc);

        list.appendChild(item);
      });

      return list;
    }

    window.addEventListener('message', function(event) {
      var message = event.data;
      if (!message) return;
      switch (message.type) {
        case 'updatePlanBoard':
          render(message.state);
          break;
        case 'copied':
          contentEl.querySelectorAll('[data-copy-plan]').forEach(function(btn) {
            if (btn.dataset.copyPlan !== message.planId) return;
            btn.textContent = 'Copied';
            setTimeout(function() { btn.textContent = btn.dataset.label || 'Copy'; }, 1500);
          });
          break;
        case 'sessionStart':
        case 'sessionEnd':
          break;
      }
    });

    refreshBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'refresh' });
    });

    searchInput.value = currentSearchQuery;
    searchInput.addEventListener('input', function() {
      currentSearchQuery = this.value.toLowerCase();
      persist();
      render(lastState);
    });

    clearFiltersBtn.addEventListener('click', function() {
      currentSearchQuery = '';
      searchInput.value = '';
      activeFilters = Object.assign({}, DEFAULT_FILTERS);
      syncFilterChips();
      persist();
      render(lastState);
    });

    filterBar.addEventListener('click', function(e) {
      var chip = e.target.closest('.filter-chip');
      if (!chip) return;
      var filterType = chip.dataset.filter;
      var filterValue = chip.dataset.value;
      if (!filterType || !filterValue) return;

      if (filterType === 'date') {
        // Date filters are exclusive (radio behaviour).
        activeFilters.date = filterValue;
      } else if (activeFilters[filterType] === filterValue) {
        // Source/status filters toggle.
        activeFilters[filterType] = null;
      } else {
        activeFilters[filterType] = filterValue;
      }

      syncFilterChips();
      persist();
      render(lastState);
    });

    syncFilterChips();
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
  }
}

/**
 * Merges persisted plans (recorded runs, with metrics) with raw Claude Code
 * plan files. A raw file is dropped when a persisted plan or the active
 * session already covers one of its sessions, or when its markdown matches a
 * persisted plan. Persisted plans from the active session are left to the
 * Active Plan card. Pass `activeSessionId: null` when there is no Active Plan
 * card, so nothing is hidden on its behalf.
 */
export function mergePlanHistory(
  persisted: readonly PersistedPlan[],
  raw: readonly (PersistedPlan & { sessionIds?: string[] })[],
  activeSessionId: string | null,
): Array<{ plan: PersistedPlan; rawOnly: boolean }> {
  const result: Array<{ plan: PersistedPlan; rawOnly: boolean }> = [];
  const coveredSessions = new Set<string>();
  const persistedMarkdown = new Set<string>();

  for (const plan of persisted) {
    if (plan.rawMarkdown) persistedMarkdown.add(plan.rawMarkdown.trim());
    coveredSessions.add(plan.sessionId);
    if (activeSessionId && plan.sessionId === activeSessionId) continue;
    // Older records may carry an 8-character session prefix.
    if (
      activeSessionId &&
      plan.sessionId.length < activeSessionId.length &&
      activeSessionId.startsWith(plan.sessionId)
    )
      continue;
    result.push({ plan, rawOnly: false });
  }

  const isCovered = (sessionId: string) =>
    sessionId === activeSessionId ||
    coveredSessions.has(sessionId) ||
    [...coveredSessions].some(
      (covered) => covered.length < sessionId.length && sessionId.startsWith(covered),
    );

  for (const plan of raw) {
    const sessions = plan.sessionIds ?? [];
    if (sessions.some(isCovered)) continue;
    if (plan.rawMarkdown && persistedMarkdown.has(plan.rawMarkdown.trim())) continue;
    result.push({ plan, rawOnly: true });
  }

  return result;
}
