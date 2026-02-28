/**
 * @fileoverview Task board webview provider for session task visualization.
 *
 * Renders a Trello/Kanban-style board using task state from SessionMonitor.
 * Tasks are grouped by status and updated in real time.
 *
 * @module providers/TaskBoardViewProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { TaskPersistenceService } from '../services/TaskPersistenceService';
import type { TaskStatus, TrackedTask } from '../types/claudeSession';
import type { PersistedTask } from '../types/taskPersistence';
import type { TaskBoardState, TaskBoardMessage, WebviewTaskBoardMessage, TaskBoardColumn, TaskCard } from '../types/taskBoard';
import { log } from '../services/Logger';
import { getNonce } from '../utils/nonce';
import { getDesignTokenCSS, getSharedStyles } from '../utils/designTokens';
import { getRandomPhrase } from 'sidekick-shared/dist/phrases';

/**
 * WebviewViewProvider for the session task board.
 */
export class TaskBoardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  /** View type identifier for VS Code registration */
  public static readonly viewType = 'sidekick.taskBoard';

  /** Current webview view instance */
  private _view?: vscode.WebviewView;

  /** Disposables for cleanup */
  private _disposables: vscode.Disposable[] = [];

  /** Current task board state */
  private _state: TaskBoardState;

  /** Column order for board rendering */
  private static readonly COLUMN_ORDER: TaskStatus[] = ['pending', 'in_progress', 'completed'];

  /** Column labels */
  private static readonly COLUMN_LABELS: Record<TaskStatus, string> = {
    pending: 'Pending',
    in_progress: 'In Progress',
    completed: 'Completed',
    deleted: 'Archived'
  };

  /** Cached persisted tasks loaded from disk */
  private _persistedTasks: PersistedTask[] = [];

  /** Timestamp of last auto-persistence write */
  private _lastPersistTime = 0;

  /** Minimum interval between auto-persistence writes (ms) */
  private readonly _PERSIST_INTERVAL_MS = 30_000;

  /** Interval for rotating header phrase */
  private _phraseInterval?: ReturnType<typeof setInterval>;

  /** Interval for rotating empty-state phrase */
  private _emptyPhraseInterval?: ReturnType<typeof setInterval>;

  /**
   * Creates a new TaskBoardViewProvider.
   */
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionMonitor: SessionMonitor,
    private readonly _taskPersistence?: TaskPersistenceService
  ) {
    this._state = {
      columns: TaskBoardViewProvider.COLUMN_ORDER.map(status => ({
        status,
        label: TaskBoardViewProvider.COLUMN_LABELS[status],
        tasks: []
      })),
      sessionActive: false,
      lastUpdated: new Date().toISOString(),
      totalTasks: 0,
      activeTaskId: null,
      carriedOverCount: 0
    };

    this._disposables.push(
      this._sessionMonitor.onToolCall(() => this._updateBoard())
    );

    this._disposables.push(
      this._sessionMonitor.onSessionStart(path => this._handleSessionStart(path))
    );

    this._disposables.push(
      this._sessionMonitor.onSessionEnd(() => this._handleSessionEnd())
    );

    if (this._sessionMonitor.isActive()) {
      this._syncFromSessionMonitor();
    } else if (this._taskPersistence) {
      // No active session but we have persistence — show carried-over tasks
      this._persistedTasks = this._taskPersistence.loadPersistedTasks();
      this._syncFromSessionMonitor();
    }

    log('TaskBoardViewProvider initialized');
  }

  /**
   * Resolves the webview view when it becomes visible.
   */
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
      (message: WebviewTaskBoardMessage) => this._handleWebviewMessage(message),
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

    this._startPhraseTimers();
    log('Task board webview resolved');
  }

  private _startPhraseTimers(): void {
    this._clearPhraseTimers();
    this._phraseInterval = setInterval(() => {
      this._postMessage({ type: 'updatePhrase', phrase: getRandomPhrase() });
    }, 60_000);
    this._emptyPhraseInterval = setInterval(() => {
      if (!this._state.sessionActive) {
        this._postMessage({ type: 'updateEmptyPhrase', phrase: getRandomPhrase() });
      }
    }, 30_000);
  }

  private _clearPhraseTimers(): void {
    if (this._phraseInterval) { clearInterval(this._phraseInterval); this._phraseInterval = undefined; }
    if (this._emptyPhraseInterval) { clearInterval(this._emptyPhraseInterval); this._emptyPhraseInterval = undefined; }
  }

  /**
   * Disposes of provider resources.
   */
  dispose(): void {
    // Save current tasks to persistence if session is active
    if (this._taskPersistence && this._sessionMonitor.isActive()) {
      this._saveCurrentTasksToPersistence();
    }
    this._clearPhraseTimers();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }

  /**
   * Handles messages from the webview.
   */
  private _handleWebviewMessage(message: WebviewTaskBoardMessage): void {
    switch (message.type) {
      case 'webviewReady':
        log('Task board webview ready, sending initial state');
        this._sendStateToWebview();
        break;

      case 'requestBoard':
        this._syncFromSessionMonitor();
        this._sendStateToWebview();
        break;

      case 'clearCompleted':
        if (this._taskPersistence) {
          this._taskPersistence.clearCompleted();
          this._persistedTasks = this._taskPersistence.loadPersistedTasks();
          this._syncFromSessionMonitor();
          this._sendStateToWebview();
        }
        break;

      case 'archiveAll':
        if (this._taskPersistence) {
          this._taskPersistence.archiveAll();
          this._persistedTasks = this._taskPersistence.loadPersistedTasks();
          this._syncFromSessionMonitor();
          this._sendStateToWebview();
        }
        break;
    }
  }

  /**
   * Updates board from current session data.
   */
  private _updateBoard(): void {
    this._syncFromSessionMonitor();
    this._sendStateToWebview();
    this._maybePersistTasks();
  }

  /**
   * Debounced auto-persistence during active sessions.
   * Writes current tasks to disk at most once per PERSIST_INTERVAL_MS.
   */
  private _maybePersistTasks(): void {
    if (!this._taskPersistence || !this._sessionMonitor.isActive()) return;
    if (Date.now() - this._lastPersistTime < this._PERSIST_INTERVAL_MS) return;
    this._lastPersistTime = Date.now();
    this._saveCurrentTasksToPersistence();
  }

  /**
   * Handles session start events.
   */
  private _handleSessionStart(sessionPath: string): void {
    log(`Task board: session started at ${sessionPath}`);
    this._state.sessionActive = true;

    // Load persisted tasks for merging with new session
    if (this._taskPersistence) {
      this._persistedTasks = this._taskPersistence.loadPersistedTasks();
    }

    this._syncFromSessionMonitor();
    this._postMessage({ type: 'sessionStart', sessionPath });
    this._sendStateToWebview();
  }

  /**
   * Handles session end events.
   */
  private _handleSessionEnd(): void {
    log('Task board: session ended');

    // Save current tasks to persistence before ending
    this._saveCurrentTasksToPersistence();

    this._state.sessionActive = false;
    this._postMessage({ type: 'sessionEnd' });

    // Reload persisted tasks so board shows them post-session
    if (this._taskPersistence) {
      this._persistedTasks = this._taskPersistence.loadPersistedTasks();
    }
    this._syncFromSessionMonitor();
    this._sendStateToWebview();
  }

  /**
   * Syncs state from SessionMonitor, merging in persisted tasks.
   */
  private _syncFromSessionMonitor(): void {
    const stats = this._sessionMonitor.getStats();
    const taskState = stats.taskState;
    const activeTaskId = taskState?.activeTaskId ?? null;
    const tasks = taskState?.tasks ?? new Map<string, TrackedTask>();

    const columns: TaskBoardColumn[] = TaskBoardViewProvider.COLUMN_ORDER.map(status => ({
      status,
      label: TaskBoardViewProvider.COLUMN_LABELS[status],
      tasks: []
    }));

    const columnLookup = new Map<TaskStatus, TaskBoardColumn>(
      columns.map(column => [column.status, column])
    );

    // Add current session tasks
    const currentTaskIds = new Set<string>();
    for (const task of tasks.values()) {
      const status = task.status ?? 'pending';
      if (status === 'deleted') {
        continue;
      }
      currentTaskIds.add(task.taskId);
      const column = columnLookup.get(status) ?? columnLookup.get('pending');
      if (column) {
        column.tasks.push(this._toCard(task, activeTaskId));
      }
    }

    // Merge persisted tasks not in the current session
    let carriedOverCount = 0;
    for (const persisted of this._persistedTasks) {
      if (currentTaskIds.has(persisted.taskId)) {
        continue;
      }
      const status = persisted.status === 'deleted' ? 'pending' : persisted.status;
      const column = columnLookup.get(status) ?? columnLookup.get('pending');
      if (column) {
        column.tasks.push(this._persistedToCard(persisted));
        carriedOverCount++;
      }
    }

    // Sort: current session tasks first, then carried-over, both by updatedAt desc
    for (const column of columns) {
      column.tasks.sort((a, b) => {
        if (a.carriedOver !== b.carriedOver) {
          return a.carriedOver ? 1 : -1;
        }
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    }

    const totalTasks = tasks.size + carriedOverCount;

    this._state = {
      columns,
      sessionActive: this._sessionMonitor.isActive(),
      lastUpdated: new Date().toISOString(),
      totalTasks,
      activeTaskId,
      carriedOverCount
    };
  }

  /**
   * Converts a tracked task to a display card.
   */
  private _toCard(task: TrackedTask, activeTaskId: string | null): TaskCard {
    return {
      taskId: task.taskId,
      subject: task.subject || 'Untitled task',
      description: task.description,
      status: task.status,
      activeForm: task.activeForm,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      toolCallCount: task.associatedToolCalls.length,
      blockedBy: task.blockedBy,
      blocks: task.blocks,
      isActive: task.isSubagent ? false : activeTaskId === task.taskId,
      isSubagent: task.isSubagent,
      subagentType: task.subagentType,
      isGoalGate: task.isGoalGate,
    };
  }

  /**
   * Converts a persisted task to a display card.
   */
  private _persistedToCard(task: PersistedTask): TaskCard {
    const displayId = task.sessionOrigin
      ? `${task.sessionOrigin.slice(0, 8)}:${task.taskId}`
      : task.taskId;

    return {
      taskId: displayId,
      subject: task.subject,
      description: task.description,
      status: task.status,
      activeForm: task.activeForm,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      toolCallCount: task.toolCallCount,
      blockedBy: task.blockedBy,
      blocks: task.blocks,
      isActive: false,
      isSubagent: task.isSubagent,
      subagentType: task.subagentType,
      carriedOver: true,
      sessionOrigin: task.sessionOrigin,
      sessionAge: task.sessionAge,
      tags: task.tags,
      isGoalGate: task.isGoalGate,
    };
  }

  /**
   * Saves current session tasks to the persistence service.
   */
  private _saveCurrentTasksToPersistence(): void {
    if (!this._taskPersistence) {
      return;
    }

    const sessionPath = this._sessionMonitor.getSessionPath();
    if (!sessionPath) {
      return;
    }

    const sessionId = this._sessionMonitor.getProvider().getSessionId(sessionPath);
    const stats = this._sessionMonitor.getStats();
    const taskState = stats.taskState;

    if (taskState) {
      this._taskPersistence.saveSessionTasks(sessionId, taskState);
      log(`Task board: persisted tasks for session ${sessionId.slice(0, 8)}`);
    }
  }

  /**
   * Sends current state to the webview.
   */
  private _sendStateToWebview(): void {
    this._postMessage({ type: 'updateBoard', state: this._state });
  }

  /**
   * Posts a message to the webview.
   */
  private _postMessage(message: TaskBoardMessage): void {
    this._view?.webview.postMessage(message);
  }

  /**
   * Generates HTML content for the webview.
   */
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
  <title>Kanban Board</title>
  ${getDesignTokenCSS()}
  ${getSharedStyles()}
  <style>
    :root {
      --board-gap: 10px;
      --column-bg: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background));
      --card-bg: var(--vscode-editor-background);
      --card-border: var(--vscode-panel-border);
      --card-shadow: rgba(0, 0, 0, 0.12);
    }

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

    .header-phrase, .empty-state-phrase {
      font-size: var(--sk-font-base);
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      margin: 0;
    }

    .header-phrase {
      padding: 2px var(--sk-space-3) var(--sk-space-2) 40px;
    }

    .status {
      font-size: var(--sk-font-sm);
      padding: 2px var(--sk-space-2);
      border-radius: var(--sk-radius-sm);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .status.active {
      background: var(--sk-accent-success);
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

    .icon-button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .summary {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .board {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: var(--board-gap);
      padding: 10px;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .column {
      background: var(--column-bg);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .column-header {
      padding: 8px 10px;
      font-size: 11px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .column-header .right {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .column-header .count {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
    }

    .column-header .collapse {
      font-size: 9px;
      padding: 3px 6px;
    }

    .collapsed-summary {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 8px 10px;
      border-bottom: 1px dashed var(--vscode-panel-border);
    }

    .column-body {
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow-y: auto;
    }

    .column.collapsed .column-body {
      display: none;
    }

    .column.collapsed {
      max-height: none;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--sk-radius-xl);
      padding: var(--sk-space-2);
      box-shadow: var(--sk-shadow-sm);
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
      transition: transform var(--sk-transition-fast), box-shadow var(--sk-transition-fast);
    }

    .card:hover {
      transform: translateY(-1px);
      box-shadow: var(--sk-shadow-md);
    }

    .card.active {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }

    .card.carried-over {
      opacity: 0.85;
      border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
    }

    .chip.carried-over {
      background: var(--vscode-editorWarning-foreground, #cca700);
      color: var(--vscode-editor-background);
      font-size: 9px;
    }

    .card.subagent {
      border-left: 3px solid var(--vscode-terminal-ansiCyan, #4ec9b0);
    }

    .card.goal-gate {
      border-left: 3px solid var(--vscode-errorForeground, #f14c4c);
    }

    .card.goal-gate .card-title::before {
      content: '\u26A0 ';
      color: var(--vscode-errorForeground, #f14c4c);
    }

    .chip.agent-type {
      background: var(--vscode-terminal-ansiCyan, #4ec9b0);
      color: var(--vscode-editor-background);
    }

    .card-title {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
    }

    .card-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .chip {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 12px;
      padding: 1px 6px;
      font-size: 9px;
      font-weight: 600;
    }

    .card-desc {
      font-size: 11px;
      color: var(--vscode-foreground);
      opacity: 0.9;
    }

    .card-activity {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
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

    .column[data-status="pending"] {
      border-top: 3px solid var(--vscode-gitDecoration-ignoredResourceForeground, #888);
    }

    .column[data-status="in_progress"] {
      border-top: 3px solid var(--vscode-gitDecoration-modifiedResourceForeground, #c59f1a);
    }

    .column[data-status="completed"] {
      border-top: 3px solid var(--vscode-gitDecoration-addedResourceForeground, #2d8a4b);
    }

    .column[data-status="deleted"] {
      border-top: 3px solid var(--vscode-gitDecoration-deletedResourceForeground, #b24a4a);
    }

    @media (max-width: 600px) {
      .board {
        padding: 8px;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="Sidekick icon" />
    <h1>Kanban Board</h1>
    <span id="status" class="status" aria-live="polite">Idle</span>
    <div class="header-actions">
      <span id="summary" class="summary"></span>
      <button id="clearDone" class="icon-button" disabled>Clear Done</button>
      <button id="archiveAll" class="icon-button" disabled>Archive All</button>
      <button id="refresh" class="icon-button">Refresh</button>
    </div>
  </div>
  <p id="header-phrase" class="header-phrase">${getRandomPhrase()}</p>
  <div id="board" class="board"></div>
  <div id="empty" class="empty-state" hidden>
    <p>No tasks yet. Tasks appear when Claude Code creates tasks or spawns subagents.</p>
    <p id="empty-state-phrase" class="empty-state-phrase">${getRandomPhrase()}</p>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const boardEl = document.getElementById('board');
    const emptyEl = document.getElementById('empty');
    const statusEl = document.getElementById('status');
    const summaryEl = document.getElementById('summary');
    const refreshBtn = document.getElementById('refresh');
    const clearDoneBtn = document.getElementById('clearDone');
    const archiveAllBtn = document.getElementById('archiveAll');

    const COLUMN_ORDER = ['pending', 'in_progress', 'completed'];

    function formatTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString();
    }

    function render(state) {
      if (!state) return;

      statusEl.textContent = state.sessionActive ? 'Active' : 'Idle';
      statusEl.classList.toggle('active', state.sessionActive);

      const allCards = (state.columns || []).flatMap(function(c) { return c.tasks || []; });
      const agentCount = allCards.filter(function(t) { return t.isSubagent; }).length;
      const carriedCount = state.carriedOverCount || 0;
      const taskCount = state.totalTasks - agentCount;
      const parts = [];
      if (taskCount > 0) parts.push(taskCount + ' task' + (taskCount === 1 ? '' : 's'));
      if (agentCount > 0) parts.push(agentCount + ' agent' + (agentCount === 1 ? '' : 's'));
      if (parts.length === 0) parts.push('0 tasks');
      if (carriedCount > 0) parts.push(carriedCount + ' carried over');
      summaryEl.textContent = parts.join(', ')
        + ' · Updated '
        + formatTime(state.lastUpdated);

      // Update button states
      const hasCompleted = allCards.some(function(t) { return t.status === 'completed' && t.carriedOver; });
      const hasCarried = carriedCount > 0;
      clearDoneBtn.disabled = !hasCompleted;
      archiveAllBtn.disabled = !hasCarried;

      boardEl.innerHTML = '';

      const hasTasks = state.totalTasks > 0
        && state.columns
        && state.columns.some(column => column.tasks && column.tasks.length > 0);

      if (hasTasks) {
        emptyEl.hidden = true;
        emptyEl.style.display = 'none';
        boardEl.style.display = 'grid';
      } else {
        emptyEl.hidden = false;
        emptyEl.style.display = 'flex';
        boardEl.style.display = 'none';
        return;
      }

      const columnsByStatus = new Map(state.columns.map(column => [column.status, column]));
      const persisted = vscode.getState() || {};
      const nonEmptyColumns = state.columns
        .filter(column => column.tasks && column.tasks.length > 0);
      const nonEmptyCount = nonEmptyColumns.length;
      const singleActiveColumn = nonEmptyCount <= 1;

      COLUMN_ORDER.forEach(status => {
        const column = columnsByStatus.get(status);
        if (!column) return;
        const columnEl = document.createElement('section');
        columnEl.className = 'column';
        columnEl.dataset.status = column.status;

        const headerEl = document.createElement('div');
        headerEl.className = 'column-header';
        const isCollapsed = persisted['column:' + column.status] === true;
        const collapseButton = '<button class="icon-button collapse" data-status="'
            + column.status
            + '">'
            + (isCollapsed ? 'Expand' : 'Collapse')
            + '</button>';
        headerEl.innerHTML = '<span class="title">'
          + column.label
          + '</span><span class="right"><span class="count">'
          + column.tasks.length
          + '</span>'
          + collapseButton
          + '</span>';
        columnEl.appendChild(headerEl);

        const summaryEl = document.createElement('div');
        summaryEl.className = 'collapsed-summary';
        summaryEl.textContent = column.tasks.length === 0
          ? 'No tasks'
          : column.tasks.length + ' task' + (column.tasks.length === 1 ? '' : 's') + ' hidden';
        summaryEl.hidden = !isCollapsed;
        columnEl.appendChild(summaryEl);

        const bodyEl = document.createElement('div');
        bodyEl.className = 'column-body';
        if (isCollapsed) {
          columnEl.classList.add('collapsed');
          bodyEl.hidden = true;
        }

        if (column.tasks.length === 0) {
          const emptyColumn = document.createElement('div');
          emptyColumn.className = 'card-meta';
          emptyColumn.textContent = 'No tasks';
          bodyEl.appendChild(emptyColumn);
        } else {
          column.tasks.forEach(task => bodyEl.appendChild(renderCard(task)));
        }

        columnEl.appendChild(bodyEl);
        boardEl.appendChild(columnEl);
      });
    }

    function renderCard(task) {
      const card = document.createElement('article');
      const classes = ['card'];
      if (task.isActive) classes.push('active');
      if (task.isSubagent) classes.push('subagent');
      if (task.carriedOver) classes.push('carried-over');
      if (task.isGoalGate) classes.push('goal-gate');
      card.className = classes.join(' ');

      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = task.subject || 'Untitled task';
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'card-meta';
      if (task.isSubagent) {
        meta.textContent = 'Agent · Updated ' + formatTime(task.updatedAt);
      } else {
        meta.textContent = '#'
          + task.taskId
          + ' · Updated '
          + formatTime(task.updatedAt);
      }
      card.appendChild(meta);

      if (task.carriedOver) {
        const badge = document.createElement('span');
        badge.className = 'chip carried-over';
        var age = task.sessionAge || 0;
        badge.textContent = age <= 1 ? 'from last session' : 'from ' + age + ' sessions ago';
        card.appendChild(badge);
      }

      if (task.isSubagent && task.subagentType) {
        const typeChip = document.createElement('span');
        typeChip.className = 'chip agent-type';
        typeChip.textContent = task.subagentType;
        card.appendChild(typeChip);
      } else if (task.activeForm) {
        const activeChip = document.createElement('span');
        activeChip.className = 'chip';
        activeChip.textContent = task.activeForm;
        card.appendChild(activeChip);
      }

      if (task.description) {
        const desc = document.createElement('div');
        desc.className = 'card-desc';
        const maxLen = task.isSubagent ? 80 : 0;
        desc.textContent = maxLen && task.description.length > maxLen
          ? task.description.substring(0, maxLen) + '…'
          : task.description;
        card.appendChild(desc);
      }

      const activity = document.createElement('div');
      activity.className = 'card-activity';

      if (!task.isSubagent) {
        const toolChip = document.createElement('span');
        toolChip.className = 'chip';
        toolChip.textContent = task.toolCallCount
          + ' tool'
          + (task.toolCallCount === 1 ? '' : 's');
        activity.appendChild(toolChip);

        if (task.blockedBy && task.blockedBy.length > 0) {
          const blockedChip = document.createElement('span');
          blockedChip.className = 'chip';
          blockedChip.textContent = 'blocked by ' + task.blockedBy.length;
          activity.appendChild(blockedChip);
        }

        if (task.blocks && task.blocks.length > 0) {
          const blocksChip = document.createElement('span');
          blocksChip.className = 'chip';
          blocksChip.textContent = 'blocks ' + task.blocks.length;
          activity.appendChild(blocksChip);
        }
      }

      if (activity.childNodes.length > 0) {
        card.appendChild(activity);
      }

      return card;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message) return;
      switch (message.type) {
        case 'updateBoard':
          render(message.state);
          break;
        case 'sessionStart':
        case 'sessionEnd':
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

    refreshBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'requestBoard' });
    });

    clearDoneBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearCompleted' });
    });

    archiveAllBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'archiveAll' });
    });

    boardEl.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.classList.contains('collapse')) return;
      const status = target.dataset.status;
      if (!status) return;
      const key = 'column:' + status;
      const current = vscode.getState() || {};
      const next = Object.assign({}, current, { [key]: current[key] !== true });
      vscode.setState(next);
      vscode.postMessage({ type: 'requestBoard' });
    });

    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
  }
}

