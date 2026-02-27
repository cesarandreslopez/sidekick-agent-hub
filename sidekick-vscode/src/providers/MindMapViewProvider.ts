/**
 * @fileoverview Mind map webview provider for session activity visualization.
 *
 * This provider manages a sidebar webview that displays session activity
 * as an interactive D3.js force-directed graph. It shows files touched,
 * tools used, TODOs extracted, and subagents spawned.
 *
 * Features:
 * - D3.js force-directed graph layout
 * - Node type differentiation (files, tools, TODOs, subagents)
 * - Drag, zoom, and pan interactions
 * - Real-time updates from SessionMonitor
 *
 * @module providers/MindMapViewProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import { MindMapDataService } from '../services/MindMapDataService';
import type { MindMapState, MindMapMessage, WebviewMindMapMessage } from '../types/mindMap';
import type { KnowledgeNoteService } from '../services/KnowledgeNoteService';
import { log } from '../services/Logger';
import { getNonce } from '../utils/nonce';
import { getRandomPhrase } from 'sidekick-shared/dist/phrases';

/**
 * WebviewViewProvider for the session mind map visualization.
 *
 * Renders a sidebar panel with an interactive D3.js force-directed graph
 * showing files, tools, TODOs, and subagents from active Claude Code sessions.
 *
 * @example
 * ```typescript
 * const provider = new MindMapViewProvider(context.extensionUri, sessionMonitor);
 * vscode.window.registerWebviewViewProvider('sidekick.mindMap', provider);
 * ```
 */
export class MindMapViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  /** View type identifier for VS Code registration */
  public static readonly viewType = 'sidekick.mindMap';

  /** Current webview view instance */
  private _view?: vscode.WebviewView;

  /** Disposables for cleanup */
  private _disposables: vscode.Disposable[] = [];

  /** Current mind map state */
  private _state: MindMapState;

  /** Optional knowledge note service for note nodes */
  private _knowledgeNoteService?: KnowledgeNoteService;

  /** Interval for rotating header phrase */
  private _phraseInterval?: ReturnType<typeof setInterval>;

  /** Interval for rotating empty-state phrase */
  private _emptyPhraseInterval?: ReturnType<typeof setInterval>;

  /**
   * Creates a new MindMapViewProvider.
   *
   * @param _extensionUri - URI of the extension directory
   * @param _sessionMonitor - SessionMonitor instance for session events
   */
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionMonitor: SessionMonitor
  ) {
    // Initialize empty state
    this._state = {
      graph: { nodes: [], links: [] },
      sessionActive: false,
      lastUpdated: new Date().toISOString()
    };

    // Subscribe to session events
    this._disposables.push(
      this._sessionMonitor.onTokenUsage(() => this._updateGraph())
    );

    this._disposables.push(
      this._sessionMonitor.onToolCall(() => this._updateGraph())
    );

    this._disposables.push(
      this._sessionMonitor.onSessionStart(path => this._handleSessionStart(path))
    );

    this._disposables.push(
      this._sessionMonitor.onSessionEnd(() => this._handleSessionEnd())
    );

    // Initialize state from existing session if active
    if (this._sessionMonitor.isActive()) {
      this._syncFromSessionMonitor();
    }

    log('MindMapViewProvider initialized');
  }

  /**
   * Sets the optional KnowledgeNoteService for rendering note nodes.
   */
  setKnowledgeNoteService(service: KnowledgeNoteService): void {
    this._knowledgeNoteService = service;
  }

  /**
   * Resolves the webview view when it becomes visible.
   *
   * Called by VS Code when the view needs to be rendered.
   *
   * @param webviewView - The webview view to resolve
   * @param _context - Context for the webview
   * @param _token - Cancellation token
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    // Configure webview options
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'out', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'images')
      ]
    };

    // Set HTML content
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMindMapMessage) => this._handleWebviewMessage(message),
      undefined,
      this._disposables
    );

    // Resend state when view becomes visible
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
    log('Mind map webview resolved');
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
   * Handles messages from the webview.
   *
   * @param message - Message from webview
   */
  private _handleWebviewMessage(message: WebviewMindMapMessage): void {
    switch (message.type) {
      case 'webviewReady':
        log('Mind map webview ready, sending initial state');
        this._sendStateToWebview();
        break;

      case 'requestGraph':
        this._syncFromSessionMonitor();
        this._sendStateToWebview();
        break;

      case 'nodeClicked':
        this._handleNodeClick(message.nodeId);
        break;
    }
  }

  /**
   * Handles node click events from webview.
   *
   * If clicked node is a file, opens the file in the editor.
   * If clicked node is a URL, opens the URL in the default browser.
   *
   * @param nodeId - ID of the clicked node
   */
  private _handleNodeClick(nodeId: string): void {
    // If it's a file node, try to open the file
    if (nodeId.startsWith('file-')) {
      const filePath = nodeId.replace('file-', '');
      const uri = vscode.Uri.file(filePath);
      vscode.workspace.openTextDocument(uri).then(
        doc => vscode.window.showTextDocument(doc),
        () => log(`Could not open file: ${filePath}`)
      );
    }
    // If it's a URL node, open in browser
    else if (nodeId.startsWith('url-')) {
      const urlOrQuery = nodeId.replace('url-', '');
      try {
        // Check if it's a valid URL
        const url = new URL(urlOrQuery);
        vscode.env.openExternal(vscode.Uri.parse(url.href));
      } catch {
        // It's a search query, open as a web search
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(urlOrQuery)}`;
        vscode.env.openExternal(vscode.Uri.parse(searchUrl));
      }
    }
  }

  /**
   * Updates graph from current session data.
   */
  private _updateGraph(): void {
    this._syncFromSessionMonitor();
    this._sendStateToWebview();
    this._postMessage({ type: 'updatePhrase', phrase: getRandomPhrase() });
  }

  /**
   * Handles session start events.
   *
   * @param sessionPath - Path to the session file
   */
  private _handleSessionStart(sessionPath: string): void {
    log(`Mind map: session started at ${sessionPath}`);
    this._state.sessionActive = true;
    this._syncFromSessionMonitor();
    this._postMessage({ type: 'sessionStart', sessionPath });
    this._sendStateToWebview();
  }

  /**
   * Handles session end events.
   */
  private _handleSessionEnd(): void {
    log('Mind map: session ended');
    this._state.sessionActive = false;
    this._postMessage({ type: 'sessionEnd' });
    this._sendStateToWebview();
  }

  /**
   * Syncs state from SessionMonitor.
   */
  private _syncFromSessionMonitor(): void {
    const stats = this._sessionMonitor.getStats();
    const subagents = this._sessionMonitor.getSubagentStats();
    const knowledgeNotes = this._knowledgeNoteService?.getActiveNotes();
    this._state.graph = MindMapDataService.buildGraph(stats, subagents, knowledgeNotes);
    this._state.sessionActive = this._sessionMonitor.isActive();
    this._state.lastUpdated = new Date().toISOString();
  }

  /**
   * Sends current state to the webview.
   */
  private _sendStateToWebview(): void {
    this._postMessage({ type: 'updateGraph', state: this._state });
  }

  /**
   * Posts a message to the webview.
   *
   * @param message - Message to post
   */
  private _postMessage(message: MindMapMessage): void {
    this._view?.webview.postMessage(message);
  }

  /**
   * Generates HTML content for the webview.
   *
   * @param webview - The webview to generate HTML for
   * @returns HTML string for the webview
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
                 script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
  <title>Session Mind Map</title>
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
      overflow: hidden;
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

    .header-phrase, .empty-state-phrase {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      margin: 0;
    }

    .header-phrase {
      padding: 2px 12px 6px 40px;
    }

    .status {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
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

    .icon-button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .status.active {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }

    #graph-container {
      width: 100%;
      height: calc(100vh - 45px);
    }

    #graph-container svg {
      width: 100%;
      height: 100%;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: calc(100vh - 45px);
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 20px;
    }

    .empty-state p {
      margin-top: 8px;
      font-size: 12px;
    }

    /* Node styling */
    .node {
      cursor: grab;
    }

    .node:active {
      cursor: grabbing;
    }

    /* Clickable nodes (files and URLs) */
    .node.clickable {
      cursor: pointer;
    }

    .node.clickable:hover {
      filter: brightness(1.3);
    }

    .node-label {
      font-size: 9px;
      fill: var(--vscode-foreground);
      pointer-events: none;
      text-anchor: middle;
    }

    .change-label {
      font-size: 8px;
      pointer-events: none;
      text-anchor: middle;
      font-family: var(--vscode-editor-font-family);
    }

    .change-label .add {
      fill: var(--vscode-charts-green, #4caf50);
    }

    .change-label .del {
      fill: var(--vscode-charts-red, #f44336);
    }

    .link {
      stroke: var(--vscode-panel-border);
      stroke-opacity: 0.6;
    }

    .link.latest {
      stroke: var(--vscode-charts-yellow, #FFD700);
      stroke-opacity: 1;
      stroke-width: 3;
      filter: drop-shadow(0 0 4px var(--vscode-charts-yellow, #FFD700));
    }

    .link.task-action {
      stroke: var(--vscode-charts-orange, #FF6B6B);
      stroke-opacity: 0.5;
      stroke-dasharray: 4, 2;
    }

    .link.task-dependency {
      stroke: var(--vscode-charts-red, #D0021B);
      stroke-opacity: 0.7;
      stroke-dasharray: 6, 3;
      stroke-width: 2;
    }

    /* Task status styling */
    .node.task-pending {
      stroke: var(--vscode-charts-yellow, #FFD700);
      stroke-width: 2;
    }

    .node.task-in-progress {
      stroke: var(--vscode-charts-green, #4caf50);
      stroke-width: 3;
      animation: task-pulse 1.5s ease-in-out infinite;
    }

    .node.task-completed {
      opacity: 0.7;
    }

    @keyframes task-pulse {
      0%, 100% { stroke-opacity: 1; }
      50% { stroke-opacity: 0.4; }
    }

    @keyframes latest-pulse {
      0%, 100% { filter: drop-shadow(0 0 3px var(--vscode-charts-yellow, #FFD700)); opacity: 1; }
      50% { filter: drop-shadow(0 0 8px var(--vscode-charts-yellow, #FFD700)); opacity: 0.8; }
    }

    .node.latest {
      animation: latest-pulse 2s ease-in-out infinite;
    }

    /* Plan step status styling */
    .node.plan-step-pending {
      stroke: var(--vscode-charts-yellow, #FFD700);
      stroke-width: 2;
    }

    .node.plan-step-in_progress {
      stroke: var(--vscode-charts-green, #4caf50);
      stroke-width: 3;
      animation: task-pulse 1.5s ease-in-out infinite;
    }

    .node.plan-step-completed {
      opacity: 0.7;
    }

    .node.plan-step-failed {
      stroke: var(--vscode-charts-red, #f14c4c);
      stroke-width: 2;
    }

    .node.plan-step-skipped {
      opacity: 0.4;
      stroke-dasharray: 3, 2;
    }

    .node.plan-active {
      stroke: #00BCD4;
      stroke-width: 3;
      animation: task-pulse 2s ease-in-out infinite;
    }

    .link.plan-sequence {
      stroke: #00BCD4;
      stroke-opacity: 0.5;
      stroke-dasharray: 3, 2;
    }

    .link.knowledge-note {
      stroke: #FFB74D;
      stroke-opacity: 0.5;
      stroke-dasharray: 2, 2;
    }

    /* Tooltip */
    .tooltip {
      position: absolute;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 11px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 1000;
      max-width: 300px;
      word-wrap: break-word;
      white-space: pre-line;
    }

    .tooltip .additions {
      color: var(--vscode-charts-green, #4caf50);
    }

    .tooltip .deletions {
      color: var(--vscode-charts-red, #f44336);
    }

    .tooltip.visible {
      opacity: 1;
    }

    .legend {
      position: absolute;
      bottom: 10px;
      left: 10px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 10px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .legend-item:hover {
      opacity: 1 !important;
    }

    .legend-item.dimmed {
      opacity: 0.35;
    }

    .legend-item.locked {
      outline: 1px solid var(--vscode-focusBorder);
      border-radius: 3px;
      padding: 1px 3px;
      margin-left: -3px;
    }

    .legend-item:last-child {
      margin-bottom: 0;
    }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    circle.node {
      transition: opacity 0.3s, filter 0.3s;
    }
    line.link, path.link-path {
      transition: opacity 0.3s;
    }
    circle.node.faded {
      opacity: 0.08;
    }
    line.link.faded, path.link-path.faded {
      opacity: 0.05;
    }
    circle.node.highlighted {
      filter: brightness(1.3) drop-shadow(0 0 6px currentColor);
    }

    .layout-active {
      background: var(--vscode-button-background) !important;
      color: var(--vscode-button-foreground) !important;
    }

    .link-path {
      fill: none;
      stroke: var(--vscode-panel-border);
      stroke-opacity: 0.6;
      stroke-width: 1.5;
    }

    .link-path.latest {
      stroke: var(--vscode-charts-yellow, #FFD700);
      stroke-opacity: 1;
      stroke-width: 3;
      filter: drop-shadow(0 0 4px var(--vscode-charts-yellow, #FFD700));
    }

    .link-path.task-action {
      stroke: var(--vscode-charts-orange, #FF6B6B);
      stroke-opacity: 0.5;
      stroke-dasharray: 4, 2;
    }

    .link-path.task-dependency {
      stroke: var(--vscode-charts-red, #D0021B);
      stroke-opacity: 0.7;
      stroke-dasharray: 6, 3;
      stroke-width: 2;
    }

    .link-path.plan-sequence {
      stroke: #00BCD4;
      stroke-opacity: 0.5;
      stroke-dasharray: 3, 2;
    }

    .link-path.knowledge-note {
      stroke: #FFB74D;
      stroke-opacity: 0.5;
      stroke-dasharray: 2, 2;
    }

    .node.circular-mode {
      cursor: default;
    }

    .node.circular-mode:active {
      cursor: default;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="Sidekick" />
    <h1>Mind Map</h1>
    <div class="header-actions">
      <button id="toggle-layout" class="icon-button" type="button" title="Toggle circular layout" disabled>Circular</button>
      <button id="reset-layout" class="icon-button" type="button" title="Reset graph layout" disabled>Reset Layout</button>
      <span id="status" class="status">No Session</span>
    </div>
  </div>
  <p id="header-phrase" class="header-phrase">${getRandomPhrase()}</p>

  <div id="empty-state" class="empty-state">
    <p>No active Claude Code session detected.</p>
    <p>Start a session to see the mind map.</p>
    <p id="empty-state-phrase" class="empty-state-phrase">${getRandomPhrase()}</p>
  </div>

  <div id="graph-container" style="display: none;">
    <svg id="graph"></svg>
  </div>

  <div class="tooltip" id="tooltip"></div>

  <div class="legend" id="legend" style="display: none;">
    <div class="legend-item">
      <span class="legend-dot" style="background: #9B9B9B;"></span>
      <span>Session</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #4A90E2;"></span>
      <span>File</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #7ED321;"></span>
      <span>Tool</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #F5A623;"></span>
      <span>TODO</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #BD10E0;"></span>
      <span>Subagent</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #8B572A;"></span>
      <span>Directory</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #D0021B;"></span>
      <span>Command</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #FF6B6B;"></span>
      <span>Task</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #00BCD4;"></span>
      <span>Plan</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background: #FFB74D;"></span>
      <span>Note</span>
    </div>
  </div>

  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();

      // Node colors by type
      const NODE_COLORS = {
        session: '#9B9B9B',
        file: '#4A90E2',
        tool: '#7ED321',
        todo: '#F5A623',
        subagent: '#BD10E0',
        url: '#50E3C2',
        directory: '#8B572A',  // Brown - represents folders
        command: '#D0021B',    // Red - represents terminal commands
        task: '#FF6B6B',       // Coral red - represents tasks
        plan: '#00BCD4',       // Teal - plan root
        'plan-step': '#26C6DA', // Lighter teal - plan steps
        'knowledge-note': '#FFB74D' // Amber - knowledge notes
      };

      // Force tuning for sparse vs dense graph layouts
      const FORCE_CONFIG = {
        baseLinkDistance: 62,
        denseLinkDistance: 74,
        baseCharge: -90,
        denseCharge: -140,
        baseCollisionPadding: 11,
        denseCollisionPadding: 16,
        baseChargeDistanceMax: 240,
        denseChargeDistanceMax: 360,
        baseAxisStrength: 0.015,
        denseAxisStrength: 0.035
      };

      // Sizing configuration for dynamic node sizes
      const SIZING_CONFIG = {
        session:   { base: 16, min: 16, max: 16, scale: 0 },     // Fixed
        file:      { base: 8,  min: 6,  max: 18, scale: 3 },     // Scales with touches
        tool:      { base: 6,  min: 5,  max: 16, scale: 2.5 },   // Scales with calls
        todo:      { base: 6,  min: 6,  max: 6,  scale: 0 },     // Fixed
        subagent:  { base: 8,  min: 6,  max: 14, scale: 2 },     // Scales with events
        url:       { base: 7,  min: 5,  max: 14, scale: 2 },     // Scales with accesses
        directory: { base: 7,  min: 5,  max: 14, scale: 2 },     // Scales with searches
        command:   { base: 7,  min: 5,  max: 14, scale: 2 },     // Scales with executions
        task:        { base: 10, min: 8,  max: 16, scale: 2 },     // Scales with associated actions
        plan:        { base: 14, min: 14, max: 14, scale: 0 },     // Fixed, prominent
        'plan-step': { base: 8,  min: 6,  max: 12, scale: 2 },     // Scales with links
        'knowledge-note': { base: 7, min: 6, max: 10, scale: 0 }   // Fixed, small
      };

      function calculateNodeSize(d) {
        const config = SIZING_CONFIG[d.type] || SIZING_CONFIG.file;
        // For plan steps, scale by token usage if available
        if (d.type === 'plan-step' && d.planStepTokens) {
          const tokenScale = config.base + 2 * Math.log2(d.planStepTokens / 1000 + 1);
          return Math.min(config.max, Math.max(config.min, tokenScale));
        }
        if (!d.count || config.scale === 0) return config.base;
        const scaled = config.base + config.scale * Math.log2(d.count + 1);
        return Math.min(config.max, Math.max(config.min, scaled));
      }

      function getNodeFillColor(d) {
        // For plan-step nodes, color by complexity
        if (d.type === 'plan-step' && d.planStepComplexity) {
          if (d.planStepComplexity === 'high') return '#f14c4c';
          if (d.planStepComplexity === 'medium') return '#FFD700';
          if (d.planStepComplexity === 'low') return '#73c991';
        }
        return NODE_COLORS[d.type];
      }

      function getForceConfig(nodeCount) {
        const density = Math.min(1, Math.max(0, (nodeCount - 10) / 40));
        return {
          linkDistance: FORCE_CONFIG.baseLinkDistance + (FORCE_CONFIG.denseLinkDistance - FORCE_CONFIG.baseLinkDistance) * density,
          chargeStrength: FORCE_CONFIG.baseCharge + (FORCE_CONFIG.denseCharge - FORCE_CONFIG.baseCharge) * density,
          collisionPadding: FORCE_CONFIG.baseCollisionPadding + (FORCE_CONFIG.denseCollisionPadding - FORCE_CONFIG.baseCollisionPadding) * density,
          chargeDistanceMax: FORCE_CONFIG.baseChargeDistanceMax + (FORCE_CONFIG.denseChargeDistanceMax - FORCE_CONFIG.baseChargeDistanceMax) * density,
          axisStrength: FORCE_CONFIG.baseAxisStrength + (FORCE_CONFIG.denseAxisStrength - FORCE_CONFIG.baseAxisStrength) * density,
          collisionIterations: nodeCount > 50 ? 3 : 2
        };
      }

      function applyForceConfig(nodeCount) {
        if (!simulation) {
          return;
        }

        const forceConfig = getForceConfig(nodeCount);
        const linkForce = simulation.force('link');
        const chargeForce = simulation.force('charge');
        const collideForce = simulation.force('collide');
        const xForce = simulation.force('x');
        const yForce = simulation.force('y');

        if (linkForce) {
          linkForce.distance(function(link) {
            const distance = forceConfig.linkDistance;
            if (link.linkType === 'task-action') return distance * 0.75;
            if (link.linkType === 'task-dependency') return distance * 0.9;
            if (link.linkType === 'plan-sequence') return distance * 0.6;

            const sourceType = link.source && typeof link.source === 'object' ? link.source.type : null;
            const targetType = link.target && typeof link.target === 'object' ? link.target.type : null;

            if (sourceType === 'tool' || targetType === 'tool') return distance * 0.78;
            if (sourceType === 'subagent' || targetType === 'subagent') return distance * 0.84;
            if (sourceType === 'session' || targetType === 'session') return distance * 0.9;

            return distance;
          });
        }

        if (chargeForce) {
          chargeForce
            .strength(forceConfig.chargeStrength)
            .distanceMin(12)
            .distanceMax(forceConfig.chargeDistanceMax);
        }

        if (collideForce) {
          collideForce
            .radius(function(d) { return calculateNodeSize(d) + forceConfig.collisionPadding; })
            .iterations(forceConfig.collisionIterations);
        }

        if (xForce) {
          xForce
            .x(containerEl.clientWidth / 2)
            .strength(forceConfig.axisStrength);
        }

        if (yForce) {
          yForce
            .y(containerEl.clientHeight / 2)
            .strength(forceConfig.axisStrength);
        }
      }

      // DOM elements
      const statusEl = document.getElementById('status');
      const emptyEl = document.getElementById('empty-state');
      const containerEl = document.getElementById('graph-container');
      const legendEl = document.getElementById('legend');
      const tooltipEl = document.getElementById('tooltip');
      const resetLayoutEl = document.getElementById('reset-layout');
      const toggleLayoutEl = document.getElementById('toggle-layout');

      // Layout mode state
      let layoutMode = 'force'; // 'force' | 'circular'

      // D3 elements
      let svg, g, simulation, linkGroup, nodeGroup, labelGroup, changeGroup, zoom;
      let currentNodes = [];
      let currentLinks = [];
      let previousNodeIds = new Set();
      let previousLinkIds = new Set();
      let previousLatestLinkId = null;

      // === Circular Layout Functions ===

      /**
       * Node type order for grouping on the circle.
       */
      const CIRCULAR_TYPE_ORDER = ['tool', 'file', 'directory', 'command', 'url', 'subagent', 'task', 'plan', 'plan-step', 'knowledge-note', 'todo'];

      /**
       * Calculates circular positions for all nodes.
       * Session node goes to center, others on a circle grouped by type.
       */
      function calculateCircularPositions(nodes) {
        const width = containerEl.clientWidth;
        const height = containerEl.clientHeight;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.max(80, Math.min(width, height) * 0.35);
        const positions = {};

        const sessionNode = nodes.find(function(n) { return n.type === 'session'; });
        const peripheralNodes = nodes.filter(function(n) { return n.type !== 'session'; });

        if (sessionNode) {
          positions[sessionNode.id] = { x: centerX, y: centerY };
        }

        // Sort by type group then alphabetically by label within each group
        peripheralNodes.sort(function(a, b) {
          let aIdx = CIRCULAR_TYPE_ORDER.indexOf(a.type);
          let bIdx = CIRCULAR_TYPE_ORDER.indexOf(b.type);
          if (aIdx === -1) aIdx = CIRCULAR_TYPE_ORDER.length;
          if (bIdx === -1) bIdx = CIRCULAR_TYPE_ORDER.length;
          if (aIdx !== bIdx) return aIdx - bIdx;
          return a.label.localeCompare(b.label);
        });

        const total = peripheralNodes.length;
        peripheralNodes.forEach(function(node, i) {
          const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, total);
          positions[node.id] = {
            x: centerX + Math.cos(angle) * radius,
            y: centerY + Math.sin(angle) * radius
          };
        });

        return positions;
      }

      /**
       * Computes SVG path d attribute for a curved link.
       * Session-to-peripheral links are straight; peripheral-to-peripheral use quadratic bezier.
       */
      function computeCurvedPath(link, positions) {
        const sourceId = link.source.id || link.source;
        const targetId = link.target.id || link.target;
        const s = positions[sourceId];
        const t = positions[targetId];
        if (!s || !t) return '';

        const sourceNode = currentNodes.find(function(n) { return n.id === sourceId; });
        const targetNode = currentNodes.find(function(n) { return n.id === targetId; });
        const sourceIsSession = sourceNode && sourceNode.type === 'session';
        const targetIsSession = targetNode && targetNode.type === 'session';

        if (sourceIsSession || targetIsSession) {
          // Straight line for session-to-peripheral
          return 'M ' + s.x + ' ' + s.y + ' L ' + t.x + ' ' + t.y;
        }

        // Quadratic bezier: control point pulled 50% toward center
        const width = containerEl.clientWidth;
        const height = containerEl.clientHeight;
        const cx = width / 2;
        const cy = height / 2;
        const midX = (s.x + t.x) / 2;
        const midY = (s.y + t.y) / 2;
        const ctrlX = midX + (cx - midX) * 0.5;
        const ctrlY = midY + (cy - midY) * 0.5;

        return 'M ' + s.x + ' ' + s.y + ' Q ' + ctrlX + ' ' + ctrlY + ' ' + t.x + ' ' + t.y;
      }

      /**
       * Gets CSS class for a link path based on its type and properties.
       */
      function getLinkPathClass(d) {
        const classes = ['link-path'];
        if (d.isLatest) classes.push('latest');
        if (d.linkType === 'task-action') classes.push('task-action');
        if (d.linkType === 'task-dependency') classes.push('task-dependency');
        if (d.linkType === 'plan-sequence') classes.push('plan-sequence');
        if (d.linkType === 'knowledge-note') classes.push('knowledge-note');
        return classes.join(' ');
      }

      /**
       * Renders curved path links for circular layout (snap, no animation).
       */
      function renderCircularLinks(positions) {
        // Hide <line> elements
        linkGroup.selectAll('line').style('display', 'none');

        // Remove old paths
        linkGroup.selectAll('path').remove();

        // Create <path> elements
        linkGroup.selectAll('path')
          .data(currentLinks, function(d) {
            const sid = d.source.id || d.source;
            const tid = d.target.id || d.target;
            return sid + '-' + tid;
          })
          .enter()
          .append('path')
          .attr('class', function(d) { return getLinkPathClass(d); })
          .attr('stroke-width', function(d) {
            if (d.isLatest) return 3;
            if (d.linkType === 'task-dependency') return 2;
            return 1.5;
          })
          .attr('d', function(d) { return computeCurvedPath(d, positions); });

        linkGroup.selectAll('path.latest').raise();
      }

      /**
       * Renders curved path links with transition animation.
       */
      function transitionLinksToCircular(positions, duration) {
        // Hide <line> elements
        linkGroup.selectAll('line').style('display', 'none');

        // Remove old paths
        linkGroup.selectAll('path').remove();

        // Create paths starting from current node positions (straight lines from source)
        const paths = linkGroup.selectAll('path')
          .data(currentLinks, function(d) {
            const sid = d.source.id || d.source;
            const tid = d.target.id || d.target;
            return sid + '-' + tid;
          })
          .enter()
          .append('path')
          .attr('class', function(d) { return getLinkPathClass(d); })
          .attr('stroke-width', function(d) {
            if (d.isLatest) return 3;
            if (d.linkType === 'task-dependency') return 2;
            return 1.5;
          })
          .attr('d', function(d) {
            // Start at current node positions (straight line)
            const sourceId = d.source.id || d.source;
            const targetId = d.target.id || d.target;
            const sNode = currentNodes.find(function(n) { return n.id === sourceId; });
            const tNode = currentNodes.find(function(n) { return n.id === targetId; });
            const sx = sNode ? sNode.x : 0;
            const sy = sNode ? sNode.y : 0;
            const tx = tNode ? tNode.x : 0;
            const ty = tNode ? tNode.y : 0;
            return 'M ' + sx + ' ' + sy + ' L ' + tx + ' ' + ty;
          });

        // Transition to curved paths
        paths.transition()
          .duration(duration)
          .ease(d3.easeCubicInOut)
          .attr('d', function(d) { return computeCurvedPath(d, positions); });

        linkGroup.selectAll('path.latest').raise();
      }

      /**
       * Applies circular layout - stops simulation, positions nodes on circle.
       */
      function applyCircularLayout(animate) {
        if (!simulation || currentNodes.length === 0) return;

        simulation.stop();
        const positions = calculateCircularPositions(currentNodes);
        const duration = animate ? 600 : 0;

        // Add circular-mode class to nodes
        nodeGroup.selectAll('circle').classed('circular-mode', true);

        if (duration > 0) {
          // Animate nodes to target positions
          nodeGroup.selectAll('circle')
            .transition()
            .duration(duration)
            .ease(d3.easeCubicInOut)
            .attr('cx', function(d) { return positions[d.id].x; })
            .attr('cy', function(d) { return positions[d.id].y; });

          labelGroup.selectAll('text')
            .transition()
            .duration(duration)
            .ease(d3.easeCubicInOut)
            .attr('x', function(d) { return positions[d.id].x; })
            .attr('y', function(d) { return positions[d.id].y + calculateNodeSize(d) + 12; });

          changeGroup.selectAll('text')
            .transition()
            .duration(duration)
            .ease(d3.easeCubicInOut)
            .attr('x', function(d) { return positions[d.id] ? positions[d.id].x : 0; })
            .attr('y', function(d) { return positions[d.id] ? positions[d.id].y + calculateNodeSize(d) + 22 : 0; });

          transitionLinksToCircular(positions, duration);
        } else {
          // Snap nodes to target positions
          nodeGroup.selectAll('circle')
            .attr('cx', function(d) { return positions[d.id].x; })
            .attr('cy', function(d) { return positions[d.id].y; });

          labelGroup.selectAll('text')
            .attr('x', function(d) { return positions[d.id].x; })
            .attr('y', function(d) { return positions[d.id].y + calculateNodeSize(d) + 12; });

          changeGroup.selectAll('text')
            .attr('x', function(d) { return positions[d.id] ? positions[d.id].x : 0; })
            .attr('y', function(d) { return positions[d.id] ? positions[d.id].y + calculateNodeSize(d) + 22 : 0; });

          renderCircularLinks(positions);
        }

        // Update node data positions so zoom/pan works
        currentNodes.forEach(function(n) {
          if (positions[n.id]) {
            n.x = positions[n.id].x;
            n.y = positions[n.id].y;
            n.fx = positions[n.id].x;
            n.fy = positions[n.id].y;
            n.vx = 0;
            n.vy = 0;
          }
        });

        // Center the view
        centerOnSession({ duration: animate ? 600 : 250, preserveZoom: false, scale: 1 });
      }

      /**
       * Applies force layout - removes paths, restores lines, restarts simulation.
       */
      function applyForceLayout(animate) {
        if (!simulation || currentNodes.length === 0) return;

        // Remove <path> links
        linkGroup.selectAll('path').remove();

        // Restore <line> elements
        linkGroup.selectAll('line').style('display', null);

        // Remove circular-mode class
        nodeGroup.selectAll('circle').classed('circular-mode', false);

        // Clear fixed positions
        currentNodes.forEach(function(n) {
          n.fx = null;
          n.fy = null;
        });

        // Restart simulation
        applyForceConfig(currentNodes.length);
        simulation.nodes(currentNodes);
        simulation.force('link').links(currentLinks);
        simulation.alpha(1).alphaTarget(0).restart();

        if (animate) {
          centerOnSession({ duration: 600, preserveZoom: false, scale: 1 });
        }
      }

      /**
       * Initializes the D3 force simulation.
       */
      function initGraph() {
        const width = containerEl.clientWidth;
        const height = containerEl.clientHeight;
        const initialForceConfig = getForceConfig(0);

        svg = d3.select('#graph')
          .attr('width', width)
          .attr('height', height);

        // Container for zoomable content
        g = svg.append('g');

        // Zoom behavior
        zoom = d3.zoom()
          .scaleExtent([0.1, 10])
          .on('zoom', (event) => {
            g.attr('transform', event.transform);
          });

        svg.call(zoom);

        // Groups for layering (links below nodes)
        linkGroup = g.append('g').attr('class', 'links');
        nodeGroup = g.append('g').attr('class', 'nodes');
        labelGroup = g.append('g').attr('class', 'labels');
        changeGroup = g.append('g').attr('class', 'changes');

        // Initialize simulation
        simulation = d3.forceSimulation()
          .force('link', d3.forceLink()
            .id(function(d) { return d.id; })
            .distance(initialForceConfig.linkDistance))
          .force('charge', d3.forceManyBody()
            .strength(initialForceConfig.chargeStrength)
            .distanceMin(12)
            .distanceMax(initialForceConfig.chargeDistanceMax))
          .force('center', d3.forceCenter(width / 2, height / 2))
          .force('x', d3.forceX(width / 2).strength(initialForceConfig.axisStrength))
          .force('y', d3.forceY(height / 2).strength(initialForceConfig.axisStrength))
          .force('collide', d3.forceCollide()
            .radius(function(d) { return calculateNodeSize(d) + initialForceConfig.collisionPadding; })
            .iterations(initialForceConfig.collisionIterations));

        simulation.on('tick', ticked);
      }

      /**
       * Centers viewport on the main session node.
       */
      function centerOnSession(options) {
        if (!svg || !zoom || currentNodes.length === 0) {
          return;
        }

        options = options || {};
        const duration = options.duration || 0;
        const preserveZoom = options.preserveZoom !== false;
        const width = svg.node().clientWidth;
        const height = svg.node().clientHeight;
        const currentTransform = d3.zoomTransform(svg.node());
        const scale = preserveZoom ? currentTransform.k : (options.scale || 1);
        const sessionNode = currentNodes.find(function(node) { return node.type === 'session'; }) || currentNodes[0];
        const focusX = sessionNode && sessionNode.x != null ? sessionNode.x : width / 2;
        const focusY = sessionNode && sessionNode.y != null ? sessionNode.y : height / 2;

        const transform = d3.zoomIdentity
          .translate(width / 2 - focusX * scale, height / 2 - focusY * scale)
          .scale(scale);

        if (duration > 0) {
          svg.transition()
            .duration(duration)
            .ease(d3.easeCubicInOut)
            .call(zoom.transform, transform);
          return;
        }

        svg.call(zoom.transform, transform);
      }

      /**
       * Rebuilds node positions and restarts simulation for dense graphs.
       */
      function resetLayout() {
        if (!simulation || currentNodes.length === 0) {
          return;
        }

        if (layoutMode === 'circular') {
          applyCircularLayout(true);
          return;
        }

        const width = containerEl.clientWidth;
        const height = containerEl.clientHeight;
        const centerX = width / 2;
        const centerY = height / 2;
        const sessionNode = currentNodes.find(function(node) { return node.type === 'session'; }) || null;
        const orbitNodes = currentNodes.filter(function(node) { return node !== sessionNode; });
        const radius = Math.max(50, Math.min(width, height) * 0.2);
        const total = Math.max(1, orbitNodes.length);

        currentNodes.forEach(function(node) {
          node.fx = null;
          node.fy = null;
        });

        if (sessionNode) {
          sessionNode.x = centerX;
          sessionNode.y = centerY;
          sessionNode.vx = 0;
          sessionNode.vy = 0;
        }

        orbitNodes.forEach(function(node, index) {
          const angle = (Math.PI * 2 * index) / total;
          const jitter = 10 * Math.sin(index * 1.7);
          node.x = centerX + Math.cos(angle) * (radius + jitter);
          node.y = centerY + Math.sin(angle) * (radius + jitter);
          node.vx = 0;
          node.vy = 0;
        });

        applyForceConfig(currentNodes.length);
        simulation.nodes(currentNodes);
        simulation.force('link').links(currentLinks);
        simulation.alpha(1).alphaTarget(0).restart();

        centerOnSession({ duration: 250, preserveZoom: false, scale: 1 });
      }

      /**
       * Updates positions on each simulation tick.
       */
      function ticked() {
        linkGroup.selectAll('line')
          .attr('x1', function(d) { return d.source.x; })
          .attr('y1', function(d) { return d.source.y; })
          .attr('x2', function(d) { return d.target.x; })
          .attr('y2', function(d) { return d.target.y; });

        nodeGroup.selectAll('circle')
          .attr('cx', function(d) { return d.x; })
          .attr('cy', function(d) { return d.y; });

        labelGroup.selectAll('text')
          .attr('x', function(d) { return d.x; })
          .attr('y', function(d) { return d.y + calculateNodeSize(d) + 12; });

        changeGroup.selectAll('text')
          .attr('x', function(d) { return d.x; })
          .attr('y', function(d) { return d.y + calculateNodeSize(d) + 22; });
      }

      /**
       * Creates drag behavior for nodes.
       */
      function drag(simulation) {
        function dragstarted(event) {
          if (layoutMode === 'circular') return;
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        }

        function dragged(event) {
          if (layoutMode === 'circular') return;
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        }

        function dragended(event) {
          if (layoutMode === 'circular') return;
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        }

        return d3.drag()
          .on('start', dragstarted)
          .on('drag', dragged)
          .on('end', dragended);
      }

      /**
       * Updates the graph with new data.
       */
      function updateGraph(state) {
        if (!state.graph || state.graph.nodes.length === 0) {
          showEmpty(true);
          return;
        }

        showEmpty(false);

        const nodes = state.graph.nodes;
        const links = state.graph.links;

        // Preserve existing positions for nodes that haven't changed
        const oldPositions = new Map();
        currentNodes.forEach(function(n) {
          if (n.x !== undefined && n.y !== undefined) {
            oldPositions.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
          }
        });

        nodes.forEach(function(n) {
          const old = oldPositions.get(n.id);
          if (old) {
            n.x = old.x;
            n.y = old.y;
            n.vx = old.vx;
            n.vy = old.vy;
          }
        });

        currentNodes = nodes;
        currentLinks = links;

        // Update links
        const link = linkGroup.selectAll('line')
          .data(links, function(d) { return d.source + '-' + d.target; });

        link.exit().remove();

        link.enter()
          .append('line')
          .attr('class', function(d) { return getLinkClass(d); })
          .attr('stroke-width', function(d) { return getLinkWidth(d); });

        // Update class on existing links
        linkGroup.selectAll('line')
          .attr('class', function(d) { return getLinkClass(d); })
          .attr('stroke-width', function(d) { return getLinkWidth(d); });

        // Raise latest link to render on top
        linkGroup.selectAll('line.latest').raise();

        /**
         * Gets CSS class for a link based on its type and properties.
         */
        function getLinkClass(d) {
          const classes = ['link'];
          if (d.isLatest) classes.push('latest');
          if (d.linkType === 'task-action') classes.push('task-action');
          if (d.linkType === 'task-dependency') classes.push('task-dependency');
          if (d.linkType === 'plan-sequence') classes.push('plan-sequence');
          if (d.linkType === 'knowledge-note') classes.push('knowledge-note');
          return classes.join(' ');
        }

        /**
         * Gets stroke width for a link based on its type.
         */
        function getLinkWidth(d) {
          if (d.isLatest) return 3;
          if (d.linkType === 'task-dependency') return 2;
          return 1.5;
        }

        /**
         * Gets CSS class for a node based on its type and properties.
         */
        function getNodeClass(d) {
          const classes = ['node'];
          const isClickable = d.type === 'file' || d.type === 'url';
          if (isClickable) classes.push('clickable');
          // Add task status class
          if (d.type === 'task' && d.taskStatus) {
            classes.push('task-' + d.taskStatus);
          }
          // Add plan step status class
          if (d.type === 'plan-step' && d.planStepStatus) {
            classes.push('plan-step-' + d.planStepStatus);
          }
          // Add plan active class
          if (d.type === 'plan' && d.count > 0) {
            classes.push('plan-active');
          }
          // Mark the most recently active node
          if (d.isLatest) {
            classes.push('latest');
          }
          return classes.join(' ');
        }

        // Update nodes
        const node = nodeGroup.selectAll('circle')
          .data(nodes, function(d) { return d.id; });

        node.exit().remove();

        node.enter()
          .append('circle')
          .attr('class', function(d) { return getNodeClass(d); })
          .attr('r', function(d) { return calculateNodeSize(d); })
          .attr('fill', function(d) { return getNodeFillColor(d); })
          .call(drag(simulation))
          .on('click', function(event, d) {
            vscode.postMessage({ type: 'nodeClicked', nodeId: d.id });
          })
          .on('mouseover', function(event, d) {
            const label = d.fullPath || d.label;
            // Build tooltip content
            if (d.type === 'file') {
              // For files, show touches and line changes
              let firstLine = label;
              if (d.count) {
                firstLine += ' (' + d.count + ' touch' + (d.count > 1 ? 'es' : '') + ')';
              }
              // Show line changes if any exist
              const hasChanges = (d.additions && d.additions > 0) || (d.deletions && d.deletions > 0);
              if (hasChanges) {
                const adds = d.additions || 0;
                const dels = d.deletions || 0;
                tooltipEl.innerHTML = firstLine + '<br><span class="additions">+' + adds + '</span> / <span class="deletions">-' + dels + '</span> lines';
              } else {
                tooltipEl.textContent = firstLine;
              }
            } else if (d.type === 'task') {
              // For tasks, show subject, status, and action count
              const statusLabel = d.taskStatus || 'unknown';
              const statusColor = statusLabel === 'in_progress' ? 'var(--vscode-charts-green, #4caf50)'
                              : statusLabel === 'pending' ? 'var(--vscode-charts-yellow, #FFD700)'
                              : 'var(--vscode-descriptionForeground)';
              const actionCount = d.count || 0;
              const actionText = actionCount === 1 ? '1 action' : actionCount + ' actions';
              tooltipEl.innerHTML = '<strong>' + label + '</strong><br>' +
                '<span style="color: ' + statusColor + '">● ' + statusLabel.replace('_', ' ') + '</span>' +
                '<br>' + actionText;
            } else if (d.type === 'plan') {
              // For plan root, show title and step count
              const stepCount = d.count || 0;
              const stepText = stepCount === 1 ? '1 step' : stepCount + ' steps';
              tooltipEl.innerHTML = '<strong>' + label + '</strong><br>' + stepText;
            } else if (d.type === 'plan-step') {
              // For plan steps, show description, status, and enriched metadata
              const planStatus = d.planStepStatus || 'pending';
              const planStatusColor = planStatus === 'in_progress' ? 'var(--vscode-charts-green, #4caf50)'
                                 : planStatus === 'pending' ? 'var(--vscode-charts-yellow, #FFD700)'
                                 : planStatus === 'failed' ? 'var(--vscode-charts-red, #f14c4c)'
                                 : 'var(--vscode-descriptionForeground)';
              let planTooltipHtml = '<strong>' + label + '</strong><br>' +
                '<span style="color: ' + planStatusColor + '">● ' + planStatus.replace('_', ' ') + '</span>';
              if (d.planStepComplexity) {
                const COMPLEXITY_COLORS = { high: '#f14c4c', medium: '#FFD700', low: '#73c991' };
                const cxColor = COMPLEXITY_COLORS[d.planStepComplexity] || '#73c991';
                planTooltipHtml += '<br>Complexity: <span style="color:' + cxColor + '">' + d.planStepComplexity + '</span>';
              }
              if (d.planStepDurationMs) {
                const dSec = Math.round(d.planStepDurationMs / 1000);
                const dMin = Math.floor(dSec / 60);
                planTooltipHtml += '<br>Duration: ' + (dMin > 0 ? dMin + 'm ' + (dSec % 60) + 's' : dSec + 's');
              }
              if (d.planStepTokens) {
                planTooltipHtml += '<br>Tokens: ' + (d.planStepTokens >= 1000 ? (d.planStepTokens / 1000).toFixed(1) + 'k' : d.planStepTokens);
              }
              if (d.planStepError) {
                planTooltipHtml += '<br><span style="color:var(--vscode-charts-red, #f14c4c)">Error: ' + d.planStepError.substring(0, 80) + '</span>';
              }
              tooltipEl.innerHTML = planTooltipHtml;
            } else if (d.type === 'knowledge-note') {
              // For knowledge notes, show full content from fullPath
              tooltipEl.textContent = label;
            } else {
              // For other nodes, show count if available
              const count = d.count ? ' (' + d.count + ')' : '';
              tooltipEl.textContent = label + count;
            }
            tooltipEl.classList.add('visible');
          })
          .on('mousemove', function(event) {
            tooltipEl.style.left = (event.pageX + 10) + 'px';
            tooltipEl.style.top = (event.pageY - 10) + 'px';
          })
          .on('mouseout', function() {
            tooltipEl.classList.remove('visible');
          });

        // Update labels
        const label = labelGroup.selectAll('text')
          .data(nodes, function(d) { return d.id; });

        label.exit().remove();

        label.enter()
          .append('text')
          .attr('class', 'node-label')
          .text(function(d) { return d.label; });

        // Update change labels (for file nodes with +/- changes)
        const fileNodesWithChanges = nodes.filter(function(d) {
          return d.type === 'file' && ((d.additions && d.additions > 0) || (d.deletions && d.deletions > 0));
        });

        const changeLabel = changeGroup.selectAll('text')
          .data(fileNodesWithChanges, function(d) { return d.id; });

        changeLabel.exit().remove();

        changeLabel.enter()
          .append('text')
          .attr('class', 'change-label')
          .html(function(d) {
            const adds = d.additions || 0;
            const dels = d.deletions || 0;
            return '<tspan class="add">+' + adds + '</tspan> <tspan class="del">-' + dels + '</tspan>';
          });

        // Update merged selections
        nodeGroup.selectAll('circle')
          .attr('class', function(d) { return getNodeClass(d); })
          .attr('r', function(d) { return calculateNodeSize(d); })
          .attr('fill', function(d) { return getNodeFillColor(d); });

        labelGroup.selectAll('text')
          .text(function(d) { return d.label; });

        changeGroup.selectAll('text')
          .html(function(d) {
            const adds = d.additions || 0;
            const dels = d.deletions || 0;
            return '<tspan class="add">+' + adds + '</tspan> <tspan class="del">-' + dels + '</tspan>';
          });

        // Update simulation / layout
        if (layoutMode === 'circular') {
          // In circular mode: hide line links, stop sim, snap to circular positions
          linkGroup.selectAll('line').style('display', 'none');
          simulation.nodes(nodes);
          simulation.force('link').links(links);
          simulation.stop();
          applyCircularLayout(false);
        } else {
          applyForceConfig(nodes.length);
          simulation.nodes(nodes);
          simulation.force('link').links(links);
          simulation.alpha(0.3).restart();

          // Check for new activity and focus on it
          setTimeout(function() {
            focusOnNewActivity(nodes, links);
          }, 400);
        }
      }

      /**
       * Focuses the view on new activity (new nodes, new links, or latest link).
       */
      function focusOnNewActivity(nodes, links) {
        if (!svg || !zoom) return;

        // Build current IDs
        const currentNodeIds = new Set(nodes.map(function(n) { return n.id; }));
        const currentLinkIds = new Set(links.map(function(l) {
          const sourceId = l.source.id || l.source;
          const targetId = l.target.id || l.target;
          return sourceId + '-' + targetId;
        }));

        // Find new nodes (excluding session root which is always present)
        const newNodes = nodes.filter(function(n) {
          return !previousNodeIds.has(n.id) && n.type !== 'session';
        });

        // Find new links
        const newLinkIds = [];
        currentLinkIds.forEach(function(id) {
          if (!previousLinkIds.has(id)) newLinkIds.push(id);
        });

        // Find latest link
        const latestLink = links.find(function(l) { return l.isLatest; });
        let latestLinkId = null;
        if (latestLink) {
          const sourceId = latestLink.source.id || latestLink.source;
          const targetId = latestLink.target.id || latestLink.target;
          latestLinkId = sourceId + '-' + targetId;
        }

        // Determine if we should focus
        const hasNewActivity = newNodes.length > 0 || newLinkIds.length > 0;
        const latestLinkChanged = latestLinkId && latestLinkId !== previousLatestLinkId;

        // Update tracking for next time
        previousNodeIds = currentNodeIds;
        previousLinkIds = currentLinkIds;
        previousLatestLinkId = latestLinkId;

        // Only focus if there's new activity or the latest link changed
        if (!hasNewActivity && !latestLinkChanged) return;

        // Determine focus target
        let focusX, focusY;

        if (latestLink && latestLinkChanged) {
          // Focus on latest link (midpoint)
          const source = typeof latestLink.source === 'object' ? latestLink.source : nodes.find(function(n) { return n.id === latestLink.source; });
          const target = typeof latestLink.target === 'object' ? latestLink.target : nodes.find(function(n) { return n.id === latestLink.target; });
          if (source && target && source.x != null && target.x != null) {
            focusX = (source.x + target.x) / 2;
            focusY = (source.y + target.y) / 2;
          }
        } else if (newNodes.length > 0) {
          // Focus on newest node (last in array, typically most recent)
          const newestNode = newNodes[newNodes.length - 1];
          if (newestNode.x != null) {
            focusX = newestNode.x;
            focusY = newestNode.y;
          }
        }

        if (focusX == null || focusY == null) return;

        // Get viewport dimensions and current zoom state
        const width = svg.node().clientWidth;
        const height = svg.node().clientHeight;
        const currentTransform = d3.zoomTransform(svg.node());

        // Preserve user's zoom level, only change pan position
        const scale = currentTransform.k;
        const transform = d3.zoomIdentity
          .translate(width / 2 - focusX * scale, height / 2 - focusY * scale)
          .scale(scale);

        // Progressive transition with easing
        svg.transition()
          .duration(800)
          .ease(d3.easeCubicInOut)
          .call(zoom.transform, transform);
      }

      /**
       * Shows or hides empty state.
       */
      function showEmpty(show) {
        emptyEl.style.display = show ? 'flex' : 'none';
        containerEl.style.display = show ? 'none' : 'block';
        legendEl.style.display = show ? 'none' : 'block';
        if (resetLayoutEl) {
          resetLayoutEl.disabled = show;
        }
        if (toggleLayoutEl) {
          toggleLayoutEl.disabled = show;
        }
      }

      /**
       * Updates status indicator.
       */
      function updateStatus(active) {
        if (active) {
          statusEl.textContent = 'Active';
          statusEl.className = 'status active';
        } else {
          statusEl.textContent = 'No Session';
          statusEl.className = 'status';
        }
      }

      // Handle messages from extension
      window.addEventListener('message', function(event) {
        const message = event.data;

        switch (message.type) {
          case 'updateGraph':
            updateStatus(message.state.sessionActive);
            updateGraph(message.state);
            break;

          case 'sessionStart':
            updateStatus(true);
            break;

          case 'sessionEnd':
            updateStatus(false);
            break;

          case 'updatePhrase':
            const hp = document.getElementById('header-phrase');
            if (hp) hp.textContent = message.phrase;
            break;

          case 'updateEmptyPhrase':
            const ep = document.getElementById('empty-state-phrase');
            if (ep) ep.textContent = message.phrase;
            break;
        }
      });

      // Handle window resize
      window.addEventListener('resize', function() {
        if (simulation) {
          const width = containerEl.clientWidth;
          const height = containerEl.clientHeight;
          svg.attr('width', width).attr('height', height);

          if (layoutMode === 'circular') {
            applyCircularLayout(false);
          } else {
            simulation.force('center', d3.forceCenter(width / 2, height / 2));
            applyForceConfig(currentNodes.length);
            simulation.alpha(0.3).restart();
          }
        }
      });

      if (resetLayoutEl) {
        resetLayoutEl.addEventListener('click', function() {
          resetLayout();
        });
      }

      if (toggleLayoutEl) {
        toggleLayoutEl.addEventListener('click', function() {
          if (layoutMode === 'force') {
            layoutMode = 'circular';
            toggleLayoutEl.textContent = 'Force';
            toggleLayoutEl.classList.add('layout-active');
            applyCircularLayout(true);
          } else {
            layoutMode = 'force';
            toggleLayoutEl.textContent = 'Circular';
            toggleLayoutEl.classList.remove('layout-active');
            applyForceLayout(true);
          }
        });
      }

      // Legend hover-to-highlight and click-to-lock
      const legendTypeMap = ['session','file','tool','todo','subagent','directory','command','task','plan','knowledge-note'];
      let lockedLegendType = null;
      const legendItems = document.querySelectorAll('.legend-item');

      function applyLegendHighlight(nodeType) {
        // Dim non-active legend items
        legendItems.forEach(function(li, i) {
          if (legendTypeMap[i] !== nodeType) {
            li.classList.add('dimmed');
          } else {
            li.classList.remove('dimmed');
          }
        });

        if (!nodeGroup || !linkGroup || !labelGroup) return;

        // Highlight matching nodes, fade others
        nodeGroup.selectAll('circle').each(function(d) {
          const match = (d.type === nodeType) ||
            (nodeType === 'plan' && d.type === 'plan-step');
          d3.select(this).classed('highlighted', match).classed('faded', !match);
        });

        // Highlight links connected to matching nodes, fade others
        linkGroup.selectAll('line, path').each(function(d) {
          const src = typeof d.source === 'object' ? d.source : { type: '' };
          const tgt = typeof d.target === 'object' ? d.target : { type: '' };
          const srcMatch = (src.type === nodeType) || (nodeType === 'plan' && src.type === 'plan-step');
          const tgtMatch = (tgt.type === nodeType) || (nodeType === 'plan' && tgt.type === 'plan-step');
          d3.select(this).classed('faded', !(srcMatch || tgtMatch));
        });

        // Show labels only on matching nodes
        labelGroup.selectAll('text').each(function(d) {
          const match = (d.type === nodeType) ||
            (nodeType === 'plan' && d.type === 'plan-step');
          d3.select(this).style('opacity', match ? 1 : 0.1);
        });
      }

      function clearLegendHighlight() {
        legendItems.forEach(function(li) {
          li.classList.remove('dimmed');
        });
        if (!nodeGroup || !linkGroup || !labelGroup) return;
        nodeGroup.selectAll('circle').classed('highlighted', false).classed('faded', false);
        linkGroup.selectAll('line, path').classed('faded', false);
        labelGroup.selectAll('text').style('opacity', null);
      }

      legendItems.forEach(function(item, idx) {
        const nodeType = legendTypeMap[idx];

        item.addEventListener('mouseenter', function() {
          if (lockedLegendType && lockedLegendType !== nodeType) return;
          applyLegendHighlight(nodeType);
        });

        item.addEventListener('mouseleave', function() {
          if (lockedLegendType) return;
          clearLegendHighlight();
        });

        item.addEventListener('click', function() {
          if (lockedLegendType === nodeType) {
            // Unlock
            lockedLegendType = null;
            item.classList.remove('locked');
            clearLegendHighlight();
          } else {
            // Lock to this type
            if (lockedLegendType !== null) {
              legendItems.forEach(function(li) { li.classList.remove('locked'); });
            }
            lockedLegendType = nodeType;
            item.classList.add('locked');
            applyLegendHighlight(nodeType);
          }
        });
      });

      // Initialize and signal ready
      initGraph();
      vscode.postMessage({ type: 'webviewReady' });
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    this._clearPhraseTimers();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    log('MindMapViewProvider disposed');
  }
}

