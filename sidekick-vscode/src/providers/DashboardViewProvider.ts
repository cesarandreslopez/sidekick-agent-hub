/**
 * @fileoverview Dashboard webview provider for session analytics.
 *
 * This provider manages a sidebar webview that displays real-time
 * token usage analytics from Claude Code sessions. It subscribes to
 * SessionMonitor events and updates the dashboard accordingly.
 *
 * Features:
 * - Real-time token usage display
 * - Cost estimation with model breakdown
 * - Context window visualization
 * - Chart.js integration for time-series data
 *
 * @module providers/DashboardViewProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { QuotaService } from '../services/QuotaService';
import type { QuotaState as DashboardQuotaState } from '../types/dashboard';
import type { TokenUsage, SessionStats, ToolAnalytics, TimelineEvent } from '../types/claudeSession';
import type { DashboardMessage, WebviewMessage, DashboardState } from '../types/dashboard';
import { ModelPricingService } from '../services/ModelPricingService';
import { BurnRateCalculator } from '../services/BurnRateCalculator';
import { log } from '../services/Logger';

/**
 * WebviewViewProvider for the session analytics dashboard.
 *
 * Renders a sidebar panel with token usage statistics, cost estimates,
 * and model breakdown from active Claude Code sessions.
 *
 * @example
 * ```typescript
 * const provider = new DashboardViewProvider(context.extensionUri, sessionMonitor);
 * vscode.window.registerWebviewViewProvider('sidekick.dashboard', provider);
 * ```
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  /** View type identifier for VS Code registration */
  public static readonly viewType = 'sidekick.dashboard';

  /** Current webview view instance */
  private _view?: vscode.WebviewView;

  /** Disposables for cleanup */
  private _disposables: vscode.Disposable[] = [];

  /** Current dashboard state */
  private _state: DashboardState;

  /** Burn rate calculator with 5-minute sliding window */
  private _burnRateCalculator = new BurnRateCalculator(5);

  /** Current context window size from session (actual context, not cumulative) */
  private _currentContextSize: number = 0;

  /** Context window limit for Claude models (200K tokens) */
  private readonly CONTEXT_WINDOW_LIMIT = 200_000;

  /** Tool analytics by name */
  private _toolAnalytics: Map<string, ToolAnalytics> = new Map();

  /** Timeline events (most recent first) */
  private _timeline: TimelineEvent[] = [];

  /** Maximum timeline events to display */
  private readonly MAX_DISPLAY_TIMELINE = 20;

  /** QuotaService for subscription quota data */
  private readonly _quotaService?: QuotaService;

  /**
   * Creates a new DashboardViewProvider.
   *
   * @param _extensionUri - URI of the extension directory
   * @param _sessionMonitor - SessionMonitor instance for token events
   * @param quotaService - Optional QuotaService for subscription quota
   */
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionMonitor: SessionMonitor,
    quotaService?: QuotaService
  ) {
    this._quotaService = quotaService;
    // Initialize empty state
    this._state = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      totalCost: 0,
      contextUsagePercent: 0,
      modelBreakdown: [],
      sessionActive: false,
      lastUpdated: new Date().toISOString(),
      toolAnalytics: [],
      timeline: [],
      errorDetails: []
    };

    // Subscribe to session events
    this._disposables.push(
      this._sessionMonitor.onTokenUsage(usage => this._handleTokenUsage(usage))
    );

    this._disposables.push(
      this._sessionMonitor.onSessionStart(path => this._handleSessionStart(path))
    );

    this._disposables.push(
      this._sessionMonitor.onSessionEnd(() => this._handleSessionEnd())
    );

    this._disposables.push(
      this._sessionMonitor.onToolAnalytics(analytics => this._handleToolAnalytics(analytics))
    );

    this._disposables.push(
      this._sessionMonitor.onTimelineEvent(event => this._handleTimelineEvent(event))
    );

    this._disposables.push(
      this._sessionMonitor.onDiscoveryModeChange(inDiscoveryMode => this._handleDiscoveryModeChange(inDiscoveryMode))
    );

    // Subscribe to quota updates if service available
    if (this._quotaService) {
      this._disposables.push(
        this._quotaService.onQuotaUpdate(quota => this._handleQuotaUpdate(quota))
      );
    }

    // Initialize state from existing session if active
    if (this._sessionMonitor.isActive()) {
      this._syncFromSessionMonitor();
    }
    // If in discovery mode, state is already initialized to inactive

    log('DashboardViewProvider initialized');
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
      (message: WebviewMessage) => this._handleWebviewMessage(message),
      undefined,
      this._disposables
    );

    // Resend state when view becomes visible, manage quota refresh
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._sendStateToWebview();
          // Start quota refresh when visible
          this._quotaService?.startRefresh();
        } else {
          // Stop quota refresh when hidden to save resources
          this._quotaService?.stopRefresh();
        }
      },
      undefined,
      this._disposables
    );

    // Start quota refresh if view is initially visible
    if (webviewView.visible) {
      this._quotaService?.startRefresh();
    }

    log('Dashboard webview resolved');
  }

  /**
   * Handles messages from the webview.
   *
   * @param message - Message from webview
   */
  private _handleWebviewMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'webviewReady':
        log('Dashboard webview ready, sending initial state');
        // Always sync from session monitor to get current data
        if (this._sessionMonitor.isActive()) {
          this._syncFromSessionMonitor();
        }
        this._sendStateToWebview();
        this._sendBurnRateUpdate();
        this._sendSessionList();
        break;

      case 'requestStats':
        this._syncFromSessionMonitor();
        this._sendStateToWebview();
        break;

      case 'selectSession':
        log(`Dashboard: user selected session: ${message.sessionPath}`);
        this._sessionMonitor.switchToSession(message.sessionPath);
        break;

      case 'refreshSessions':
        this._sendSessionList();
        break;
    }
  }

  /**
   * Handles token usage events from SessionMonitor.
   *
   * Updates state and sends to webview.
   *
   * @param usage - Token usage data
   */
  private _handleTokenUsage(usage: TokenUsage): void {
    // Get pricing for the model
    const pricing = ModelPricingService.getPricing(usage.model);
    const cost = ModelPricingService.calculateCost({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens
    }, pricing);

    // Update totals
    this._state.totalInputTokens += usage.inputTokens;
    this._state.totalOutputTokens += usage.outputTokens;
    this._state.totalCacheWriteTokens += usage.cacheWriteTokens;
    this._state.totalCacheReadTokens += usage.cacheReadTokens;
    this._state.totalCost += cost;
    this._state.lastUpdated = new Date().toISOString();
    this._state.sessionActive = true;

    // Update model breakdown
    const existingModel = this._state.modelBreakdown.find(m => m.model === usage.model);
    if (existingModel) {
      existingModel.calls += 1;
      existingModel.tokens += usage.inputTokens + usage.outputTokens;
      existingModel.cost += cost;
    } else {
      this._state.modelBreakdown.push({
        model: usage.model,
        calls: 1,
        tokens: usage.inputTokens + usage.outputTokens,
        cost: cost
      });
    }

    // Track burn rate (total tokens including cache)
    const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
    this._burnRateCalculator.addEvent(totalTokens, usage.timestamp);

    // Update current context size (input + cache = actual context window usage)
    this._currentContextSize = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;

    // Update context usage
    this._updateContextUsage();

    // Send updated state to webview
    this._sendStateToWebview();
    this._sendBurnRateUpdate();
  }

  /**
   * Handles tool analytics updates from SessionMonitor.
   */
  private _handleToolAnalytics(analytics: ToolAnalytics): void {
    this._toolAnalytics.set(analytics.name, analytics);
    this._updateToolAnalyticsState();
    this._sendToolAnalyticsToWebview();
  }

  /**
   * Handles timeline events from SessionMonitor.
   */
  private _handleTimelineEvent(event: TimelineEvent): void {
    // Add to beginning
    this._timeline.unshift(event);

    // Cap at display limit
    if (this._timeline.length > this.MAX_DISPLAY_TIMELINE) {
      this._timeline = this._timeline.slice(0, this.MAX_DISPLAY_TIMELINE);
    }

    this._updateTimelineState();
    this._sendTimelineToWebview();
  }

  /**
   * Converts internal tool analytics to display format.
   */
  private _updateToolAnalyticsState(): void {
    this._state.toolAnalytics = Array.from(this._toolAnalytics.values())
      .map(a => ({
        name: a.name,
        totalCalls: a.completedCount,
        successRate: a.completedCount > 0
          ? (a.successCount / a.completedCount) * 100
          : 0,
        avgDuration: a.completedCount > 0
          ? Math.round(a.totalDuration / a.completedCount)
          : 0,
        pendingCount: a.pendingCount
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls); // Sort by most used
  }

  /**
   * Converts internal timeline to display format.
   */
  private _updateTimelineState(): void {
    this._state.timeline = this._timeline.map(e => ({
      type: e.type as 'user_prompt' | 'tool_call' | 'tool_result' | 'error',
      time: new Date(e.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      description: e.description,
      isError: e.metadata?.isError
    }));
  }

  /**
   * Sends tool analytics update to webview.
   */
  private _sendToolAnalyticsToWebview(): void {
    this._postMessage({
      type: 'updateToolAnalytics',
      analytics: this._state.toolAnalytics
    });
  }

  /**
   * Sends timeline update to webview.
   */
  private _sendTimelineToWebview(): void {
    this._postMessage({
      type: 'updateTimeline',
      events: this._state.timeline
    });
  }

  /**
   * Handles session start events.
   *
   * @param sessionPath - Path to the session file
   */
  private _handleSessionStart(sessionPath: string): void {
    log(`Dashboard: session started at ${sessionPath}`);
    this._state.sessionActive = true;
    this._burnRateCalculator.reset();
    this._toolAnalytics.clear();
    this._timeline = [];
    this._state.toolAnalytics = [];
    this._state.timeline = [];
    this._state.errorDetails = [];
    this._currentContextSize = 0;
    this._syncFromSessionMonitor();

    // Notify webview
    this._postMessage({ type: 'sessionStart', sessionPath });
    this._sendStateToWebview();
    this._sendBurnRateUpdate();
    this._sendSessionList();
  }

  /**
   * Handles session end events.
   */
  private _handleSessionEnd(): void {
    log('Dashboard: session ended');
    this._state.sessionActive = false;
    this._postMessage({ type: 'sessionEnd' });
    this._sendStateToWebview();
    this._sendSessionList();
  }

  /**
   * Handles discovery mode change events.
   * @param inDiscoveryMode - Whether the monitor is now in discovery mode
   */
  private _handleDiscoveryModeChange(inDiscoveryMode: boolean): void {
    log(`Dashboard: discovery mode changed to ${inDiscoveryMode}`);
    this._postMessage({
      type: 'discoveryModeChange',
      inDiscoveryMode
    });
    // Also refresh session list when entering/exiting discovery mode
    this._sendSessionList();
  }

  /**
   * Handles quota updates from QuotaService.
   * @param quota - Updated quota state
   */
  private _handleQuotaUpdate(quota: DashboardQuotaState): void {
    this._postMessage({ type: 'updateQuota', quota });
  }

  /**
   * Syncs state from SessionMonitor stats.
   */
  private _syncFromSessionMonitor(): void {
    const stats: SessionStats = this._sessionMonitor.getStats();

    log(`Sync from SessionMonitor - input: ${stats.totalInputTokens}, output: ${stats.totalOutputTokens}, cacheWrite: ${stats.totalCacheWriteTokens}, cacheRead: ${stats.totalCacheReadTokens}, contextSize: ${stats.currentContextSize}, recentEvents: ${stats.recentUsageEvents.length}`);

    this._state.totalInputTokens = stats.totalInputTokens;
    this._state.totalOutputTokens = stats.totalOutputTokens;
    this._state.totalCacheWriteTokens = stats.totalCacheWriteTokens;
    this._state.totalCacheReadTokens = stats.totalCacheReadTokens;
    this._state.lastUpdated = stats.lastUpdated.toISOString();
    this._state.sessionActive = this._sessionMonitor.isActive();

    // Sync context size from session BEFORE calculating usage percentage
    this._currentContextSize = stats.currentContextSize;

    // Rebuild model breakdown with costs
    this._state.modelBreakdown = [];
    this._state.totalCost = 0;

    stats.modelUsage.forEach((usage, model) => {
      const pricing = ModelPricingService.getPricing(model);
      // Estimate cost based on total tokens (rough approximation - assume 50/50 split)
      const estimatedInput = Math.floor(usage.tokens / 2);
      const estimatedOutput = usage.tokens - estimatedInput;
      const cost = ModelPricingService.calculateCost({
        inputTokens: estimatedInput,
        outputTokens: estimatedOutput,
        cacheWriteTokens: 0,
        cacheReadTokens: 0
      }, pricing);

      this._state.modelBreakdown.push({
        model,
        calls: usage.calls,
        tokens: usage.tokens,
        cost
      });

      this._state.totalCost += cost;
    });

    // Calculate context window usage (uses _currentContextSize synced above)
    this._updateContextUsage();

    // Sync tool analytics
    this._toolAnalytics = new Map(stats.toolAnalytics);
    this._updateToolAnalyticsState();

    // Sync timeline
    this._timeline = [...stats.timeline].slice(0, this.MAX_DISPLAY_TIMELINE);
    this._updateTimelineState();

    // Sync error details
    this._state.errorDetails = Array.from(stats.errorDetails.entries())
      .map(([type, messages]) => ({ type, count: messages.length, messages }));

    // Pre-populate burn rate calculator with recent events from session
    // This ensures burn rate shows correctly when loading existing sessions
    this._burnRateCalculator.reset();
    for (const event of stats.recentUsageEvents) {
      this._burnRateCalculator.addEvent(event.tokens, event.timestamp);
    }
  }

  /**
   * Sends current state to the webview.
   */
  private _sendStateToWebview(): void {
    this._postMessage({ type: 'updateStats', state: this._state });
  }

  /**
   * Sends burn rate and session timing update to the webview.
   */
  private _sendBurnRateUpdate(): void {
    const stats = this._sessionMonitor.getStats();
    this._postMessage({
      type: 'updateBurnRate',
      burnRate: this._burnRateCalculator.calculateBurnRate(),
      sessionStartTime: stats.sessionStartTime?.toISOString() ?? null
    });
  }

  /**
   * Sends the list of available sessions to the webview.
   */
  private _sendSessionList(): void {
    const sessions = this._sessionMonitor.getAvailableSessions();
    this._postMessage({
      type: 'updateSessionList',
      sessions: sessions.map(s => ({
        path: s.path,
        filename: s.filename,
        modifiedTime: s.modifiedTime.toISOString(),
        isCurrent: s.isCurrent
      }))
    });
  }

  /**
   * Updates context window usage percentage.
   * Uses the actual context size from the most recent message, not cumulative tokens.
   */
  private _updateContextUsage(): void {
    // Context window = actual tokens in context from most recent message
    // This is input + cache_write + cache_read tokens
    this._state.contextUsagePercent = (this._currentContextSize / this.CONTEXT_WINDOW_LIMIT) * 100;
  }

  /**
   * Posts a message to the webview.
   *
   * @param message - Message to post
   */
  private _postMessage(message: DashboardMessage): void {
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

    // Get icon URI for branding
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
  <title>Session Analytics</title>
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
      padding: 12px;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .header img {
      width: 24px;
      height: 24px;
    }

    .header h1 {
      font-size: 14px;
      font-weight: 600;
    }

    .status {
      margin-left: auto;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .status.active {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }

    .status.inactive {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .section {
      margin-bottom: 16px;
    }

    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }

    .token-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .token-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
    }

    .token-card .label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .token-card .value {
      font-size: 16px;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
    }

    .cost-display {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 12px;
      text-align: center;
    }

    .cost-display .label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .cost-display .value {
      font-size: 24px;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-charts-green);
    }

    .context-bar {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
    }

    .context-bar .label-row {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .context-bar .bar {
      height: 8px;
      background: var(--vscode-progressBar-background);
      border-radius: 4px;
      overflow: hidden;
    }

    .context-bar .bar-fill {
      height: 100%;
      background: var(--vscode-charts-blue);
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .model-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .model-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 12px;
    }

    .model-item .name {
      font-family: var(--vscode-editor-font-family);
      font-weight: 500;
    }

    .model-item .stats {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    .empty-state {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state p {
      margin-top: 8px;
      font-size: 12px;
    }

    .chart-container {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      height: 150px;
    }

    .last-updated {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      margin-top: 8px;
    }

    .burn-rate, .quota-timer {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .burn-rate .value {
      font-size: 20px;
      font-weight: bold;
      color: var(--vscode-charts-blue);
    }

    .burn-rate .unit {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .quota-timer .value {
      font-size: 20px;
      font-weight: bold;
    }

    .quota-estimate {
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .quota-estimate.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .context-gauge {
      position: relative;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
    }

    .context-gauge canvas {
      width: 100% !important;
      height: 100px !important;
    }

    .context-gauge .context-percent {
      position: absolute;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 20px;
      font-weight: bold;
      font-family: var(--vscode-editor-font-family);
    }

    .context-gauge .context-percent.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .context-gauge .context-percent.danger {
      color: var(--vscode-editorError-foreground);
    }

    .gauge-row {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }

    .gauge-row-item {
      flex: 1;
      min-width: 0;
    }

    .gauge-row-item .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }

    .gauge-row .context-item {
      flex: 0 0 35%;
    }

    .gauge-row .quota-item {
      flex: 1;
    }

    .gauge-row .context-gauge {
      height: 90px;
    }

    .gauge-row .context-gauge canvas {
      height: 70px !important;
    }

    .quota-section {
      display: none;
    }

    .quota-section.visible {
      display: block;
    }

    .quota-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    .quota-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px;
      text-align: center;
    }

    .quota-card .quota-label {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }

    .quota-card .quota-gauge {
      position: relative;
      height: 55px;
    }

    .quota-card .quota-gauge canvas {
      width: 100% !important;
      height: 55px !important;
    }

    .quota-card .quota-percent {
      position: absolute;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      font-size: 14px;
      font-weight: bold;
      font-family: var(--vscode-editor-font-family);
    }

    .quota-card .quota-percent.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .quota-card .quota-percent.danger {
      color: var(--vscode-editorError-foreground);
    }

    .quota-card .quota-reset {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .quota-error {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      text-align: center;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .tool-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .tool-item {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
    }

    .tool-item .tool-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }

    .tool-item .tool-name {
      font-family: var(--vscode-editor-font-family);
      font-weight: 500;
      font-size: 12px;
    }

    .tool-item .tool-calls {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .tool-item .tool-stats {
      display: flex;
      gap: 12px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .tool-item .success-rate {
      color: var(--vscode-charts-green);
    }

    .tool-item .success-rate.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .timeline-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 200px;
      overflow-y: auto;
    }

    .timeline-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 4px 8px;
      font-size: 11px;
      background: var(--vscode-input-background);
      border-radius: 3px;
    }

    .timeline-item .time {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      min-width: 50px;
    }

    .timeline-item .icon {
      width: 14px;
      text-align: center;
    }

    .timeline-item .description {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .timeline-item.error {
      background: var(--vscode-inputValidation-errorBackground);
    }

    .error-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
    }

    .error-group {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      overflow: hidden;
    }

    .error-group-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 8px;
      cursor: pointer;
      background: var(--vscode-inputValidation-errorBackground);
      user-select: none;
    }

    .error-group-header:hover {
      filter: brightness(1.1);
    }

    .error-group-header .error-type {
      font-weight: 500;
    }

    .error-group-header .error-count {
      font-size: 10px;
      opacity: 0.8;
    }

    .error-group-header .chevron {
      transition: transform 0.2s;
    }

    .error-group.expanded .chevron {
      transform: rotate(90deg);
    }

    .error-group-messages {
      display: none;
      padding: 0;
      margin: 0;
      list-style: none;
      max-height: 150px;
      overflow-y: auto;
    }

    .error-group.expanded .error-group-messages {
      display: block;
    }

    .error-group-messages li {
      padding: 4px 8px;
      border-top: 1px solid var(--vscode-panel-border);
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
      word-break: break-word;
    }

    .session-selector {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 12px;
      padding: 8px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
    }

    .session-selector label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    .session-selector select {
      flex: 1;
      min-width: 0;
      padding: 4px 6px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 3px;
      cursor: pointer;
    }

    .session-selector select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .session-selector .refresh-btn {
      padding: 4px 6px;
      font-size: 11px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }

    .session-selector .refresh-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="Sidekick" />
    <h1>Session Analytics</h1>
    <span id="status" class="status inactive">No Session</span>
  </div>

  <div class="session-selector" title="Select a session to view its analytics">
    <label for="session-select">Session:</label>
    <select id="session-select">
      <option value="">No sessions available</option>
    </select>
    <button class="refresh-btn" id="refresh-sessions" title="Refresh session list">↻</button>
  </div>

  <div id="content">
    <div class="empty-state">
      <p>No active Claude Code session detected.</p>
      <p>Start a session to see analytics.</p>
    </div>
  </div>

  <div id="dashboard" style="display: none;">
    <div class="section" title="Total tokens used in this session, broken down by type">
      <div class="section-title">Token Usage</div>
      <div class="token-grid">
        <div class="token-card" title="Tokens sent to Claude (your messages, system prompts, file contents)">
          <div class="label">Input</div>
          <div class="value" id="input-tokens">0</div>
        </div>
        <div class="token-card" title="Tokens generated by Claude (responses, code, explanations)">
          <div class="label">Output</div>
          <div class="value" id="output-tokens">0</div>
        </div>
        <div class="token-card" title="Tokens written to cache for reuse in future messages">
          <div class="label">Cache Write</div>
          <div class="value" id="cache-write-tokens">0</div>
        </div>
        <div class="token-card" title="Tokens read from cache instead of being re-sent (saves time and quota)">
          <div class="label">Cache Read</div>
          <div class="value" id="cache-read-tokens">0</div>
        </div>
      </div>
    </div>

    <div class="gauge-row" id="gauge-row">
      <div class="gauge-row-item context-item" title="How much of Claude's 200K token context window is currently in use">
        <div class="section-title">Context Window</div>
        <div class="context-gauge" title="Green: &lt;50% | Orange: 50-79% | Red: ≥80%. When full, older context is summarized.">
          <canvas id="contextChart"></canvas>
          <span class="context-percent" id="context-percent">0%</span>
        </div>
      </div>

      <div class="gauge-row-item quota-item quota-section" id="quota-section" title="Claude Max subscription usage limits">
        <div class="section-title">Subscription Quota</div>
        <div id="quota-content">
          <div class="quota-grid">
            <div class="quota-card" title="Usage in the last 5 hours">
              <div class="quota-label">5-Hour</div>
              <div class="quota-gauge">
                <canvas id="quota5hChart"></canvas>
                <span class="quota-percent" id="quota-5h-percent">0%</span>
              </div>
              <div class="quota-reset" id="quota-5h-reset">-</div>
            </div>
            <div class="quota-card" title="Usage in the last 7 days">
              <div class="quota-label">7-Day</div>
              <div class="quota-gauge">
                <canvas id="quota7dChart"></canvas>
                <span class="quota-percent" id="quota-7d-percent">0%</span>
              </div>
              <div class="quota-reset" id="quota-7d-reset">-</div>
            </div>
          </div>
        </div>
        <div class="quota-error" id="quota-error" style="display: none;"></div>
      </div>
    </div>

    <div class="section context-bar-fallback" style="display: none;">
      <div class="section-title">Context Window</div>
      <div class="context-bar">
        <div class="label-row">
          <span>Usage</span>
          <span id="context-percent">0%</span>
        </div>
        <div class="bar">
          <div class="bar-fill" id="context-fill" style="width: 0%"></div>
        </div>
      </div>
    </div>

    <div class="section" title="Recent events in chronological order">
      <div class="section-title">Activity Timeline</div>
      <div class="timeline-list" id="timeline-list" title="Shows user prompts, tool calls, and their results">
        <div class="timeline-item">
          <span class="time">--:--</span>
          <span class="description">No activity yet</span>
        </div>
      </div>
    </div>

    <div class="section" title="How quickly tokens are being consumed in this session">
      <div class="section-title">Usage Rate</div>
      <div class="burn-rate" title="Average tokens per minute over the last 5 minutes of activity">
        <span class="label">Burn Rate</span>
        <span class="value" id="burn-rate">0</span>
        <span class="unit">tokens/min</span>
      </div>
    </div>

    <div class="section" title="How long this Claude Code session has been running">
      <div class="section-title">Session Duration</div>
      <div class="session-timer" title="Time since the first message in this session">
        <span class="value" id="session-timer">0m</span>
      </div>
    </div>

    <div class="section" title="Which Claude models have been used and their token consumption">
      <div class="section-title">Model Breakdown</div>
      <div class="model-list" id="model-list" title="Opus: highest quality | Sonnet: balanced | Haiku: fast and efficient">
        <!-- Model items will be inserted here -->
      </div>
    </div>

    <div class="section" title="Tools invoked by Claude during this session">
      <div class="section-title">Tool Analytics</div>
      <div class="tool-list" id="tool-list" title="Shows tool usage count, success rate, and average execution time">
        <div class="tool-item"><span class="tool-name">No tools used yet</span></div>
      </div>
    </div>

    <div class="section" id="error-section" style="display: none;" title="Errors encountered during tool execution">
      <div class="section-title">Errors</div>
      <div class="error-list" id="error-list" title="Click to expand error details"></div>
    </div>

    <div class="last-updated">
      Last updated: <span id="last-updated">-</span>
    </div>
  </div>

  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();

      // DOM elements
      const statusEl = document.getElementById('status');
      const contentEl = document.getElementById('content');
      const dashboardEl = document.getElementById('dashboard');
      const inputTokensEl = document.getElementById('input-tokens');
      const outputTokensEl = document.getElementById('output-tokens');
      const cacheWriteTokensEl = document.getElementById('cache-write-tokens');
      const cacheReadTokensEl = document.getElementById('cache-read-tokens');
      const contextPercentEl = document.getElementById('context-percent');
      const modelListEl = document.getElementById('model-list');
      const lastUpdatedEl = document.getElementById('last-updated');
      const sessionSelectEl = document.getElementById('session-select');
      const refreshSessionsBtn = document.getElementById('refresh-sessions');

      // Context gauge chart
      let contextChart = null;
      const GAUGE_COLORS = {
        green: 'rgb(75, 192, 192)',
        orange: 'rgb(255, 159, 64)',
        red: 'rgb(255, 99, 132)',
        background: 'rgba(100, 100, 100, 0.2)'
      };

      /**
       * Formats a number with commas for readability.
       */
      function formatNumber(num) {
        return num.toLocaleString();
      }

      /**
       * Formats cost with appropriate precision.
       */
      function formatCost(cost) {
        if (cost < 0.01) {
          return '$' + cost.toFixed(4);
        }
        return '$' + cost.toFixed(2);
      }

      /**
       * Extracts short model name from full ID.
       */
      function getShortModelName(modelId) {
        const match = modelId.match(/claude-(haiku|sonnet|opus)-([0-9.]+)/i);
        if (match) {
          return match[1].charAt(0).toUpperCase() + match[1].slice(1) + ' ' + match[2];
        }
        return modelId;
      }

      /**
       * Gets the appropriate color for context gauge based on percentage.
       */
      function getGaugeColor(percent) {
        // Match Claude Code statusline thresholds
        if (percent >= 80) return GAUGE_COLORS.red;
        if (percent >= 50) return GAUGE_COLORS.orange;
        return GAUGE_COLORS.green;
      }

      /**
       * Initializes the Chart.js context gauge.
       */
      function initContextGauge() {
        const canvas = document.getElementById('contextChart');
        if (!canvas || !window.Chart) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        contextChart = new Chart(ctx, {
          type: 'doughnut',
          data: {
            datasets: [{
              data: [0, 100],
              backgroundColor: [GAUGE_COLORS.green, GAUGE_COLORS.background],
              borderWidth: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            circumference: 180,
            rotation: 270,
            cutout: '70%',
            plugins: {
              legend: { display: false },
              tooltip: { enabled: false }
            }
          }
        });
      }

      /**
       * Updates the context gauge with new percentage.
       */
      function updateContextGauge(percent) {
        const clampedPercent = Math.min(100, Math.max(0, percent));

        if (contextChart) {
          contextChart.data.datasets[0].data = [clampedPercent, 100 - clampedPercent];
          contextChart.data.datasets[0].backgroundColor = [
            getGaugeColor(clampedPercent),
            GAUGE_COLORS.background
          ];
          contextChart.update('none');
        }

        // Update percentage text with color coding
        if (contextPercentEl) {
          contextPercentEl.textContent = Math.round(percent) + '%';
          contextPercentEl.className = 'context-percent';
          if (percent >= 80) {
            contextPercentEl.classList.add('danger');
          } else if (percent >= 50) {
            contextPercentEl.classList.add('warning');
          }
        }
      }

      // Quota gauge charts
      let quota5hChart = null;
      let quota7dChart = null;

      /**
       * Creates a quota gauge chart.
       */
      function createQuotaGauge(canvasId) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !window.Chart) return null;

        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        return new Chart(ctx, {
          type: 'doughnut',
          data: {
            datasets: [{
              data: [0, 100],
              backgroundColor: [GAUGE_COLORS.green, GAUGE_COLORS.background],
              borderWidth: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            circumference: 180,
            rotation: 270,
            cutout: '65%',
            plugins: {
              legend: { display: false },
              tooltip: { enabled: false }
            }
          }
        });
      }

      /**
       * Initializes quota gauge charts.
       */
      function initQuotaGauges() {
        quota5hChart = createQuotaGauge('quota5hChart');
        quota7dChart = createQuotaGauge('quota7dChart');
      }

      /**
       * Updates a quota gauge with new percentage.
       */
      function updateQuotaGauge(chart, percentEl, percent) {
        const clampedPercent = Math.min(100, Math.max(0, percent));

        if (chart) {
          chart.data.datasets[0].data = [clampedPercent, 100 - clampedPercent];
          chart.data.datasets[0].backgroundColor = [
            getGaugeColor(clampedPercent),
            GAUGE_COLORS.background
          ];
          chart.update('none');
        }

        if (percentEl) {
          percentEl.textContent = Math.round(percent) + '%';
          percentEl.className = 'quota-percent';
          if (percent >= 80) {
            percentEl.classList.add('danger');
          } else if (percent >= 50) {
            percentEl.classList.add('warning');
          }
        }
      }

      /**
       * Formats a reset time as relative (e.g., "Resets in 2h 15m").
       */
      function formatResetTime(isoString) {
        if (!isoString) return '-';

        var resetDate = new Date(isoString);
        var now = new Date();
        var diffMs = resetDate - now;

        if (diffMs <= 0) return 'Resetting...';

        var diffMins = Math.floor(diffMs / 60000);
        var diffHours = Math.floor(diffMins / 60);
        var diffDays = Math.floor(diffHours / 24);

        if (diffDays > 0) {
          var remainingHours = diffHours % 24;
          return 'Resets in ' + diffDays + 'd ' + remainingHours + 'h';
        }
        if (diffHours > 0) {
          var remainingMins = diffMins % 60;
          return 'Resets in ' + diffHours + 'h ' + remainingMins + 'm';
        }
        return 'Resets in ' + diffMins + 'm';
      }

      /**
       * Updates the quota display with new data.
       */
      function updateQuota(quota) {
        var sectionEl = document.getElementById('quota-section');
        var contentEl = document.getElementById('quota-content');
        var errorEl = document.getElementById('quota-error');

        if (!sectionEl || !contentEl || !errorEl) return;

        if (!quota.available) {
          // Hide quota section or show error
          if (quota.error) {
            sectionEl.classList.add('visible');
            contentEl.style.display = 'none';
            errorEl.style.display = 'block';
            errorEl.textContent = quota.error;
          } else {
            sectionEl.classList.remove('visible');
          }
          return;
        }

        // Show quota section with data
        sectionEl.classList.add('visible');
        contentEl.style.display = 'block';
        errorEl.style.display = 'none';

        // Update 5-hour gauge
        var percent5hEl = document.getElementById('quota-5h-percent');
        var reset5hEl = document.getElementById('quota-5h-reset');
        updateQuotaGauge(quota5hChart, percent5hEl, quota.fiveHour.utilization);
        if (reset5hEl) {
          reset5hEl.textContent = formatResetTime(quota.fiveHour.resetsAt);
        }

        // Update 7-day gauge
        var percent7dEl = document.getElementById('quota-7d-percent');
        var reset7dEl = document.getElementById('quota-7d-reset');
        updateQuotaGauge(quota7dChart, percent7dEl, quota.sevenDay.utilization);
        if (reset7dEl) {
          reset7dEl.textContent = formatResetTime(quota.sevenDay.resetsAt);
        }
      }

      /**
       * Updates tool analytics display.
       */
      function updateToolAnalytics(analytics) {
        const toolListEl = document.getElementById('tool-list');
        if (!toolListEl) return;

        if (!analytics || analytics.length === 0) {
          toolListEl.innerHTML = '<div class="tool-item"><span class="tool-name">No tools used yet</span></div>';
          return;
        }

        toolListEl.innerHTML = analytics.map(function(tool) {
          const successClass = tool.successRate < 90 ? 'warning' : '';
          const avgDuration = tool.avgDuration < 1000
            ? tool.avgDuration + 'ms'
            : (tool.avgDuration / 1000).toFixed(1) + 's';

          return '<div class="tool-item">' +
            '<div class="tool-header">' +
              '<span class="tool-name">' + tool.name + '</span>' +
              '<span class="tool-calls">' + tool.totalCalls + ' calls' +
                (tool.pendingCount > 0 ? ' (' + tool.pendingCount + ' pending)' : '') +
              '</span>' +
            '</div>' +
            '<div class="tool-stats">' +
              '<span class="success-rate ' + successClass + '">' +
                tool.successRate.toFixed(0) + '% success' +
              '</span>' +
              '<span class="avg-duration">avg ' + avgDuration + '</span>' +
            '</div>' +
          '</div>';
        }).join('');
      }

      /**
       * Updates timeline display.
       */
      function updateTimeline(events) {
        const timelineEl = document.getElementById('timeline-list');
        if (!timelineEl) return;

        if (!events || events.length === 0) {
          timelineEl.innerHTML = '<div class="timeline-item">' +
            '<span class="time">--:--</span>' +
            '<span class="description">No activity yet</span>' +
          '</div>';
          return;
        }

        const iconMap = {
          'user_prompt': '💬',
          'tool_call': '🔧',
          'tool_result': '✓',
          'error': '❌'
        };

        timelineEl.innerHTML = events.map(function(event) {
          const icon = iconMap[event.type] || '$(circle)';
          const errorClass = event.isError ? ' error' : '';

          return '<div class="timeline-item' + errorClass + '">' +
            '<span class="time">' + event.time + '</span>' +
            '<span class="icon">' + icon + '</span>' +
            '<span class="description">' + event.description + '</span>' +
          '</div>';
        }).join('');
      }

      /**
       * Updates error display with foldable groups.
       */
      function updateErrorDetails(errorDetails) {
        const sectionEl = document.getElementById('error-section');
        const listEl = document.getElementById('error-list');
        if (!sectionEl || !listEl) return;

        if (!errorDetails || errorDetails.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';
        listEl.innerHTML = errorDetails.map(function(group, idx) {
          var messagesHtml = group.messages.map(function(msg) {
            return '<li>' + escapeHtml(msg) + '</li>';
          }).join('');

          return '<div class="error-group" data-idx="' + idx + '">' +
            '<div class="error-group-header">' +
              '<span class="error-type">' + group.type + '</span>' +
              '<span class="error-count">' + group.count + ' error' + (group.count > 1 ? 's' : '') + '</span>' +
              '<span class="chevron">▶</span>' +
            '</div>' +
            '<ul class="error-group-messages">' + messagesHtml + '</ul>' +
          '</div>';
        }).join('');

        // Add click listeners (CSP blocks inline onclick)
        listEl.querySelectorAll('.error-group-header').forEach(function(header) {
          header.addEventListener('click', function() {
            header.parentElement.classList.toggle('expanded');
          });
        });
      }

      /**
       * Escapes HTML to prevent XSS.
       */
      function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }

      /**
       * Updates the session selector dropdown.
       */
      function updateSessionList(sessions) {
        if (!sessionSelectEl) return;

        // Clear current options
        sessionSelectEl.innerHTML = '';

        if (!sessions || sessions.length === 0) {
          var opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No sessions available';
          sessionSelectEl.appendChild(opt);
          return;
        }

        // Add sessions to dropdown
        sessions.forEach(function(session, index) {
          var opt = document.createElement('option');
          opt.value = session.path;

          // Format: "Latest" or relative time + short ID
          var date = new Date(session.modifiedTime);
          var timeStr = formatRelativeTime(date);
          var shortId = session.filename.slice(0, 8);

          if (index === 0) {
            opt.textContent = 'Latest (' + shortId + ')';
          } else {
            opt.textContent = timeStr + ' (' + shortId + ')';
          }

          if (session.isCurrent) {
            opt.selected = true;
          }

          sessionSelectEl.appendChild(opt);
        });
      }

      /**
       * Formats a date as relative time (e.g., "5m ago", "2h ago").
       */
      function formatRelativeTime(date) {
        var now = new Date();
        var diffMs = now - date;
        var diffMins = Math.floor(diffMs / 60000);
        var diffHours = Math.floor(diffMins / 60);
        var diffDays = Math.floor(diffHours / 24);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return diffMins + 'm ago';
        if (diffHours < 24) return diffHours + 'h ago';
        return diffDays + 'd ago';
      }

      /**
       * Updates the dashboard with new state.
       */
      function updateDashboard(state) {
        // Show dashboard, hide empty state
        if (state.sessionActive || state.totalInputTokens > 0) {
          contentEl.style.display = 'none';
          dashboardEl.style.display = 'block';
        } else {
          contentEl.style.display = 'block';
          dashboardEl.style.display = 'none';
        }

        // Update status
        if (state.sessionActive) {
          statusEl.textContent = 'Active';
          statusEl.className = 'status active';
        } else {
          statusEl.textContent = 'No Session';
          statusEl.className = 'status inactive';
        }

        // Update tokens
        inputTokensEl.textContent = formatNumber(state.totalInputTokens);
        outputTokensEl.textContent = formatNumber(state.totalOutputTokens);
        cacheWriteTokensEl.textContent = formatNumber(state.totalCacheWriteTokens);
        cacheReadTokensEl.textContent = formatNumber(state.totalCacheReadTokens);

        // Update context gauge
        updateContextGauge(state.contextUsagePercent || 0);

        // Update model breakdown
        modelListEl.innerHTML = '';
        if (state.modelBreakdown.length === 0) {
          modelListEl.innerHTML = '<div class="model-item"><span class="name">No models used yet</span></div>';
        } else {
          state.modelBreakdown.forEach(function(model) {
            const item = document.createElement('div');
            item.className = 'model-item';
            item.innerHTML = '<span class="name">' + getShortModelName(model.model) + '</span>' +
              '<span class="stats">' + model.calls + ' calls, ' + formatNumber(model.tokens) + ' tokens, ' + formatCost(model.cost) + '</span>';
            modelListEl.appendChild(item);
          });
        }

        // Update error details
        if (state.errorDetails) {
          updateErrorDetails(state.errorDetails);
        }

        // Update timestamp
        if (state.lastUpdated) {
          const date = new Date(state.lastUpdated);
          lastUpdatedEl.textContent = date.toLocaleTimeString();
        }
      }

      // Handle messages from extension
      window.addEventListener('message', function(event) {
        const message = event.data;

        switch (message.type) {
          case 'updateStats':
            updateDashboard(message.state);
            break;

          case 'updateToolAnalytics':
            updateToolAnalytics(message.analytics);
            break;

          case 'updateTimeline':
            updateTimeline(message.events);
            break;

          case 'sessionStart':
            statusEl.textContent = 'Active';
            statusEl.className = 'status active';
            break;

          case 'sessionEnd':
            statusEl.textContent = 'Ended';
            statusEl.className = 'status inactive';
            break;

          case 'updateBurnRate':
            var burnRateEl = document.getElementById('burn-rate');
            var sessionTimerEl = document.getElementById('session-timer');
            if (burnRateEl) {
              burnRateEl.textContent = Math.round(message.burnRate).toLocaleString();
            }
            if (sessionTimerEl && message.sessionStartTime) {
              var start = new Date(message.sessionStartTime);
              var now = new Date();
              var minutes = Math.floor((now - start) / 60000);
              var hours = Math.floor(minutes / 60);
              var mins = minutes % 60;
              sessionTimerEl.textContent = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
            }
            break;

          case 'updateSessionList':
            updateSessionList(message.sessions);
            break;

          case 'updateQuota':
            updateQuota(message.quota);
            break;
        }
      });

      // Session selector event handlers
      if (sessionSelectEl) {
        sessionSelectEl.addEventListener('change', function() {
          var selectedPath = sessionSelectEl.value;
          if (selectedPath) {
            vscode.postMessage({ type: 'selectSession', sessionPath: selectedPath });
          }
        });
      }

      if (refreshSessionsBtn) {
        refreshSessionsBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'refreshSessions' });
        });
      }

      // Initialize charts and signal ready
      initContextGauge();
      initQuotaGauges();
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
    log('DashboardViewProvider disposed');
  }
}

/**
 * Generates a random nonce for CSP.
 * @returns 32-character random string
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
