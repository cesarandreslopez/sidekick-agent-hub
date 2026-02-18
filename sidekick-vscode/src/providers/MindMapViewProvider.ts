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
import { log } from '../services/Logger';
import { getNonce } from '../utils/nonce';

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

    log('Mind map webview resolved');
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
    this._state.graph = MindMapDataService.buildGraph(stats, subagents);
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
    }

    .legend-item:last-child {
      margin-bottom: 0;
    }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="Sidekick" />
    <h1>Mind Map</h1>
    <div class="header-actions">
      <button id="reset-layout" class="icon-button" type="button" title="Reset graph layout" disabled>Reset Layout</button>
      <span id="status" class="status">No Session</span>
    </div>
  </div>

  <div id="empty-state" class="empty-state">
    <p>No active Claude Code session detected.</p>
    <p>Start a session to see the mind map.</p>
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
        'plan-step': '#26C6DA' // Lighter teal - plan steps
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
        'plan-step': { base: 8,  min: 6,  max: 12, scale: 2 }      // Scales with links
      };

      function calculateNodeSize(d) {
        var config = SIZING_CONFIG[d.type] || SIZING_CONFIG.file;
        if (!d.count || config.scale === 0) return config.base;
        var scaled = config.base + config.scale * Math.log2(d.count + 1);
        return Math.min(config.max, Math.max(config.min, scaled));
      }

      function getForceConfig(nodeCount) {
        var density = Math.min(1, Math.max(0, (nodeCount - 10) / 40));
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

        var forceConfig = getForceConfig(nodeCount);
        var linkForce = simulation.force('link');
        var chargeForce = simulation.force('charge');
        var collideForce = simulation.force('collide');
        var xForce = simulation.force('x');
        var yForce = simulation.force('y');

        if (linkForce) {
          linkForce.distance(function(link) {
            var distance = forceConfig.linkDistance;
            if (link.linkType === 'task-action') return distance * 0.75;
            if (link.linkType === 'task-dependency') return distance * 0.9;
            if (link.linkType === 'plan-sequence') return distance * 0.6;

            var sourceType = link.source && typeof link.source === 'object' ? link.source.type : null;
            var targetType = link.target && typeof link.target === 'object' ? link.target.type : null;

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

      // D3 elements
      let svg, g, simulation, linkGroup, nodeGroup, labelGroup, changeGroup, zoom;
      let currentNodes = [];
      let currentLinks = [];
      let previousNodeIds = new Set();
      let previousLinkIds = new Set();
      let previousLatestLinkId = null;

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
        var duration = options.duration || 0;
        var preserveZoom = options.preserveZoom !== false;
        var width = svg.node().clientWidth;
        var height = svg.node().clientHeight;
        var currentTransform = d3.zoomTransform(svg.node());
        var scale = preserveZoom ? currentTransform.k : (options.scale || 1);
        var sessionNode = currentNodes.find(function(node) { return node.type === 'session'; }) || currentNodes[0];
        var focusX = sessionNode && sessionNode.x != null ? sessionNode.x : width / 2;
        var focusY = sessionNode && sessionNode.y != null ? sessionNode.y : height / 2;

        var transform = d3.zoomIdentity
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

        var width = containerEl.clientWidth;
        var height = containerEl.clientHeight;
        var centerX = width / 2;
        var centerY = height / 2;
        var sessionNode = currentNodes.find(function(node) { return node.type === 'session'; }) || null;
        var orbitNodes = currentNodes.filter(function(node) { return node !== sessionNode; });
        var radius = Math.max(50, Math.min(width, height) * 0.2);
        var total = Math.max(1, orbitNodes.length);

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
          var angle = (Math.PI * 2 * index) / total;
          var jitter = 10 * Math.sin(index * 1.7);
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
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        }

        function dragged(event) {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        }

        function dragended(event) {
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
          var classes = ['link'];
          if (d.isLatest) classes.push('latest');
          if (d.linkType === 'task-action') classes.push('task-action');
          if (d.linkType === 'task-dependency') classes.push('task-dependency');
          if (d.linkType === 'plan-sequence') classes.push('plan-sequence');
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
          var classes = ['node'];
          var isClickable = d.type === 'file' || d.type === 'url';
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
          .attr('fill', function(d) { return NODE_COLORS[d.type]; })
          .call(drag(simulation))
          .on('click', function(event, d) {
            vscode.postMessage({ type: 'nodeClicked', nodeId: d.id });
          })
          .on('mouseover', function(event, d) {
            var label = d.fullPath || d.label;
            // Build tooltip content
            if (d.type === 'file') {
              // For files, show touches and line changes
              var firstLine = label;
              if (d.count) {
                firstLine += ' (' + d.count + ' touch' + (d.count > 1 ? 'es' : '') + ')';
              }
              // Show line changes if any exist
              var hasChanges = (d.additions && d.additions > 0) || (d.deletions && d.deletions > 0);
              if (hasChanges) {
                var adds = d.additions || 0;
                var dels = d.deletions || 0;
                tooltipEl.innerHTML = firstLine + '<br><span class="additions">+' + adds + '</span> / <span class="deletions">-' + dels + '</span> lines';
              } else {
                tooltipEl.textContent = firstLine;
              }
            } else if (d.type === 'task') {
              // For tasks, show subject, status, and action count
              var statusLabel = d.taskStatus || 'unknown';
              var statusColor = statusLabel === 'in_progress' ? 'var(--vscode-charts-green, #4caf50)'
                              : statusLabel === 'pending' ? 'var(--vscode-charts-yellow, #FFD700)'
                              : 'var(--vscode-descriptionForeground)';
              var actionCount = d.count || 0;
              var actionText = actionCount === 1 ? '1 action' : actionCount + ' actions';
              tooltipEl.innerHTML = '<strong>' + label + '</strong><br>' +
                '<span style="color: ' + statusColor + '">● ' + statusLabel.replace('_', ' ') + '</span>' +
                '<br>' + actionText;
            } else if (d.type === 'plan') {
              // For plan root, show title and step count
              var stepCount = d.count || 0;
              var stepText = stepCount === 1 ? '1 step' : stepCount + ' steps';
              tooltipEl.innerHTML = '<strong>' + label + '</strong><br>' + stepText;
            } else if (d.type === 'plan-step') {
              // For plan steps, show description and status
              var planStatus = d.planStepStatus || 'pending';
              var planStatusColor = planStatus === 'in_progress' ? 'var(--vscode-charts-green, #4caf50)'
                                 : planStatus === 'pending' ? 'var(--vscode-charts-yellow, #FFD700)'
                                 : 'var(--vscode-descriptionForeground)';
              tooltipEl.innerHTML = '<strong>' + label + '</strong><br>' +
                '<span style="color: ' + planStatusColor + '">● ' + planStatus.replace('_', ' ') + '</span>';
            } else {
              // For other nodes, show count if available
              var count = d.count ? ' (' + d.count + ')' : '';
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
        var fileNodesWithChanges = nodes.filter(function(d) {
          return d.type === 'file' && ((d.additions && d.additions > 0) || (d.deletions && d.deletions > 0));
        });

        var changeLabel = changeGroup.selectAll('text')
          .data(fileNodesWithChanges, function(d) { return d.id; });

        changeLabel.exit().remove();

        changeLabel.enter()
          .append('text')
          .attr('class', 'change-label')
          .html(function(d) {
            var adds = d.additions || 0;
            var dels = d.deletions || 0;
            return '<tspan class="add">+' + adds + '</tspan> <tspan class="del">-' + dels + '</tspan>';
          });

        // Update merged selections
        nodeGroup.selectAll('circle')
          .attr('class', function(d) { return getNodeClass(d); })
          .attr('r', function(d) { return calculateNodeSize(d); })
          .attr('fill', function(d) { return NODE_COLORS[d.type]; });

        labelGroup.selectAll('text')
          .text(function(d) { return d.label; });

        changeGroup.selectAll('text')
          .html(function(d) {
            var adds = d.additions || 0;
            var dels = d.deletions || 0;
            return '<tspan class="add">+' + adds + '</tspan> <tspan class="del">-' + dels + '</tspan>';
          });

        // Update simulation
        applyForceConfig(nodes.length);
        simulation.nodes(nodes);
        simulation.force('link').links(links);
        simulation.alpha(0.3).restart();

        // Check for new activity and focus on it
        setTimeout(function() {
          focusOnNewActivity(nodes, links);
        }, 400);
      }

      /**
       * Focuses the view on new activity (new nodes, new links, or latest link).
       */
      function focusOnNewActivity(nodes, links) {
        if (!svg || !zoom) return;

        // Build current IDs
        var currentNodeIds = new Set(nodes.map(function(n) { return n.id; }));
        var currentLinkIds = new Set(links.map(function(l) {
          var sourceId = l.source.id || l.source;
          var targetId = l.target.id || l.target;
          return sourceId + '-' + targetId;
        }));

        // Find new nodes (excluding session root which is always present)
        var newNodes = nodes.filter(function(n) {
          return !previousNodeIds.has(n.id) && n.type !== 'session';
        });

        // Find new links
        var newLinkIds = [];
        currentLinkIds.forEach(function(id) {
          if (!previousLinkIds.has(id)) newLinkIds.push(id);
        });

        // Find latest link
        var latestLink = links.find(function(l) { return l.isLatest; });
        var latestLinkId = null;
        if (latestLink) {
          var sourceId = latestLink.source.id || latestLink.source;
          var targetId = latestLink.target.id || latestLink.target;
          latestLinkId = sourceId + '-' + targetId;
        }

        // Determine if we should focus
        var hasNewActivity = newNodes.length > 0 || newLinkIds.length > 0;
        var latestLinkChanged = latestLinkId && latestLinkId !== previousLatestLinkId;

        // Update tracking for next time
        previousNodeIds = currentNodeIds;
        previousLinkIds = currentLinkIds;
        previousLatestLinkId = latestLinkId;

        // Only focus if there's new activity or the latest link changed
        if (!hasNewActivity && !latestLinkChanged) return;

        // Determine focus target
        var focusX, focusY;

        if (latestLink && latestLinkChanged) {
          // Focus on latest link (midpoint)
          var source = typeof latestLink.source === 'object' ? latestLink.source : nodes.find(function(n) { return n.id === latestLink.source; });
          var target = typeof latestLink.target === 'object' ? latestLink.target : nodes.find(function(n) { return n.id === latestLink.target; });
          if (source && target && source.x != null && target.x != null) {
            focusX = (source.x + target.x) / 2;
            focusY = (source.y + target.y) / 2;
          }
        } else if (newNodes.length > 0) {
          // Focus on newest node (last in array, typically most recent)
          var newestNode = newNodes[newNodes.length - 1];
          if (newestNode.x != null) {
            focusX = newestNode.x;
            focusY = newestNode.y;
          }
        }

        if (focusX == null || focusY == null) return;

        // Get viewport dimensions and current zoom state
        var width = svg.node().clientWidth;
        var height = svg.node().clientHeight;
        var currentTransform = d3.zoomTransform(svg.node());

        // Preserve user's zoom level, only change pan position
        var scale = currentTransform.k;
        var transform = d3.zoomIdentity
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
        }
      });

      // Handle window resize
      window.addEventListener('resize', function() {
        if (simulation) {
          const width = containerEl.clientWidth;
          const height = containerEl.clientHeight;
          svg.attr('width', width).attr('height', height);
          simulation.force('center', d3.forceCenter(width / 2, height / 2));
          applyForceConfig(currentNodes.length);
          simulation.alpha(0.3).restart();
        }
      });

      if (resetLayoutEl) {
        resetLayoutEl.addEventListener('click', function() {
          resetLayout();
        });
      }

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
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    log('MindMapViewProvider disposed');
  }
}

