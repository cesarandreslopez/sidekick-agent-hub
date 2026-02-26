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
import type { PlanBoardState, PlanBoardMessage, WebviewPlanBoardMessage, ActivePlanDisplay, PlanHistoryEntry, PlanStepCard } from '../types/planBoard';
import type { PlanState } from '../types/claudeSession';
import type { PersistedPlan } from '../types/plan';
import { readClaudeCodePlanFiles } from 'sidekick-shared';
import { log } from '../services/Logger';
import { getNonce } from '../utils/nonce';

/**
 * WebviewViewProvider for the session plan board.
 */
export class PlanBoardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sidekick.planBoard';

  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];
  private _state: PlanBoardState;
  private _claudeCodePlans: PersistedPlan[] = [];
  private _claudeCodePlansLoaded = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionMonitor: SessionMonitor,
    private readonly _planPersistence?: PlanPersistenceService
  ) {
    this._state = {
      activePlan: null,
      historicalPlans: [],
      sessionActive: false,
    };

    this._disposables.push(
      this._sessionMonitor.onToolCall(() => this._updateBoard())
    );

    this._disposables.push(
      this._sessionMonitor.onSessionStart(() => {
        this._state.sessionActive = true;
        this._syncFromSessionMonitor();
        this._sendStateToWebview();
      })
    );

    this._disposables.push(
      this._sessionMonitor.onSessionEnd(() => {
        this._state.sessionActive = false;
        this._syncFromSessionMonitor();
        this._postMessage({ type: 'sessionEnd' });
        this._sendStateToWebview();
      })
    );

    if (this._sessionMonitor.isActive()) {
      this._syncFromSessionMonitor();
    } else {
      this._syncFromSessionMonitor();
    }

    // Load raw plan files from ~/.claude/plans/ asynchronously
    this._loadClaudeCodePlans();

    log('PlanBoardViewProvider initialized');
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
      (message: WebviewPlanBoardMessage) => this._handleWebviewMessage(message),
      undefined,
      this._disposables
    );

    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._sendStateToWebview();
        }
      },
      undefined,
      this._disposables
    );

    log('Plan board webview resolved');
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }

  private _handleWebviewMessage(message: WebviewPlanBoardMessage): void {
    switch (message.type) {
      case 'webviewReady':
        log('Plan board webview ready, sending initial state');
        this._sendStateToWebview();
        break;

      case 'refresh':
        this._syncFromSessionMonitor();
        this._sendStateToWebview();
        break;

      case 'copyPlanMarkdown': {
        const markdown = this._findPlanMarkdown(message.planId);
        if (markdown) {
          vscode.env.clipboard.writeText(markdown);
        }
        break;
      }
    }
  }

  private _findPlanMarkdown(planId: string): string | undefined {
    if (planId === 'active' && this._state.activePlan?.rawMarkdown) {
      return this._state.activePlan.rawMarkdown;
    }
    const hist = this._state.historicalPlans.find(p => p.id === planId);
    return hist?.rawMarkdown;
  }

  private async _loadClaudeCodePlans(): Promise<void> {
    try {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      this._claudeCodePlans = await readClaudeCodePlanFiles(workspacePath);
      this._claudeCodePlansLoaded = true;
      this._syncFromSessionMonitor();
      this._sendStateToWebview();
    } catch {
      this._claudeCodePlansLoaded = true;
    }
  }

  private _updateBoard(): void {
    this._syncFromSessionMonitor();
    this._sendStateToWebview();
  }

  private _syncFromSessionMonitor(): void {
    const stats = this._sessionMonitor.getStats();
    const planState = stats.planState;

    // Active plan from current session
    let activePlan: ActivePlanDisplay | null = null;
    if (planState && (planState.steps.length > 0 || planState.rawMarkdown)) {
      activePlan = this._planStateToDisplay(planState);
    }

    // Historical plans from persistence + raw Claude Code plan files
    let historicalPlans: PlanHistoryEntry[] = [];
    const activeSessionId = this._getActiveSessionPrefix();
    const seenIds = new Set<string>();

    if (this._planPersistence) {
      const persisted = this._planPersistence.getPlans();
      for (const p of persisted) {
        if (activeSessionId && p.sessionId.startsWith(activeSessionId)) continue;
        seenIds.add(p.id);
        historicalPlans.push(this._persistedToHistoryEntry(p));
      }
    }

    // Merge raw Claude Code plan files (deduplicate by sessionId)
    for (const p of this._claudeCodePlans) {
      if (seenIds.has(p.id)) continue;
      if (activeSessionId && p.sessionId.startsWith(activeSessionId)) continue;
      historicalPlans.push(this._persistedToHistoryEntry(p));
    }

    this._state = {
      activePlan,
      historicalPlans,
      sessionActive: this._sessionMonitor.isActive(),
    };
  }

  private _getActiveSessionPrefix(): string | null {
    const sessionPath = this._sessionMonitor.getSessionPath();
    if (!sessionPath) return null;
    const sessionId = this._sessionMonitor.getProvider().getSessionId(sessionPath);
    return sessionId.substring(0, 8);
  }

  private _planStateToDisplay(planState: PlanState): ActivePlanDisplay {
    const steps: PlanStepCard[] = planState.steps.map(s => ({
      id: s.id,
      description: s.description,
      status: s.status,
      phase: s.phase,
      complexity: s.complexity,
    }));

    const completed = steps.filter(s => s.status === 'completed').length;
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

  private _persistedToHistoryEntry(plan: PersistedPlan): PlanHistoryEntry {
    const steps: PlanStepCard[] = plan.steps.map(s => ({
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
    };
  }

  private _sendStateToWebview(): void {
    this._postMessage({ type: 'updatePlanBoard', state: this._state });
  }

  private _postMessage(message: PlanBoardMessage): void {
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
  <title>Plans</title>
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
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .header img {
      width: 20px;
      height: 20px;
    }

    .header h1 {
      font-size: 13px;
      font-weight: 600;
    }

    .status {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .status.active {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }

    .header-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .icon-button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 10px;
      line-height: 1;
      padding: 4px 7px;
      border-radius: 3px;
      cursor: pointer;
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
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 10px;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .plan-card.active-plan {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
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

    .chip.completed { background: var(--vscode-gitDecoration-addedResourceForeground, #2d8a4b); color: #fff; }
    .chip.in_progress { background: var(--vscode-gitDecoration-modifiedResourceForeground, #c59f1a); color: #000; }
    .chip.failed { background: var(--vscode-errorForeground, #f14c4c); color: #fff; }
    .chip.abandoned { background: var(--vscode-gitDecoration-ignoredResourceForeground, #888); color: #fff; }

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

    .collapsible-header {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0;
    }

    .collapsible-header:hover {
      opacity: 0.8;
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
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="Sidekick icon" />
    <h1>Plans</h1>
    <span id="status" class="status">Idle</span>
    <div class="header-actions">
      <button id="refresh" class="icon-button">Refresh</button>
    </div>
  </div>
  <div class="search-container">
    <input id="search" type="text" placeholder="Search plans..." />
  </div>
  <div class="filter-bar" id="filterBar">
    <span class="filter-chip active" data-filter="date" data-value="all">All</span>
    <span class="filter-chip" data-filter="date" data-value="today">Today</span>
    <span class="filter-chip" data-filter="date" data-value="7d">7d</span>
    <span class="filter-chip" data-filter="date" data-value="30d">30d</span>
    <span class="filter-divider"></span>
    <span class="filter-chip" data-filter="source" data-value="claude-code">claude-code</span>
    <span class="filter-chip" data-filter="source" data-value="opencode">opencode</span>
    <span class="filter-chip" data-filter="source" data-value="codex">codex</span>
    <span class="filter-divider"></span>
    <span class="filter-chip" data-filter="status" data-value="completed">completed</span>
    <span class="filter-chip" data-filter="status" data-value="failed">failed</span>
    <span class="filter-chip" data-filter="status" data-value="abandoned">abandoned</span>
  </div>
  <div id="content" class="content"></div>
  <div id="empty" class="empty-state" hidden>
    <p>No plans yet. Plans appear when Claude Code enters plan mode.</p>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const contentEl = document.getElementById('content');
    const emptyEl = document.getElementById('empty');
    const statusEl = document.getElementById('status');
    const refreshBtn = document.getElementById('refresh');
    const searchInput = document.getElementById('search');
    const filterBar = document.getElementById('filterBar');

    var lastState = null;
    var currentSearchQuery = '';
    var activeFilters = { date: 'all', source: null, status: null };

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

    function formatDate(value) {
      if (!value) return '';
      var d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    }

    function formatDuration(ms) {
      if (!ms) return '';
      var secs = ms / 1000;
      if (secs < 60) return secs.toFixed(1) + 's';
      var mins = Math.floor(secs / 60);
      var rem = Math.floor(secs % 60);
      return mins + 'm' + rem + 's';
    }

    function fmtNum(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n.toLocaleString();
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
        if (activeFilters.status && plan.status !== activeFilters.status) return false;
        return true;
      });
    }

    function render(state) {
      if (!state) return;
      lastState = state;

      statusEl.textContent = state.sessionActive ? 'Active' : 'Idle';
      statusEl.classList.toggle('active', state.sessionActive);

      var filtered = state.historicalPlans ? filterHistoricalPlans(state.historicalPlans) : [];
      var hasPlans = state.activePlan || filtered.length > 0;

      if (!hasPlans) {
        emptyEl.hidden = false;
        emptyEl.style.display = 'flex';
        contentEl.style.display = 'none';
        return;
      }

      emptyEl.hidden = true;
      emptyEl.style.display = 'none';
      contentEl.style.display = 'flex';
      contentEl.innerHTML = '';

      // Active plan
      if (state.activePlan) {
        var sectionTitle = document.createElement('div');
        sectionTitle.className = 'section-title';
        sectionTitle.textContent = 'Active Plan';
        contentEl.appendChild(sectionTitle);

        contentEl.appendChild(renderActivePlan(state.activePlan));
      }

      // Historical plans (filtered)
      if (filtered.length > 0) {
        var histTitle = document.createElement('div');
        histTitle.className = 'section-title';
        histTitle.textContent = 'History (' + filtered.length + ')';
        contentEl.appendChild(histTitle);

        filtered.forEach(function(plan) {
          contentEl.appendChild(renderHistoryCard(plan));
        });
      }
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
      statusChip.textContent = plan.active ? 'Active' : 'Done';
      meta.appendChild(statusChip);

      var rateText = document.createElement('span');
      rateText.textContent = Math.round(plan.completionRate * 100) + '% complete';
      meta.appendChild(rateText);
      card.appendChild(meta);

      // Progress bar
      var barContainer = document.createElement('div');
      barContainer.className = 'progress-bar-container';
      var barFill = document.createElement('div');
      barFill.className = 'progress-bar-fill';
      barFill.style.width = Math.round(plan.completionRate * 100) + '%';
      barContainer.appendChild(barFill);
      card.appendChild(barContainer);

      // Steps
      card.appendChild(renderStepList(plan.steps));

      // Copy button
      if (plan.rawMarkdown) {
        var copyBtn = document.createElement('button');
        copyBtn.className = 'icon-button copy-btn';
        copyBtn.textContent = 'Copy Markdown';
        copyBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'copyPlanMarkdown', planId: 'active' });
        });
        card.appendChild(copyBtn);
      }

      return card;
    }

    function renderHistoryCard(plan) {
      var card = document.createElement('div');
      card.className = 'plan-card';

      // Collapsible header
      var header = document.createElement('div');
      header.className = 'collapsible-header';

      var arrow = document.createElement('span');
      arrow.className = 'collapse-arrow';
      arrow.textContent = '\\u25B6';
      header.appendChild(arrow);

      var title = document.createElement('span');
      title.className = 'plan-title';
      title.style.marginBottom = '0';
      title.textContent = plan.title;
      header.appendChild(title);

      var statusChip = document.createElement('span');
      statusChip.className = 'chip ' + plan.status;
      statusChip.textContent = plan.status.replace('_', ' ');
      header.appendChild(statusChip);

      if (plan.rawMarkdown) {
        var copyBtn = document.createElement('button');
        copyBtn.className = 'icon-button copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'copyPlanMarkdown', planId: plan.id });
        });
        header.appendChild(copyBtn);
      }

      card.appendChild(header);

      // Meta
      var meta = document.createElement('div');
      meta.className = 'plan-meta';
      var srcChip = document.createElement('span');
      srcChip.className = 'chip';
      srcChip.textContent = plan.source;
      meta.appendChild(srcChip);

      var rateText = document.createElement('span');
      rateText.textContent = Math.round(plan.completionRate * 100) + '%';
      meta.appendChild(rateText);

      var dateText = document.createElement('span');
      dateText.textContent = formatDate(plan.createdAt);
      meta.appendChild(dateText);

      card.appendChild(meta);

      // Collapsible content
      var content = document.createElement('div');
      content.className = 'collapsible-content';

      // Metrics
      var metrics = [];
      if (plan.totalDurationMs) metrics.push('Duration: ' + formatDuration(plan.totalDurationMs));
      if (plan.totalTokensUsed) metrics.push('Tokens: ' + fmtNum(plan.totalTokensUsed));
      if (plan.totalCostUsd) metrics.push('Cost: $' + plan.totalCostUsd.toFixed(4));
      if (plan.totalToolCalls) metrics.push('Tool calls: ' + plan.totalToolCalls);

      if (metrics.length > 0) {
        var metricsEl = document.createElement('div');
        metricsEl.className = 'plan-meta';
        metricsEl.style.marginBottom = '8px';
        metricsEl.textContent = metrics.join(' | ');
        content.appendChild(metricsEl);
      }

      // Progress bar
      var barContainer = document.createElement('div');
      barContainer.className = 'progress-bar-container';
      var barFill = document.createElement('div');
      barFill.className = 'progress-bar-fill';
      barFill.style.width = Math.round(plan.completionRate * 100) + '%';
      barContainer.appendChild(barFill);
      content.appendChild(barContainer);

      // Steps
      content.appendChild(renderStepList(plan.steps));

      card.appendChild(content);

      // Toggle collapse
      header.addEventListener('click', function() {
        var isOpen = content.classList.toggle('open');
        arrow.classList.toggle('open', isOpen);
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
        case 'sessionStart':
        case 'sessionEnd':
          break;
      }
    });

    refreshBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'refresh' });
    });

    searchInput.addEventListener('input', function() {
      currentSearchQuery = this.value.toLowerCase();
      render(lastState);
    });

    filterBar.addEventListener('click', function(e) {
      var chip = e.target.closest('.filter-chip');
      if (!chip) return;
      var filterType = chip.dataset.filter;
      var filterValue = chip.dataset.value;
      if (!filterType || !filterValue) return;

      // Date filters are exclusive (radio behavior)
      if (filterType === 'date') {
        activeFilters.date = filterValue;
        filterBar.querySelectorAll('[data-filter="date"]').forEach(function(c) {
          c.classList.toggle('active', c.dataset.value === filterValue);
        });
      } else {
        // Source/status filters are toggles
        var key = filterType;
        if (activeFilters[key] === filterValue) {
          activeFilters[key] = null;
          chip.classList.remove('active');
        } else {
          // Deactivate other chips in the same group
          filterBar.querySelectorAll('[data-filter="' + key + '"]').forEach(function(c) {
            c.classList.remove('active');
          });
          activeFilters[key] = filterValue;
          chip.classList.add('active');
        }
      }

      render(lastState);
    });

    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
  }
}
