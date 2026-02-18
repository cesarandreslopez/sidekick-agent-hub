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
import * as fs from 'fs';
import * as path from 'path';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { QuotaService } from '../services/QuotaService';
import type { HistoricalDataService } from '../services/HistoricalDataService';
import type { GuidanceAdvisor } from '../services/GuidanceAdvisor';
import type { QuotaState as DashboardQuotaState, HistoricalSummary, HistoricalDataPoint, LatencyDisplay, ClaudeMdSuggestionDisplay } from '../types/dashboard';
import { resolveInstructionTarget } from '../types/instructionFile';
import type { HandoffService } from '../services/HandoffService';
import { encodeWorkspacePath } from '../services/SessionPathResolver';
import { resolveModel } from '../services/ModelResolver';
import { TimeoutError } from '../types';
import type { TokenUsage, SessionStats, ToolAnalytics, TimelineEvent, ToolCall, LatencyStats } from '../types/claudeSession';
import type { DashboardMessage, DashboardWebviewMessage, DashboardState, CompactionEventDisplay, ToolCallDetailDisplay } from '../types/dashboard';
import type { SessionAnalyzer } from '../services/SessionAnalyzer';
import type { AuthService } from '../services/AuthService';
import type { SessionEventLogger } from '../services/SessionEventLogger';
import type { DecisionLogService } from '../services/DecisionLogService';
import type { SessionSummaryData } from '../types/sessionSummary';
import { ModelPricingService } from '../services/ModelPricingService';
import { calculateLineChanges } from '../utils/lineChangeCalculator';
import { BurnRateCalculator } from '../services/BurnRateCalculator';
import { SessionSummaryService } from '../services/SessionSummaryService';
import { extractDecisions } from '../services/DecisionExtractor';
import { log, logError } from '../services/Logger';
import { getNonce } from '../utils/nonce';

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

  /** Last observed model ID (for dynamic context window limit) */
  private _lastModelId: string | undefined;

  /** Tool analytics by name */
  private _toolAnalytics: Map<string, ToolAnalytics> = new Map();

  /** Timeline events (most recent first) */
  private _timeline: TimelineEvent[] = [];

  /** Maximum timeline events to display */
  private readonly MAX_DISPLAY_TIMELINE = 20;

  /** QuotaService for subscription quota data */
  private readonly _quotaService?: QuotaService;

  /** HistoricalDataService for long-term analytics */
  private _historicalDataService?: HistoricalDataService;

  /** Current historical data range being displayed */
  private _currentHistoricalRange: 'today' | 'week' | 'month' | 'all' = 'week';

  /** Current drill-down level for historical data */
  private _drillDownStack: Array<{ range: string; timestamp: string }> = [];

  /** GuidanceAdvisor for generating instruction file suggestions */
  private _guidanceAdvisor?: GuidanceAdvisor;

  /** SessionAnalyzer for analysis data */
  private _sessionAnalyzer?: SessionAnalyzer;

  /** AuthService for AI narrative generation */
  private _authService?: AuthService;

  /** SessionSummaryService for aggregation */
  private _summaryService = new SessionSummaryService();

  /** Cached session summary for the Summary tab */
  private _cachedSummary: SessionSummaryData | null = null;

  /** Debounce timer for richer panel updates */
  private _richerPanelTimer?: ReturnType<typeof setTimeout>;

  /** Suppresses session list updates during provider switches */
  private _suppressSessionListUpdates = false;

  /** Event logger reference for toggling from the dashboard */
  private _eventLogger?: SessionEventLogger;

  /** Decision log service for cross-session decision persistence */
  private _decisionLogService?: DecisionLogService;

  /** Handoff service for session context handoff */
  private _handoffService?: HandoffService;

  /**
   * Sets the event logger instance used for dashboard toggle control.
   */
  setEventLogger(logger: SessionEventLogger): void {
    this._eventLogger = logger;
  }

  /**
   * Sets the handoff service instance for session context handoff generation.
   */
  setHandoffService(service: HandoffService): void {
    this._handoffService = service;
  }

  /**
   * Creates a new DashboardViewProvider.
   *
   * @param _extensionUri - URI of the extension directory
   * @param _sessionMonitor - SessionMonitor instance for token events
   * @param quotaService - Optional QuotaService for subscription quota
   * @param historicalDataService - Optional HistoricalDataService for long-term analytics
   * @param guidanceAdvisor - Optional GuidanceAdvisor for generating suggestions
   * @param sessionAnalyzer - Optional SessionAnalyzer for richer panel data
   * @param authService - Optional AuthService for AI narrative generation
   * @param decisionLogService - Optional DecisionLogService for cross-session decisions
   */
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionMonitor: SessionMonitor,
    quotaService?: QuotaService,
    historicalDataService?: HistoricalDataService,
    guidanceAdvisor?: GuidanceAdvisor,
    sessionAnalyzer?: SessionAnalyzer,
    authService?: AuthService,
    decisionLogService?: DecisionLogService
  ) {
    this._quotaService = quotaService;
    this._historicalDataService = historicalDataService;
    this._guidanceAdvisor = guidanceAdvisor;
    this._sessionAnalyzer = sessionAnalyzer;
    this._authService = authService;
    this._decisionLogService = decisionLogService;
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

    this._disposables.push(
      this._sessionMonitor.onLatencyUpdate(stats => this._handleLatencyUpdate(stats))
    );

    this._disposables.push(
      this._sessionMonitor.onCompaction(event => this._handleCompaction(event))
    );

    // Subscribe to quota updates if service available
    if (this._quotaService) {
      this._disposables.push(
        this._quotaService.onQuotaUpdate(quota => this._handleQuotaUpdate(quota))
      );
    }

    // Subscribe to session-based quota updates (e.g., Codex rate_limits)
    this._disposables.push(
      this._sessionMonitor.onQuotaUpdate(quota => this._handleQuotaUpdate(quota))
    );

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
      (message: DashboardWebviewMessage) => this._handleDashboardWebviewMessage(message),
      undefined,
      this._disposables
    );

    // Resend state when view becomes visible, manage quota refresh
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._sendStateToWebview();
          this._sendSessionList();
          this._sendProviderInfo();
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
  private _handleDashboardWebviewMessage(message: DashboardWebviewMessage): void {
    log(`Dashboard: received message from webview: ${message.type}`);
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
        this._sendProviderInfo();
        this._sendEventLogState();
        // Send session-based quota if available (e.g., Codex rate_limits)
        {
          const sessionQuota = this._sessionMonitor.getProvider().getQuotaFromSession?.();
          if (sessionQuota) {
            this._handleQuotaUpdate(sessionQuota);
          }
        }
        break;

      case 'requestStats':
        this._syncFromSessionMonitor();
        this._sendStateToWebview();
        break;

      case 'selectSession':
        log(`Dashboard: user selected session: ${message.sessionPath}`);
        this._sessionMonitor.switchToSession(message.sessionPath);
        break;

      case 'setSessionProvider':
        log(`Dashboard: user selected session provider: ${message.providerId}`);
        this._suppressSessionListUpdates = true;
        vscode.commands.executeCommand('sidekick.setSessionProvider', message.providerId);
        break;

      case 'refreshSessions':
        this._sendSessionList();
        break;

      case 'togglePin':
        this._sessionMonitor.togglePin();
        this._sendSessionList();
        break;

      case 'browseSessionFolders':
        log('Dashboard: user requested to browse session folders');
        vscode.commands.executeCommand('sidekick.selectSessionFolder');
        break;

      case 'clearCustomPath':
        log('Dashboard: user requested to clear custom path');
        vscode.commands.executeCommand('sidekick.clearCustomSessionPath');
        break;

      case 'importHistoricalData':
        log('Dashboard: user requested to import historical data');
        vscode.commands.executeCommand('sidekick.importHistoricalData');
        break;

      case 'requestHistoricalData':
        this._currentHistoricalRange = message.range;
        this._drillDownStack = [];
        this._sendHistoricalData(message.range);
        break;

      case 'drillDown':
        this._drillDownStack.push({
          range: message.currentRange,
          timestamp: message.timestamp,
        });
        this._sendDrillDownData(message.timestamp, message.currentRange);
        break;

      case 'drillUp':
        if (this._drillDownStack.length > 0) {
          this._drillDownStack.pop();
          if (this._drillDownStack.length === 0) {
            this._sendHistoricalData(this._currentHistoricalRange);
          } else {
            const prev = this._drillDownStack[this._drillDownStack.length - 1];
            this._sendDrillDownData(prev.timestamp, prev.range);
          }
        }
        break;

      case 'analyzeSession':
        this._handleAnalyzeSession().catch(err => {
          logError('Dashboard: Unhandled error in _handleAnalyzeSession', err);
        });
        break;

      case 'copySuggestion':
        this._handleCopySuggestion(message.text);
        break;

      case 'openClaudeMd':
      case 'openInstructionFile':
        this._handleOpenInstructionFile();
        break;

      case 'generateNarrative':
        this._handleGenerateNarrative().catch(err => {
          logError('Dashboard: Unhandled error in _handleGenerateNarrative', err);
        });
        break;

      case 'requestSessionSummary':
        this._handleRequestSessionSummary();
        break;

      case 'searchTimeline':
        this._handleSearchTimeline(message.query);
        break;

      case 'setTimelineFilter':
        // Filters are applied client-side in the webview, but we track state
        log(`Dashboard: timeline filter updated: ${JSON.stringify(message.filters)}`);
        break;

      case 'requestToolCallDetails':
        this._handleToolCallDetails(message.toolName);
        break;

      case 'toggleEventLog': {
        const enabled = message.enabled;
        log(`Dashboard: event log toggled: ${enabled}`);
        vscode.workspace.getConfiguration('sidekick').update('enableEventLog', enabled, vscode.ConfigurationTarget.Global);
        if (this._eventLogger) {
          this._sessionMonitor.setEventLogger(enabled ? this._eventLogger : null);
        }
        break;
      }

      case 'requestDecisions':
        this._sendDecisionsToWebview();
        break;

      case 'searchDecisions':
        this._sendDecisionsToWebview(message.query);
        break;

      case 'generateHandoff':
        this._handleGenerateHandoff().catch(err => {
          logError('Dashboard: Unhandled error in _handleGenerateHandoff', err);
        });
        break;

      case 'clearDecisions':
        if (this._decisionLogService) {
          this._decisionLogService.clearAll();
          this._sendDecisionsToWebview();
        }
        break;
    }
  }

  /**
   * Handles timeline search from the webview.
   *
   * When a search query is provided, sends ALL timeline events
   * (not capped at MAX_DISPLAY_TIMELINE) so the webview can filter them.
   * When query is empty, reverts to the standard capped view.
   *
   * @param query - Search query string, empty to clear search
   */
  private _handleSearchTimeline(query: string): void {
    if (query.trim().length === 0) {
      // Clear search: revert to standard capped timeline
      this._updateTimelineState();
      this._sendTimelineToWebview();
      return;
    }

    // When searching, send ALL timeline events from SessionMonitor
    const stats = this._sessionMonitor.getStats();
    const allTimeline = stats.timeline;

    // Convert all events to display format (no cap)
    const allEvents = allTimeline.map(e => ({
      type: e.type as 'user_prompt' | 'tool_call' | 'tool_result' | 'error' | 'assistant_response' | 'compaction',
      time: new Date(e.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      description: e.description,
      isError: e.metadata?.isError,
      fullText: e.metadata?.fullText,
      noiseLevel: e.noiseLevel,
      isSidechain: e.isSidechain,
      contextBefore: e.metadata?.contextBefore,
      contextAfter: e.metadata?.contextAfter,
      tokensReclaimed: e.metadata?.tokensReclaimed
    }));

    this._postMessage({
      type: 'updateTimeline',
      events: allEvents
    });
  }

  /**
   * Handles tool call drill-down request.
   * Sends individual tool calls for a specific tool name.
   *
   * @param toolName - Name of the tool to get details for
   */
  private _handleToolCallDetails(toolName: string): void {
    const stats = this._sessionMonitor.getStats();
    const calls = stats.toolCalls
      .filter(tc => tc.name === toolName)
      .map(tc => {
        const durationMs = tc.duration ?? 0;
        let durationStr: string;
        if (durationMs < 1000) {
          durationStr = durationMs + 'ms';
        } else {
          durationStr = (durationMs / 1000).toFixed(1) + 's';
        }

        // Build description from tool input
        let desc = toolName;
        if (tc.input?.file_path) {
          desc = String(tc.input.file_path).split('/').pop() || desc;
        } else if (tc.input?.command) {
          const cmd = String(tc.input.command);
          desc = cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
        } else if (tc.input?.pattern) {
          desc = String(tc.input.pattern);
        }

        return {
          time: tc.timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          description: desc,
          duration: durationStr,
          isError: tc.isError ?? false,
          errorMessage: tc.errorMessage
        } as ToolCallDetailDisplay;
      })
      .reverse(); // Most recent first

    this._postMessage({
      type: 'toolCallDetails',
      toolName,
      calls
    });
  }

  /**
   * Handles the analyze session request from webview.
   * Calls GuidanceAdvisor and sends results to webview.
   * Shows a progress notification with provider/model info.
   *
   * @param timeoutOverride - Optional timeout override in ms (for retry after timeout)
   */
  private async _handleAnalyzeSession(timeoutOverride?: number): Promise<void> {
    log('Dashboard: _handleAnalyzeSession called');
    if (!this._guidanceAdvisor) {
      log('Dashboard: _guidanceAdvisor is not available');
      this._postMessage({
        type: 'suggestionsError',
        error: 'Agent guidance analysis is not available. Please check extension configuration.'
      });
      return;
    }

    const target = resolveInstructionTarget(this._sessionMonitor.getProvider().id);

    log('Dashboard: Starting session analysis');
    log(`Dashboard: _view exists: ${!!this._view}`);
    this._postMessage({ type: 'suggestionsLoading', loading: true });

    try {
      const inferenceProvider = this._authService?.getProviderDisplayName() ?? 'AI';
      const model = this._authService
        ? resolveModel('balanced', this._authService.getProviderId(), 'explanationModel')
        : 'unknown';

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Analyzing session for ${target.primaryFile} suggestions`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: `Using ${inferenceProvider} (${model})... This may take 30-60 seconds.` });

          const result = await this._guidanceAdvisor!.analyze(
            timeoutOverride ? { timeout: timeoutOverride } : undefined
          );

          if (result.success) {
            const suggestions: ClaudeMdSuggestionDisplay[] = result.suggestions.map(s => ({
              title: s.title,
              observed: s.observed,
              suggestion: s.suggestion,
              reasoning: s.reasoning
            }));
            this._postMessage({ type: 'showSuggestions', suggestions });
            log(`Dashboard: Analysis complete, ${suggestions.length} suggestions`);
          } else {
            this._postMessage({
              type: 'suggestionsError',
              error: result.error || 'Analysis failed'
            });
            logError(`Dashboard: Analysis failed: ${result.error}`);
          }
        }
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        const retry = await vscode.window.showWarningMessage(
          `Analysis timed out after ${error.timeoutMs / 1000}s. Try again with a longer timeout?`,
          'Retry (3 min)', 'Retry (5 min)', 'Cancel'
        );
        if (retry?.startsWith('Retry')) {
          const newTimeout = retry.includes('3') ? 180000 : 300000;
          return this._handleAnalyzeSession(newTimeout);
        }
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this._postMessage({
        type: 'suggestionsError',
        error: `Analysis failed: ${message}`
      });
      logError('Dashboard: Analysis error', error);
    } finally {
      this._postMessage({ type: 'suggestionsLoading', loading: false });
    }
  }

  /**
   * Handles copying suggestion text to clipboard.
   */
  private async _handleCopySuggestion(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Suggestion copied to clipboard');
  }

  /**
   * Handles opening the project's instruction file (CLAUDE.md or AGENTS.md).
   * If the file doesn't exist, offers to create it.
   */
  private async _handleOpenInstructionFile(): Promise<void> {
    const target = resolveInstructionTarget(this._sessionMonitor.getProvider().id);
    const existingPath = await this._findProjectInstructionFile(target.primaryFile);
    if (existingPath) {
      const doc = await vscode.workspace.openTextDocument(existingPath);
      await vscode.window.showTextDocument(doc);
    } else {
      const action = await vscode.window.showInformationMessage(
        target.notFoundMessage,
        `Create ${target.primaryFile}`
      );
      if (action) {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (wsFolder) {
          const newPath = path.join(wsFolder.uri.fsPath, target.primaryFile);
          await fs.promises.writeFile(newPath, `# ${target.primaryFile}\n\n`, 'utf-8');
          const doc = await vscode.workspace.openTextDocument(newPath);
          await vscode.window.showTextDocument(doc);
        }
      }
    }
  }

  /**
   * Handles generating a session context handoff document.
   * After generation, offers to add the pointer to the instruction file.
   */
  private async _handleGenerateHandoff(): Promise<void> {
    if (!this._handoffService || !this._sessionAnalyzer) {
      vscode.window.showWarningMessage('Handoff service is not available. Ensure a workspace is open.');
      return;
    }

    const stats = this._sessionMonitor.getStats();
    const analysisData = this._sessionAnalyzer.getCachedData();
    const summaryData = this._summaryService.generateSummary(stats, analysisData, this._getContextWindowLimit());

    try {
      const handoffPath = await this._handoffService.generateHandoff(summaryData, analysisData, stats);

      // Check if instruction file already has the pointer
      const target = resolveInstructionTarget(this._sessionMonitor.getProvider().id);
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      const instructionFilePath = wsFolder
        ? path.join(wsFolder.uri.fsPath, target.primaryFile)
        : null;

      let hasPointer = false;
      if (instructionFilePath) {
        try {
          const content = await fs.promises.readFile(instructionFilePath, 'utf-8');
          hasPointer = content.includes('sidekick/handoffs/');
        } catch {
          // File doesn't exist yet — no pointer
        }
      }

      if (hasPointer) {
        // Pointer already set up — just confirm
        const action = await vscode.window.showInformationMessage(
          `Handoff generated.`,
          'Open Handoff'
        );
        if (action === 'Open Handoff') {
          const doc = await vscode.workspace.openTextDocument(handoffPath);
          await vscode.window.showTextDocument(doc);
        }
      } else {
        // Offer to add pointer to instruction file
        const action = await vscode.window.showInformationMessage(
          `Handoff generated. Add a pointer to ${target.primaryFile} so your agent knows where to find it?`,
          `Add to ${target.primaryFile}`,
          'Open Handoff',
          'Skip'
        );
        if (action === `Add to ${target.primaryFile}` && wsFolder) {
          const slug = encodeWorkspacePath(wsFolder.uri.fsPath);
          const oneLiner = `\nIf resuming prior work or need context on previous sessions, read ~/.config/sidekick/handoffs/${slug}-latest.md\n`;

          let existingContent = '';
          try {
            existingContent = await fs.promises.readFile(instructionFilePath!, 'utf-8');
          } catch {
            // File doesn't exist — will create
          }

          await fs.promises.writeFile(instructionFilePath!, existingContent + oneLiner, 'utf-8');
          vscode.window.showInformationMessage(`Pointer added to ${target.primaryFile}.`);
        } else if (action === 'Open Handoff') {
          const doc = await vscode.workspace.openTextDocument(handoffPath);
          await vscode.window.showTextDocument(doc);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Handoff generation failed: ${message}`);
      logError('Dashboard: Handoff generation error', error);
    }
  }

  /**
   * Finds an instruction file for the current workspace.
   *
   * @param filename - The instruction file to look for
   * @returns Path to the file if found, undefined otherwise
   */
  private async _findProjectInstructionFile(filename: string): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }

    for (const folder of workspaceFolders) {
      const filePath = path.join(folder.uri.fsPath, filename);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }

    return undefined;
  }

  /**
   * Handles the generate narrative request from webview.
   *
   * @param timeoutOverride - Optional timeout override in ms (for retry after timeout)
   */
  private async _handleGenerateNarrative(timeoutOverride?: number): Promise<void> {
    if (!this._authService || !this._cachedSummary) {
      this._postMessage({ type: 'narrativeError', error: 'Summary data or auth not available.' });
      return;
    }

    this._postMessage({ type: 'narrativeLoading', loading: true });

    try {
      const inferenceProvider = this._authService.getProviderDisplayName();
      const model = resolveModel('balanced', this._authService.getProviderId(), 'explanationModel');

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating session narrative',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: `Using ${inferenceProvider} (${model})... This may take 15-30 seconds.` });
          const narrative = await this._summaryService.generateNarrative(
            this._cachedSummary!,
            this._authService!,
            timeoutOverride ? { timeout: timeoutOverride } : undefined
          );
          this._postMessage({ type: 'sessionNarrative', narrative });
        }
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        const retry = await vscode.window.showWarningMessage(
          `Narrative generation timed out after ${error.timeoutMs / 1000}s. Try again with a longer timeout?`,
          'Retry (3 min)', 'Retry (5 min)', 'Cancel'
        );
        if (retry?.startsWith('Retry')) {
          const newTimeout = retry.includes('3') ? 180000 : 300000;
          return this._handleGenerateNarrative(newTimeout);
        }
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this._postMessage({ type: 'narrativeError', error: `Narrative generation failed: ${message}` });
      logError('Dashboard: Narrative generation error', error);
    } finally {
      this._postMessage({ type: 'narrativeLoading', loading: false });
    }
  }

  /**
   * Handles session summary request from webview.
   */
  private _handleRequestSessionSummary(): void {
    if (this._cachedSummary) {
      this._postMessage({ type: 'updateSessionSummary', summary: this._cachedSummary });
      return;
    }
    // Build fresh summary if possible
    this._buildAndSendSummary();
  }

  /**
   * Builds full session summary and sends to webview.
   */
  private _buildAndSendSummary(): void {
    if (!this._sessionAnalyzer) return;

    const stats = this._sessionMonitor.getStats();
    const analysisData = this._sessionAnalyzer.getCachedData();
    this._cachedSummary = this._summaryService.generateSummary(stats, analysisData, this._getContextWindowLimit());
    this._postMessage({ type: 'updateSessionSummary', summary: this._cachedSummary });
  }

  /**
   * Sends richer panel updates (debounced 2s).
   * Called from _syncFromSessionMonitor and event handlers.
   */
  private _sendRicherPanelUpdates(): void {
    if (this._richerPanelTimer) {
      clearTimeout(this._richerPanelTimer);
    }

    this._richerPanelTimer = setTimeout(() => {
      const stats = this._sessionMonitor.getStats();

      // Task Performance
      const taskPerf = this._summaryService.getTaskPerformance(stats.taskState);
      this._postMessage({ type: 'updateTaskPerformance', data: taskPerf });

      // Cache Effectiveness
      const cacheData = this._summaryService.getCacheEffectiveness(stats);
      this._postMessage({ type: 'updateCacheEffectiveness', data: cacheData });

      // Recovery Patterns (needs analyzer)
      if (this._sessionAnalyzer) {
        const analysisData = this._sessionAnalyzer.getCachedData();
        const recoveryData = this._summaryService.getRecoveryPatterns(analysisData);
        this._postMessage({ type: 'updateRecoveryPatterns', data: recoveryData });
      }

      // Advanced Burn Rate
      const quotaState = this._quotaService?.getCachedQuota() ?? undefined;
      const burnData = this._summaryService.getAdvancedBurnRate(
        stats,
        this._burnRateCalculator,
        quotaState
      );
      this._postMessage({ type: 'updateAdvancedBurnRate', data: burnData });

      // Tool Efficiency
      const toolEfficiency = this._summaryService.getToolEfficiency(stats);
      this._postMessage({ type: 'updateToolEfficiency', data: toolEfficiency });

      // Context Attribution
      if (this._state.contextAttribution && this._state.contextAttribution.length > 0) {
        this._postMessage({ type: 'updateContextAttribution', attribution: this._state.contextAttribution });
      }

      // Decision extraction
      this._extractAndPersistDecisions();
    }, 2000);
  }

  /**
   * Extracts decisions from session data and persists them.
   */
  private _extractAndPersistDecisions(): void {
    if (!this._decisionLogService) return;

    try {
      const analysisData = this._sessionAnalyzer?.getCachedData() ?? null;
      const stats = this._sessionMonitor.getStats();
      const assistantTexts = this._sessionMonitor.getAssistantTexts();
      const sessionId = this._sessionMonitor.getSessionPath() ?? 'unknown';

      const decisions = extractDecisions(analysisData, stats.toolCalls, assistantTexts, sessionId);

      if (decisions.length > 0) {
        this._decisionLogService.addEntries(decisions);
        this._decisionLogService.setLastSessionId(sessionId);
      }

      this._sendDecisionsToWebview();
    } catch (error) {
      logError('Failed to extract/persist decisions', error);
    }
  }

  /**
   * Sends decision entries to the webview, optionally filtered by query.
   */
  private _sendDecisionsToWebview(query?: string): void {
    if (!this._decisionLogService) return;

    const entries = this._decisionLogService.getEntries(query);
    const totalCount = this._decisionLogService.getEntryCount();
    this._postMessage({ type: 'updateDecisions', decisions: entries, totalCount });
  }

  /**
   * Sends historical data for a given time range.
   */
  private _sendHistoricalData(range: 'today' | 'week' | 'month' | 'all'): void {
    if (!this._historicalDataService) {
      return;
    }

    this._postMessage({ type: 'historicalDataLoading', loading: true });

    try {
      const summary = this._buildHistoricalSummary(range);
      this._postMessage({ type: 'updateHistoricalData', data: summary });
    } finally {
      this._postMessage({ type: 'historicalDataLoading', loading: false });
    }
  }

  /**
   * Builds historical summary for a given range.
   */
  private _buildHistoricalSummary(range: 'today' | 'week' | 'month' | 'all'): HistoricalSummary {
    const dataPoints: HistoricalDataPoint[] = [];
    let granularity: 'hourly' | 'daily' | 'monthly' = 'daily';

    if (!this._historicalDataService) {
      return {
        range,
        granularity,
        dataPoints: [],
        totals: { inputTokens: 0, outputTokens: 0, totalCost: 0, messageCount: 0, sessionCount: 0 },
      };
    }

    const today = new Date();

    switch (range) {
      case 'today': {
        granularity = 'hourly';
        // For today, we need hourly data which requires session-level tracking
        // For now, show the daily total since we don't track hourly
        const todayData = this._historicalDataService.getTodayData();
        if (todayData) {
          dataPoints.push({
            timestamp: todayData.date,
            label: 'Today',
            inputTokens: todayData.tokens.inputTokens,
            outputTokens: todayData.tokens.outputTokens,
            cacheWriteTokens: todayData.tokens.cacheWriteTokens,
            cacheReadTokens: todayData.tokens.cacheReadTokens,
            totalCost: todayData.totalCost,
            messageCount: todayData.messageCount,
            sessionCount: todayData.sessionCount,
          });
        }
        break;
      }

      case 'week': {
        granularity = 'daily';
        const weekData = this._historicalDataService.getThisWeekData();
        for (const day of weekData) {
          const date = new Date(day.date);
          dataPoints.push({
            timestamp: day.date,
            label: date.toLocaleDateString('en-US', { weekday: 'short' }),
            inputTokens: day.tokens.inputTokens,
            outputTokens: day.tokens.outputTokens,
            cacheWriteTokens: day.tokens.cacheWriteTokens,
            cacheReadTokens: day.tokens.cacheReadTokens,
            totalCost: day.totalCost,
            messageCount: day.messageCount,
            sessionCount: day.sessionCount,
          });
        }
        break;
      }

      case 'month': {
        granularity = 'daily';
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
        const startDate = monthStart.toISOString().split('T')[0];
        const endDate = today.toISOString().split('T')[0];
        const monthDays = this._historicalDataService.getDailyData(startDate, endDate);
        for (const day of monthDays) {
          const date = new Date(day.date);
          dataPoints.push({
            timestamp: day.date,
            label: date.getDate().toString(),
            inputTokens: day.tokens.inputTokens,
            outputTokens: day.tokens.outputTokens,
            cacheWriteTokens: day.tokens.cacheWriteTokens,
            cacheReadTokens: day.tokens.cacheReadTokens,
            totalCost: day.totalCost,
            messageCount: day.messageCount,
            sessionCount: day.sessionCount,
          });
        }
        break;
      }

      case 'all': {
        granularity = 'monthly';
        const allTime = this._historicalDataService.getAllTimeStats();
        if (allTime.firstDate && allTime.lastDate) {
          const startMonth = allTime.firstDate.substring(0, 7);
          const endMonth = allTime.lastDate.substring(0, 7);
          const months = this._historicalDataService.getMonthlyData(startMonth, endMonth);
          for (const month of months) {
            const [year, mon] = month.month.split('-');
            const monthName = new Date(parseInt(year), parseInt(mon) - 1, 1)
              .toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
            dataPoints.push({
              timestamp: month.month,
              label: monthName,
              inputTokens: month.tokens.inputTokens,
              outputTokens: month.tokens.outputTokens,
              cacheWriteTokens: month.tokens.cacheWriteTokens,
              cacheReadTokens: month.tokens.cacheReadTokens,
              totalCost: month.totalCost,
              messageCount: month.messageCount,
              sessionCount: month.sessionCount,
            });
          }
        }
        break;
      }
    }

    // Calculate totals
    const totals = {
      inputTokens: dataPoints.reduce((sum, d) => sum + d.inputTokens, 0),
      outputTokens: dataPoints.reduce((sum, d) => sum + d.outputTokens, 0),
      totalCost: dataPoints.reduce((sum, d) => sum + d.totalCost, 0),
      messageCount: dataPoints.reduce((sum, d) => sum + d.messageCount, 0),
      sessionCount: dataPoints.reduce((sum, d) => sum + d.sessionCount, 0),
    };

    return { range, granularity, dataPoints, totals };
  }

  /**
   * Sends drill-down data for a specific timestamp.
   */
  private _sendDrillDownData(timestamp: string, currentRange: string): void {
    if (!this._historicalDataService) {
      return;
    }

    this._postMessage({ type: 'historicalDataLoading', loading: true });

    try {
      let summary: HistoricalSummary;

      if (currentRange === 'all') {
        // Drilling down from all-time (monthly) to daily for that month
        const monthStart = timestamp + '-01';
        const [year, month] = timestamp.split('-');
        const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
        const monthEnd = `${timestamp}-${lastDay.toString().padStart(2, '0')}`;

        const days = this._historicalDataService.getDailyData(monthStart, monthEnd);
        const dataPoints: HistoricalDataPoint[] = days.map(day => {
          const date = new Date(day.date);
          return {
            timestamp: day.date,
            label: date.getDate().toString(),
            inputTokens: day.tokens.inputTokens,
            outputTokens: day.tokens.outputTokens,
            cacheWriteTokens: day.tokens.cacheWriteTokens,
            cacheReadTokens: day.tokens.cacheReadTokens,
            totalCost: day.totalCost,
            messageCount: day.messageCount,
            sessionCount: day.sessionCount,
          };
        });

        const totals = {
          inputTokens: dataPoints.reduce((sum, d) => sum + d.inputTokens, 0),
          outputTokens: dataPoints.reduce((sum, d) => sum + d.outputTokens, 0),
          totalCost: dataPoints.reduce((sum, d) => sum + d.totalCost, 0),
          messageCount: dataPoints.reduce((sum, d) => sum + d.messageCount, 0),
          sessionCount: dataPoints.reduce((sum, d) => sum + d.sessionCount, 0),
        };

        summary = {
          range: 'month',
          granularity: 'daily',
          dataPoints,
          totals,
        };
      } else {
        // Drilling down from daily to hourly - not supported yet
        // Just return the day's data as a single point
        const days = this._historicalDataService.getDailyData(timestamp, timestamp);
        const dataPoints: HistoricalDataPoint[] = days.map(day => ({
          timestamp: day.date,
          label: 'Today',
          inputTokens: day.tokens.inputTokens,
          outputTokens: day.tokens.outputTokens,
          cacheWriteTokens: day.tokens.cacheWriteTokens,
          cacheReadTokens: day.tokens.cacheReadTokens,
          totalCost: day.totalCost,
          messageCount: day.messageCount,
          sessionCount: day.sessionCount,
        }));

        const totals = dataPoints.length > 0 ? {
          inputTokens: dataPoints[0].inputTokens,
          outputTokens: dataPoints[0].outputTokens,
          totalCost: dataPoints[0].totalCost,
          messageCount: dataPoints[0].messageCount,
          sessionCount: dataPoints[0].sessionCount,
        } : { inputTokens: 0, outputTokens: 0, totalCost: 0, messageCount: 0, sessionCount: 0 };

        summary = {
          range: 'today',
          granularity: 'hourly',
          dataPoints,
          totals,
        };
      }

      this._postMessage({ type: 'updateHistoricalData', data: summary });
    } finally {
      this._postMessage({ type: 'historicalDataLoading', loading: false });
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
    // Track model for dynamic context window limit
    this._lastModelId = usage.model;

    // Use provider-reported cost when available, else calculate from pricing.
    // For non-Claude models (GPT, Gemini, etc.) without reported cost, use 0
    // rather than applying incorrect Claude pricing.
    let cost: number;
    if (usage.reportedCost !== undefined && usage.reportedCost > 0) {
      cost = usage.reportedCost;
    } else if (ModelPricingService.parseModelId(usage.model)) {
      const pricing = ModelPricingService.getPricing(usage.model);
      cost = ModelPricingService.calculateCost({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheReadTokens: usage.cacheReadTokens
      }, pricing);
    } else {
      cost = 0;
    }

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

    // Update current context size (provider-specific formula).
    // OpenCode emits some assistant step rows with zero token signal; those
    // should not zero out the gauge between real updates.
    const provider = this._sessionMonitor.getProvider();
    const hasContextSignal = usage.inputTokens > 0
      || usage.outputTokens > 0
      || usage.cacheWriteTokens > 0
      || usage.cacheReadTokens > 0
      || (usage.reasoningTokens ?? 0) > 0;

    if (hasContextSignal) {
      this._currentContextSize = provider.computeContextSize
        ? provider.computeContextSize(usage)
        : usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
    }

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
      type: e.type as 'user_prompt' | 'tool_call' | 'tool_result' | 'error' | 'assistant_response' | 'compaction',
      time: new Date(e.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      description: e.description,
      isError: e.metadata?.isError,
      fullText: e.metadata?.fullText,
      noiseLevel: e.noiseLevel,
      isSidechain: e.isSidechain,
      contextBefore: e.metadata?.contextBefore,
      contextAfter: e.metadata?.contextAfter,
      tokensReclaimed: e.metadata?.tokensReclaimed
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

    // Final decision extraction pass before session closes
    this._extractAndPersistDecisions();

    // Build and cache full session summary on session end
    this._buildAndSendSummary();
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
   * Handles latency updates from SessionMonitor.
   * @param stats - Updated latency statistics
   */
  private _handleLatencyUpdate(stats: LatencyStats): void {
    const display = this._formatLatencyDisplay(stats);
    this._state.latencyDisplay = display;
    this._postMessage({ type: 'updateLatency', latency: display });
  }

  /**
   * Handles compaction events from SessionMonitor.
   * Updates the compaction display list in the dashboard state.
   */
  private _handleCompaction(event: { contextBefore: number; contextAfter: number; tokensReclaimed: number; timestamp: Date }): void {
    const display: CompactionEventDisplay = {
      time: event.timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      contextBefore: event.contextBefore,
      contextAfter: event.contextAfter,
      tokensReclaimed: event.tokensReclaimed,
      reclaimedPercent: event.contextBefore > 0
        ? Math.round((event.tokensReclaimed / event.contextBefore) * 100)
        : 0
    };

    if (!this._state.compactions) {
      this._state.compactions = [];
    }
    this._state.compactions.push(display);

    this._postMessage({
      type: 'updateCompactions',
      compactions: this._state.compactions
    });
  }

  /**
   * Formats latency statistics for display in the dashboard.
   * @param stats - Raw latency statistics
   * @returns Formatted display values
   */
  private _formatLatencyDisplay(stats: LatencyStats): LatencyDisplay {
    if (stats.completedCycles === 0) {
      return {
        avgFirstToken: '-',
        maxFirstToken: '-',
        lastFirstToken: '-',
        avgTotal: '-',
        cycleCount: 0,
        hasData: false
      };
    }

    return {
      avgFirstToken: this._formatDuration(stats.avgFirstTokenLatencyMs),
      maxFirstToken: this._formatDuration(stats.maxFirstTokenLatencyMs),
      lastFirstToken: stats.lastFirstTokenLatencyMs !== null
        ? this._formatDuration(stats.lastFirstTokenLatencyMs)
        : '-',
      avgTotal: this._formatDuration(stats.avgTotalResponseTimeMs),
      cycleCount: stats.completedCycles,
      hasData: true
    };
  }

  /**
   * Formats a duration in milliseconds for display.
   * < 1s -> "0.Xs"
   * 1-60s -> "Xs"
   * > 60s -> "Xm Ys"
   *
   * @param ms - Duration in milliseconds
   * @returns Formatted duration string
   */
  private _formatDuration(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 1) {
      return `${seconds.toFixed(1)}s`;
    } else if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.round(seconds % 60);
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
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

    if (stats.lastModelId) {
      this._lastModelId = stats.lastModelId;
    }

    // Sync context size from session BEFORE calculating usage percentage
    this._currentContextSize = stats.currentContextSize;

    // Rebuild model breakdown with costs
    this._state.modelBreakdown = [];
    this._state.totalCost = 0;

    if (stats.totalReportedCost !== undefined && stats.totalReportedCost > 0) {
      // Use provider-reported cost, distribute proportionally by token count
      const totalTokens = Array.from(stats.modelUsage.values())
        .reduce((sum, u) => sum + u.tokens, 0);

      stats.modelUsage.forEach((usage, model) => {
        const proportion = totalTokens > 0 ? usage.tokens / totalTokens : 0;
        const cost = stats.totalReportedCost! * proportion;

        this._state.modelBreakdown.push({
          model,
          calls: usage.calls,
          tokens: usage.tokens,
          cost
        });

        this._state.totalCost += cost;
      });
    } else {
      stats.modelUsage.forEach((usage, model) => {
        // Only calculate from pricing table for known Claude models.
        // Non-Claude models (GPT, Gemini, etc.) get cost 0 to avoid
        // applying incorrect Claude pricing.
        let cost: number;
        if (ModelPricingService.parseModelId(model)) {
          const pricing = ModelPricingService.getPricing(model);
          cost = ModelPricingService.calculateCost({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            cacheReadTokens: usage.cacheReadTokens,
          }, pricing);
        } else {
          cost = 0;
        }

        this._state.modelBreakdown.push({
          model,
          calls: usage.calls,
          tokens: usage.tokens,
          cost
        });

        this._state.totalCost += cost;
      });
    }

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

    // Compute file change summary
    this._state.fileChangeSummary = this._computeFileChangeSummary(stats.toolCalls);

    // Sync latency stats
    if (stats.latencyStats) {
      this._state.latencyDisplay = this._formatLatencyDisplay(stats.latencyStats);
    }

    // Sync compaction events
    if (stats.compactionEvents && stats.compactionEvents.length > 0) {
      this._state.compactions = stats.compactionEvents.map(e => ({
        time: e.timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        contextBefore: e.contextBefore,
        contextAfter: e.contextAfter,
        tokensReclaimed: e.tokensReclaimed,
        reclaimedPercent: e.contextBefore > 0
          ? Math.round((e.tokensReclaimed / e.contextBefore) * 100)
          : 0
      }));
    }

    // Sync context attribution
    if (stats.contextAttribution) {
      const attr = stats.contextAttribution;
      const total = attr.systemPrompt + attr.userMessages + attr.assistantResponses +
        attr.toolInputs + attr.toolOutputs + attr.thinking + attr.other;

      if (total > 0) {
        const COLORS = {
          systemPrompt: '#e06c75',
          userMessages: '#61afef',
          assistantResponses: '#98c379',
          toolInputs: '#c678dd',
          toolOutputs: '#d19a66',
          thinking: '#56b6c2',
          other: '#abb2bf'
        };
        const LABELS: Record<string, string> = {
          systemPrompt: 'System Prompt',
          userMessages: 'User Messages',
          assistantResponses: 'Assistant',
          toolInputs: 'Tool Inputs',
          toolOutputs: 'Tool Outputs',
          thinking: 'Thinking',
          other: 'Other'
        };

        this._state.contextAttribution = Object.entries(attr)
          .filter(([, tokens]) => tokens > 0)
          .map(([category, tokens]) => ({
            category: LABELS[category] || category,
            tokens,
            percent: Math.round((tokens / total) * 100),
            color: COLORS[category as keyof typeof COLORS] || '#abb2bf'
          }))
          .sort((a, b) => b.tokens - a.tokens);
      }
    }

    // Send richer panel updates (debounced)
    this._sendRicherPanelUpdates();
  }

  /**
   * Computes file change summary from tool calls.
   *
   * Aggregates additions and deletions across all Write, Edit, and MultiEdit
   * tool calls, counting unique files modified.
   */
  private _computeFileChangeSummary(toolCalls: ToolCall[]): {
    totalFilesChanged: number;
    totalAdditions: number;
    totalDeletions: number;
  } {
    const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit'];
    const filesModified = new Set<string>();
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const call of toolCalls) {
      if (FILE_TOOLS.includes(call.name)) {
        const filePath = call.input.file_path as string;
        if (filePath) {
          filesModified.add(filePath);
        }

        const changes = calculateLineChanges(call.name, call.input);
        totalAdditions += changes.additions;
        totalDeletions += changes.deletions;
      }
    }

    return {
      totalFilesChanged: filesModified.size,
      totalAdditions,
      totalDeletions
    };
  }

  /**
   * Sends current state to the webview.
   */
  private _sendStateToWebview(): void {
    this._postMessage({ type: 'updateStats', state: this._state });
  }

  /**
   * Public method to generate and send session summary on demand.
   * Triggered by the sidekick.generateSessionSummary command.
   */
  generateSummaryOnDemand(): void {
    this._buildAndSendSummary();
  }

  /**
   * Public method to refresh historical data display.
   *
   * Called after retroactive import completes to update the History tab.
   */
  refresh(): void {
    // Re-send historical data to the webview
    this._sendHistoricalData(this._currentHistoricalRange);
  }

  /**
   * Public method to refresh session-related panels and provider info.
   */
  refreshSessionView(): void {
    this._suppressSessionListUpdates = false;
    // Reset timeline and tool analytics for the new provider/session
    this._timeline = [];
    this._toolAnalytics.clear();
    this._state.timeline = [];
    this._state.toolAnalytics = [];
    this._state.errorDetails = [];

    this._syncFromSessionMonitor();
    this._sendStateToWebview();
    this._sendBurnRateUpdate();
    this._sendTimelineToWebview();
    this._sendToolAnalyticsToWebview();
    this._sendSessionList();
    this._sendProviderInfo();

    // Send provider-appropriate quota data on switch
    const provider = this._sessionMonitor.getProvider();
    const sessionQuota = provider.getQuotaFromSession?.();
    if (sessionQuota) {
      // Codex: has session-based quota from rate_limits
      this._handleQuotaUpdate(sessionQuota);
    } else if (this._quotaService && provider.id === 'claude-code') {
      // Claude Code: use cached quota from QuotaService, trigger refresh
      const cached = this._quotaService.getCachedQuota();
      if (cached) {
        this._handleQuotaUpdate(cached);
      }
      this._quotaService.startRefresh();
    } else {
      // OpenCode or no data: clear quota in webview
      this._handleQuotaUpdate({ fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' }, available: false });
    }
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
    if (this._suppressSessionListUpdates) {
      return;
    }
    if (this._sessionMonitor.isInDiscoveryMode()) {
      this._postMessage({ type: 'sessionsLoading', loading: true });
      return;
    }
    const groups = this._sessionMonitor.getAllSessionsGrouped();
    const customPath = this._sessionMonitor.getCustomPath();
    this._postMessage({
      type: 'updateSessionList',
      groups,
      isPinned: this._sessionMonitor.isPinned(),
      isUsingCustomPath: this._sessionMonitor.isUsingCustomPath(),
      customPathDisplay: customPath ? this._getShortPath(customPath) : null
    });
  }

  /**
   * Sends the current session provider info to the webview.
   */
  private _sendProviderInfo(): void {
    const provider = this._sessionMonitor.getProvider();
    this._postMessage({
      type: 'updateSessionProvider',
      providerId: provider.id,
      displayName: provider.displayName
    });
  }

  /**
   * Sends the current event log enabled state to the webview.
   */
  private _sendEventLogState(): void {
    const enabled = vscode.workspace.getConfiguration('sidekick').get<boolean>('enableEventLog', false);
    this._postMessage({ type: 'syncEventLogState', enabled });
  }

  /**
   * Gets a shortened display version of a path.
   */
  private _getShortPath(fullPath: string): string {
    // Get just the last part of the encoded path (the project folder name)
    const parts = fullPath.split(/[/\\]/);
    const encoded = parts[parts.length - 1] || parts[parts.length - 2] || fullPath;
    // Decode it for display
    if (encoded.startsWith('-')) {
      return '/' + encoded.substring(1).replace(/-/g, '/');
    }
    return encoded.replace(/-/g, '/');
  }

  /**
   * Serializes data to JSON that's safe to embed in an HTML <script> tag.
   * Escapes sequences that would break HTML parsing or template literals.
   */
  private _safeJsonForScript(data: unknown): string {
    return JSON.stringify(data)
      .replace(/</g, '\\u003c')     // Prevents </script> breaking HTML parser
      .replace(/>/g, '\\u003e')     // Prevents --> breaking HTML comments
      .replace(/\u2028/g, '\\u2028') // Line separator (breaks JS strings)
      .replace(/\u2029/g, '\\u2029'); // Paragraph separator (breaks JS strings)
  }

  /**
   * Gets the context window limit from the session provider.
   */
  private _getContextWindowLimit(): number {
    const provider = this._sessionMonitor.getProvider();
    return provider.getContextWindowLimit?.(this._lastModelId) ?? 200_000;
  }

  /**
   * Updates context window usage percentage.
   * Uses the actual context size from the most recent message, not cumulative tokens.
   */
  private _updateContextUsage(): void {
    // Context window = actual tokens in context from most recent message
    // This is input + cache_write + cache_read tokens
    this._state.contextUsagePercent = (this._currentContextSize / this._getContextWindowLimit()) * 100;
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

    // Pre-compute session groups for initial render (avoids reliance on postMessage)
    const initialGroups = this._sessionMonitor.getAllSessionsGrouped();
    const initialIsPinned = this._sessionMonitor.isPinned();
    const initialCustomPath = this._sessionMonitor.getCustomPath();
    const initialIsUsingCustomPath = this._sessionMonitor.isUsingCustomPath();
    const initialProvider = this._sessionMonitor.getProvider();

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

    /* Tab navigation */
    .tab-container {
      display: flex;
      gap: 0;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .tab-btn {
      flex: 1;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 500;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .tab-btn:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }

    .tab-btn.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-textLink-foreground);
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    /* History tab styles */
    .history-controls {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .range-selector {
      display: flex;
      gap: 0;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid var(--vscode-input-border);
    }

    .range-btn {
      padding: 6px 10px;
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: none;
      cursor: pointer;
      transition: background 0.2s;
    }

    .range-btn:not(:last-child) {
      border-right: 1px solid var(--vscode-input-border);
    }

    .range-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .range-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .metric-select {
      padding: 6px 8px;
      font-size: 11px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      cursor: pointer;
    }

    .history-chart {
      height: 180px;
      margin-bottom: 16px;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      font-size: 11px;
    }

    .breadcrumb-back {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }

    .breadcrumb-back:hover {
      text-decoration: underline;
    }

    .breadcrumb-current {
      color: var(--vscode-descriptionForeground);
    }

    .history-summary {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      margin-bottom: 16px;
    }

    .history-stat {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      text-align: center;
    }

    .history-stat .stat-value {
      font-size: 18px;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
    }

    .history-stat .stat-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .history-empty {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
    }

    .history-empty p {
      margin-bottom: 12px;
    }

    .history-empty .hint {
      font-size: 11px;
      margin-top: 8px;
      opacity: 0.8;
    }

    .import-btn {
      padding: 8px 16px;
      font-size: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .import-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .import-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .history-loading {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
    }

    /* Metric color variables */
    :root {
      --metric-cost: var(--vscode-charts-green, #4caf50);
      --metric-input: var(--vscode-charts-blue, #2196f3);
      --metric-output: var(--vscode-charts-purple, #9c27b0);
      --metric-cache-write: var(--vscode-charts-orange, #ff9800);
      --metric-cache-read: var(--vscode-charts-yellow, #ffeb3b);
      --metric-messages: var(--vscode-textLink-foreground);
    }

    /* Metric toggle buttons for session tab */
    .metric-toggles {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
    }

    .metric-btn {
      flex: 1;
      padding: 6px 8px;
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
    }

    .metric-btn:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }

    .metric-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    /* Primary metric display */
    .primary-metric-display {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 16px;
      text-align: center;
      margin-bottom: 16px;
    }

    .primary-metric-display .metric-value {
      font-size: 32px;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family);
      color: var(--metric-cost);
    }

    .primary-metric-display .metric-subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }

    .primary-metric-display[data-metric="cost"] .metric-value { color: var(--metric-cost); }
    .primary-metric-display[data-metric="input"] .metric-value { color: var(--metric-input); }
    .primary-metric-display[data-metric="output"] .metric-value { color: var(--metric-output); }
    .primary-metric-display[data-metric="cache-write"] .metric-value { color: var(--metric-cache-write); }
    .primary-metric-display[data-metric="cache-read"] .metric-value { color: var(--metric-cache-read); }
    .primary-metric-display[data-metric="messages"] .metric-value { color: var(--metric-messages); }

    /* Inline stats row */
    .inline-stats {
      display: flex;
      justify-content: space-around;
      gap: 8px;
      margin-bottom: 16px;
      font-size: 11px;
    }

    .inline-stat {
      text-align: center;
    }

    .inline-stat .stat-value {
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
    }

    .inline-stat .stat-label {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    /* Latency section */
    .latency-section {
      margin-bottom: 16px;
      padding: 8px 12px;
      background: var(--vscode-input-background);
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
    }

    .latency-section .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      letter-spacing: 0.5px;
    }

    .latency-display {
      font-size: 12px;
    }

    .latency-main {
      margin-bottom: 4px;
    }

    .latency-label {
      color: var(--vscode-descriptionForeground);
    }

    .latency-value {
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
      margin: 0 4px;
    }

    .latency-stats {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .latency-secondary {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .latency-value-secondary {
      font-family: var(--vscode-editor-font-family);
    }

    .latency-count {
      color: var(--vscode-descriptionForeground);
    }

    /* Unified collapsible section styling */
    .collapsible-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .collapsible-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      padding: 4px 0;
    }

    .collapsible-header:hover {
      opacity: 0.8;
    }

    .collapsible-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .collapsible-toggle-icon {
      font-size: 10px;
      transition: transform 0.2s;
      color: var(--vscode-foreground);
      opacity: 0.7;
    }

    .collapsible-section.expanded .collapsible-toggle-icon {
      transform: rotate(90deg);
    }

    .collapsible-header h3 {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
    }

    .collapsible-body {
      display: none;
      margin-top: 12px;
    }

    .collapsible-section.expanded .collapsible-body {
      display: block;
    }

    /* Collapsible group section styling */
    .details-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .details-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 4px 0;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .details-toggle:hover {
      opacity: 0.8;
    }

    .toggle-icon {
      font-size: 10px;
      transition: transform 0.2s;
      opacity: 0.7;
    }

    .details-section.expanded .toggle-icon {
      transform: rotate(90deg);
    }

    .details-content {
      display: none;
      margin-top: 12px;
    }

    .details-section.expanded .details-content {
      display: block;
    }

    .details-title {
      font-size: 13px;
      font-weight: 600;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 6px;
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

    .file-changes-display {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-family: var(--vscode-editor-font-family);
    }

    .file-changes-display .file-count {
      font-weight: 500;
    }

    .file-changes-display .separator {
      color: var(--vscode-descriptionForeground);
    }

    .file-changes-display .additions {
      color: var(--vscode-charts-green, #4caf50);
      font-weight: 600;
    }

    .file-changes-display .deletions {
      color: var(--vscode-charts-red, #f44336);
      font-weight: 600;
    }

    .file-changes-display .lines-label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
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

    .gauge-row.opencode-provider .context-item {
      flex: 1;
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

    .quota-card .quota-projection {
      font-size: 9px;
      margin-top: 2px;
      display: none;
    }

    .quota-card .quota-projection.visible {
      display: block;
    }

    .quota-card .quota-projection.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .quota-card .quota-projection.danger {
      color: var(--vscode-editorError-foreground);
    }

    .section-title-with-info {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .info-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      font-size: 10px;
      border-radius: 50%;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      cursor: help;
      position: relative;
    }

    .info-icon:hover .tooltip {
      display: block;
    }

    .tooltip {
      display: none;
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      margin-top: 6px;
      padding: 8px 10px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      font-size: 11px;
      font-weight: normal;
      text-transform: none;
      letter-spacing: normal;
      white-space: normal;
      width: 220px;
      z-index: 100;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      color: var(--vscode-foreground);
    }

    .tooltip::before {
      content: '';
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 6px solid transparent;
      border-bottom-color: var(--vscode-editorWidget-border);
    }

    .tooltip::after {
      content: '';
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-bottom-color: var(--vscode-editorWidget-background);
    }

    .tooltip p {
      margin: 0 0 6px 0;
    }

    .tooltip p:last-child {
      margin-bottom: 0;
    }

    .tooltip strong {
      color: var(--vscode-foreground);
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

    /* Summary tab styles */
    .summary-metrics-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 16px;
    }

    .summary-metric-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 10px 8px;
      text-align: center;
    }

    .summary-metric-card .metric-val {
      font-size: 18px;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family);
    }

    .summary-metric-card .metric-lbl {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .summary-section {
      margin-bottom: 16px;
    }

    .summary-section-title {
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .summary-task-table, .summary-file-table, .summary-cost-table {
      width: 100%;
      font-size: 11px;
      border-collapse: collapse;
    }

    .summary-task-table th, .summary-file-table th, .summary-cost-table th {
      text-align: left;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      padding: 4px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 10px;
    }

    .summary-task-table td, .summary-file-table td, .summary-cost-table td {
      padding: 4px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .status-icon {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
    }

    .status-icon.completed { background: var(--vscode-charts-green, #4caf50); }
    .status-icon.in_progress { background: var(--vscode-charts-blue, #2196f3); }
    .status-icon.pending { background: var(--vscode-charts-yellow, #ffeb3b); }

    .narrative-area {
      margin-top: 16px;
      margin-bottom: 8px;
    }

    .narrative-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .narrative-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: narrative-spin 0.8s linear infinite;
      flex-shrink: 0;
    }

    @keyframes narrative-spin {
      to { transform: rotate(360deg); }
    }

    .narrative-btn {
      padding: 8px 16px;
      font-size: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }

    .narrative-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .narrative-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .narrative-text {
      margin-top: 12px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.5;
    }

    .narrative-error {
      margin-top: 8px;
      color: var(--vscode-editorError-foreground);
      font-size: 11px;
    }

    /* Richer panel styles */
    .panel-metrics-row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    }

    .panel-metric-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      text-align: center;
    }

    .panel-metric-card .val {
      font-size: 16px;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
    }

    .panel-metric-card .lbl {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .recovery-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .recovery-item {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 11px;
    }

    .recovery-item .recovery-desc {
      font-weight: 500;
      margin-bottom: 4px;
    }

    .recovery-item .recovery-detail {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    .trend-indicator {
      display: inline-block;
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 2px;
    }

    .trend-indicator.increasing { color: var(--vscode-editorWarning-foreground); }
    .trend-indicator.stable { color: var(--vscode-descriptionForeground); }
    .trend-indicator.decreasing { color: var(--vscode-charts-green, #4caf50); }

    .decision-item {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 11px;
      margin-bottom: 6px;
    }
    .decision-desc { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
    .decision-chosen { font-size: 11px; color: var(--vscode-textLink-foreground); }
    .decision-rationale { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .decision-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .decision-badge {
      display: inline-block;
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .summary-empty {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
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

    /* Timeline controls (search + filters) */
    .timeline-controls {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 6px;
    }

    .timeline-search {
      width: 100%;
      padding: 4px 8px;
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      outline: none;
    }

    .timeline-search:focus {
      border-color: var(--vscode-focusBorder);
    }

    .timeline-search::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .timeline-filters {
      display: flex;
      gap: 8px;
      font-size: 10px;
    }

    .filter-toggle {
      display: flex;
      align-items: center;
      gap: 3px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }

    .filter-toggle input[type="checkbox"] {
      width: 12px;
      height: 12px;
    }

    .event-log-toggle {
      margin-left: auto;
      font-weight: 400;
    }

    /* Compaction display */
    /* Context Attribution */
    #context-attribution-chart {
      display: flex;
      height: 20px;
      border-radius: 3px;
      overflow: hidden;
      margin: 8px 0 6px;
    }

    #context-attribution-chart .attr-bar {
      transition: width 0.3s ease;
      min-width: 2px;
    }

    .attribution-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      font-size: 10px;
    }

    .attribution-legend .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .attribution-legend .legend-swatch {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .attribution-legend .legend-tokens {
      color: var(--vscode-descriptionForeground);
    }

    .compaction-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .compaction-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      font-size: 11px;
      background: var(--vscode-inputValidation-warningBackground);
      border-left: 3px solid var(--vscode-editorWarning-foreground);
      border-radius: 3px;
    }

    .compaction-item .compaction-time {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      min-width: 50px;
    }

    .compaction-item .compaction-delta {
      flex: 1;
    }

    .compaction-item .compaction-reclaimed {
      color: var(--vscode-charts-green);
      font-weight: 500;
      white-space: nowrap;
    }

    /* Timeline item noise classification */
    .timeline-item.compaction {
      background: var(--vscode-inputValidation-warningBackground);
      border-left: 3px solid var(--vscode-editorWarning-foreground);
    }

    .timeline-item.sidechain {
      opacity: 0.6;
    }

    .timeline-item.noise {
      opacity: 0.5;
      font-style: italic;
    }

    .timeline-item.system-event {
      opacity: 0.7;
      border-left: 2px solid var(--vscode-descriptionForeground);
    }

    .timeline-search-count {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 0;
    }

    .timeline-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 400px;
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

    .timeline-item.assistant {
      background: var(--vscode-textBlockQuote-background);
      border-left: 2px solid var(--vscode-textLink-foreground);
    }

    .timeline-item .expand-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 10px;
    }

    .timeline-item .expand-link:hover {
      text-decoration: underline;
    }

    .timeline-item.assistant .description {
      white-space: normal;
      word-wrap: break-word;
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

    .session-navigator {
      margin-bottom: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }

    .session-nav-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: pointer;
    }

    .session-nav-header:hover {
      opacity: 0.85;
    }

    .session-nav-header-left {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .session-navigator .toggle-icon {
      font-size: 10px;
      transition: transform 0.2s;
      opacity: 0.7;
    }

    .session-navigator.expanded .toggle-icon {
      transform: rotate(90deg);
    }

    .session-navigator .session-list {
      display: none;
    }

    .session-navigator.expanded .session-list {
      display: block;
    }

    .session-nav-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .session-nav-actions {
      display: flex;
      gap: 4px;
    }

    .session-provider {
      display: flex;
      align-items: center;
      gap: 6px;
      padding-right: 4px;
    }

    .session-provider label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .session-provider select {
      font-size: 10px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 3px;
      padding: 2px 6px;
      outline: none;
    }

    .session-provider select:focus {
      border-color: var(--vscode-focusBorder);
    }

    .session-nav-actions .nav-btn,
    .session-nav-actions .pin-btn {
      padding: 2px 6px;
      font-size: 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }

    .session-nav-actions .nav-btn:hover,
    .session-nav-actions .pin-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .session-nav-actions .nav-btn.browse {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .session-nav-actions .nav-btn.browse:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .session-nav-actions .pin-btn.pinned {
      background: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    }

    .session-list {
      max-height: 200px;
      overflow-y: auto;
    }

    .session-group-header {
      padding: 4px 8px 2px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
    }

    .session-card {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      cursor: pointer;
      border-left: 2px solid transparent;
    }

    .session-card:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .session-card.current {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-left-color: var(--vscode-focusBorder);
    }

    .session-card-status {
      flex-shrink: 0;
    }

    .status-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
    }

    .status-dot.active {
      background: #3fb950;
    }

    .session-card-content {
      flex: 1;
      min-width: 0;
    }

    .session-card-label {
      font-size: 11px;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-card-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .session-card.current .session-card-meta {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.8;
    }

    .session-list-empty {
      padding: 12px 8px;
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .session-list-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px 8px;
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .session-list-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: narrative-spin 0.8s linear infinite;
      flex-shrink: 0;
    }

    .custom-path-indicator {
      display: none;
      margin-bottom: 8px;
      padding: 6px 8px;
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
      border-radius: 4px;
      font-size: 11px;
    }

    .custom-path-indicator.visible {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .custom-path-indicator .path-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .custom-path-indicator .reset-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      white-space: nowrap;
    }

    .custom-path-indicator .reset-link:hover {
      text-decoration: underline;
    }

    /* CLAUDE.md Suggestions Panel */
    .suggestions-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .suggestions-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      padding: 4px 0;
    }

    .suggestions-header:hover {
      opacity: 0.8;
    }

    .suggestions-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .suggestions-toggle-icon {
      font-size: 10px;
      transition: transform 0.2s;
      color: var(--vscode-foreground);
      opacity: 0.7;
    }

    .suggestions-section.expanded .suggestions-toggle-icon {
      transform: rotate(90deg);
    }

    .suggestions-header h3 {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
    }

    .suggestions-header h3::before {
      content: '💡';
      font-size: 14px;
    }

    .suggestions-body {
      display: none;
      margin-top: 12px;
    }

    .suggestions-section.expanded .suggestions-body {
      display: block;
    }

    #analyze-btn {
      padding: 6px 12px;
      font-size: 11px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }

    #analyze-btn:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    #analyze-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .suggestions-content {
      min-height: 60px;
    }

    .suggestions-loading,
    .suggestions-empty,
    .suggestions-error {
      text-align: center;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .suggestions-error {
      color: var(--vscode-errorForeground);
    }

    .suggestion-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
    }

    .suggestion-card-consolidated {
      border-color: var(--vscode-focusBorder);
    }

    .suggestion-header {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }

    .suggestion-observed,
    .suggestion-why,
    .suggestion-summary {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }

    .suggestion-observed .label,
    .suggestion-why .label,
    .suggestion-summary .label,
    .suggestion-rationale .label,
    .suggestion-code-header {
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .suggestion-code-header {
      font-size: 11px;
      margin-bottom: 4px;
    }

    .suggestion-code {
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--vscode-textBlockQuote-border);
      border-radius: 4px;
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 8px;
      overflow-x: auto;
    }

    .suggestion-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .suggestion-rationale {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-input-border);
      padding-top: 10px;
      margin-top: 4px;
    }

    .suggestion-rationale-list {
      margin: 6px 0 0 0;
      padding-left: 18px;
    }

    .suggestion-rationale-list li {
      margin-bottom: 4px;
    }

    .copy-btn {
      padding: 4px 10px;
      font-size: 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .copy-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .suggestions-footer {
      margin-top: 20px;
      padding-top: 16px;
      text-align: center;
      border-top: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
    }

    .open-claude-md-btn {
      padding: 10px 20px;
      font-size: 11px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .open-claude-md-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .suggestions-intro {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
      line-height: 1.5;
    }

    .suggestions-intro a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .suggestions-intro a:hover {
      text-decoration: underline;
    }

    .suggestions-tip {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 12px;
      padding: 8px 10px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 4px;
      line-height: 1.5;
    }

    .suggestions-tip code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.4;
    }

    /* Session Handoff Button */
    .handoff-section {
      margin-top: 12px;
      padding: 8px 0;
    }

    .handoff-btn {
      width: 100%;
      padding: 6px 12px;
      font-size: 12px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }

    .handoff-btn:hover {
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

  <div class="custom-path-indicator" id="custom-path-indicator" title="Using a manually selected session folder">
    <span class="path-text" id="custom-path-text">Custom: /path/to/folder</span>
    <span class="reset-link" id="reset-custom-path" title="Switch back to auto-detect mode">Reset</span>
  </div>

  <div class="session-navigator expanded" id="session-navigator">
    <div class="session-nav-header" data-collapsible="true">
      <div class="session-nav-header-left">
        <span class="toggle-icon">▶</span>
        <span class="session-nav-title">Sessions</span>
      </div>
      <div class="session-nav-actions">
        <div class="session-provider">
          <label for="session-provider-select">Provider</label>
          <select id="session-provider-select">
            <option value="claude-code">Claude Code</option>
            <option value="opencode">OpenCode</option>
            <option value="codex">Codex CLI</option>
          </select>
        </div>
        <button class="pin-btn" id="pin-session" title="Pin session to prevent auto-switching">Pin</button>
        <button class="nav-btn" id="refresh-sessions" title="Refresh session list">↻</button>
        <button class="nav-btn browse" id="browse-folders" title="Browse session folders">Browse...</button>
      </div>
    </div>
    <div class="session-list" id="session-list">
      <div class="session-list-loading">
        <span class="session-list-spinner"></span>
        Loading sessions\u2026
      </div>
    </div>
  </div>

  <div class="tab-container">
    <button class="tab-btn active" data-tab="session">Session</button>
    <button class="tab-btn" data-tab="summary">Summary</button>
    <button class="tab-btn" data-tab="history">History</button>
  </div>

  <div id="session-tab" class="tab-content active">
    <div id="content">
      <div class="empty-state">
        <p id="empty-state-title">No active session detected.</p>
        <p id="empty-state-hint">Start a session to see analytics.</p>
      </div>
    </div>

    <div id="dashboard" style="display: none;">
      <div class="metric-toggles">
        <button class="metric-btn active" data-metric="quota">Quota</button>
        <button class="metric-btn" data-metric="cost">Cost</button>
        <button class="metric-btn" data-metric="tokens">Tokens</button>
        <button class="metric-btn" data-metric="cache">Cache</button>
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
                <div class="quota-projection" id="quota-5h-projection"></div>
              </div>
              <div class="quota-card" title="Usage in the last 7 days">
                <div class="quota-label">7-Day</div>
                <div class="quota-gauge">
                  <canvas id="quota7dChart"></canvas>
                  <span class="quota-percent" id="quota-7d-percent">0%</span>
                </div>
                <div class="quota-reset" id="quota-7d-reset">-</div>
                <div class="quota-projection" id="quota-7d-projection"></div>
              </div>
            </div>
          </div>
          <div class="quota-error" id="quota-error" style="display: none;"></div>
        </div>
      </div>

      <div class="primary-metric-display" data-metric="cost" id="primary-metric-display" style="display: none;">
        <div class="metric-value" id="primary-metric-value">$0.00</div>
        <div class="metric-subtitle" id="primary-metric-subtitle">Estimated session cost</div>
      </div>

      <div class="inline-stats">
        <div class="inline-stat">
          <div class="stat-value" id="inline-duration">0m</div>
          <div class="stat-label">Duration</div>
        </div>
        <div class="inline-stat">
          <div class="stat-value" id="inline-burn-rate">0</div>
          <div class="stat-label">tok/min</div>
        </div>
        <div class="inline-stat">
          <div class="stat-value" id="inline-api-calls">0</div>
          <div class="stat-label">API calls</div>
        </div>
      </div>

      <div class="latency-section" id="latency-section" style="display: none;">
        <div class="section-title section-title-with-info">
          Response Times
          <span class="info-icon">?<div class="tooltip">
            <p>How long Claude takes to respond to your prompts.</p>
            <p><strong>First Token:</strong> Time until streaming begins (thinking time)</p>
            <p><strong>Total:</strong> Time for complete response</p>
          </div></span>
        </div>
        <div class="latency-display">
          <div class="latency-main">
            <span class="latency-label">First Token:</span>
            <span class="latency-value" id="latency-last">-</span>
            <span class="latency-stats">(avg <span id="latency-avg">-</span> · max <span id="latency-max">-</span>)</span>
          </div>
          <div class="latency-secondary">
            <span class="latency-label">Total:</span>
            <span class="latency-value-secondary">avg <span id="latency-total-avg">-</span></span>
            <span class="latency-count">· <span id="latency-count">0</span> requests</span>
          </div>
        </div>
      </div>

      <!-- Agent Guidance Suggestions Panel -->
      <div class="suggestions-section" id="suggestions-panel">
        <div class="suggestions-header" id="suggestions-header">
          <div class="suggestions-header-left">
            <span class="suggestions-toggle-icon">▶</span>
            <h3>Improve Agent Guidance</h3>
          </div>
          <button id="analyze-btn" title="Analyze your session patterns to generate suggestions for your agent's instruction file. Better guidance helps the agent work more efficiently on your project.">Get Suggestions</button>
        </div>
        <div class="suggestions-body">
          <p class="suggestions-intro">
            Analyze your session to get AI-powered suggestions for improving your agent's instruction file.
            <a id="guidance-docs-link" href="https://docs.anthropic.com/en/docs/claude-code/memory#claudemd" target="_blank">Best practices →</a>
          </p>
          <div class="suggestions-content">
            <!-- Suggestions will be rendered here -->
          </div>
        </div>
      </div>

      <!-- Session Handoff -->
      <div class="handoff-section">
        <button id="generate-handoff-btn" class="handoff-btn" title="Generate a context handoff document so your next agent session can pick up where this one left off.">Generate Handoff</button>
      </div>

      <!-- Session Activity Group -->
      <div class="details-section" id="session-activity-section">
        <div class="details-toggle" data-group-toggle="session-activity-section">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Session Activity</h3>
          <label class="filter-toggle event-log-toggle" title="Record all session events to ~/.config/sidekick/event-logs/ for debugging. Events are written in real-time as a JSONL audit trail." onclick="event.stopPropagation()">
            <input type="checkbox" id="event-log-toggle" /> Event Log
          </label>
        </div>
        <div class="details-content">
          <!-- Context Attribution -->
          <div class="section" id="context-attribution-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Context Attribution
              <span class="info-icon">?<div class="tooltip">
                <p>Estimated breakdown of where context tokens are spent.</p>
                <p><strong>System Prompt:</strong> CLAUDE.md, system reminders</p>
                <p><strong>User Messages:</strong> Your prompts and text</p>
                <p><strong>Assistant:</strong> Claude's text responses</p>
                <p><strong>Tool I/O:</strong> Tool inputs and outputs</p>
                <p><strong>Thinking:</strong> Extended thinking blocks</p>
              </div></span>
            </div>
            <div id="context-attribution-chart"></div>
            <div class="attribution-legend" id="attribution-legend"></div>
          </div>

          <!-- Compaction Events -->
          <div class="section" id="compaction-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Context Compactions
              <span class="info-icon">?<div class="tooltip">
                <p>Context compaction occurs when the context window fills up.</p>
                <p>Claude summarizes the conversation to reclaim space.</p>
                <p><strong>Before/After:</strong> Context size in tokens</p>
                <p><strong>Reclaimed:</strong> Tokens freed by compaction</p>
              </div></span>
            </div>
            <div class="compaction-list" id="compaction-list"></div>
          </div>

          <div class="section">
            <div class="section-title section-title-with-info">
              Activity Timeline
              <span class="info-icon">?<div class="tooltip">
                <p>Chronological log of session events.</p>
                <p><strong>User prompts:</strong> Messages you sent</p>
                <p><strong>Tool calls:</strong> Actions Claude performed</p>
                <p><strong>Results:</strong> Outcomes of tool executions</p>
                <p><strong>Compaction:</strong> Context window was compacted</p>
              </div></span>
            </div>
            <!-- Timeline Search & Filters -->
            <div class="timeline-controls">
              <input type="text" id="timeline-search" class="timeline-search" placeholder="Search timeline..." />
              <div class="timeline-filters" id="timeline-filters">
                <label class="filter-toggle" title="User messages">
                  <input type="checkbox" data-filter="user" checked /> User
                </label>
                <label class="filter-toggle" title="AI responses">
                  <input type="checkbox" data-filter="ai" checked /> AI
                </label>
                <label class="filter-toggle" title="System/noise events">
                  <input type="checkbox" data-filter="system" /> System
                </label>
              </div>
            </div>
            <div class="timeline-list" id="timeline-list">
              <div class="timeline-item">
                <span class="time">--:--</span>
                <span class="description">No activity yet</span>
              </div>
            </div>
          </div>

          <div class="section" id="file-changes-section" style="display: none;">
            <div class="section-title section-title-with-info">
              File Changes
              <span class="info-icon">?<div class="tooltip">
                <p>Summary of code modifications made during this session.</p>
                <p><strong>Files:</strong> Number of unique files edited</p>
                <p><strong>+/-:</strong> Lines added and removed</p>
              </div></span>
            </div>
            <div class="file-changes-display" title="Number of unique files modified with line additions and deletions">
              <span class="file-count" id="file-count">0 files</span>
              <span class="separator">|</span>
              <span class="additions" id="file-additions">+0</span>
              <span class="separator">/</span>
              <span class="deletions" id="file-deletions">-0</span>
              <span class="lines-label">lines</span>
            </div>
          </div>

          <div class="section" id="error-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Errors
              <span class="info-icon">?<div class="tooltip">
                <p>Errors encountered during tool execution.</p>
                <p>Click on an error type to expand and see details.</p>
                <p>Common causes: file not found, permission denied, syntax errors.</p>
              </div></span>
            </div>
            <div class="error-list" id="error-list"></div>
          </div>
        </div>
      </div>

      <!-- Performance & Cost Group -->
      <div class="details-section" id="perf-cost-section">
        <div class="details-toggle" data-group-toggle="perf-cost-section">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Performance &amp; Cost</h3>
        </div>
        <div class="details-content">
          <div class="section">
            <div class="section-title section-title-with-info">
              Model Breakdown
              <span class="info-icon">?<div class="tooltip">
                <p>Shows which Claude models have been used in this session.</p>
                <p><strong>Opus:</strong> Highest quality, best for complex tasks</p>
                <p><strong>Sonnet:</strong> Balanced speed and quality</p>
                <p><strong>Haiku:</strong> Fast and efficient for simple tasks</p>
              </div></span>
            </div>
            <div class="model-list" id="model-list">
              <!-- Model items will be inserted here -->
            </div>
          </div>

          <div class="section">
            <div class="section-title section-title-with-info">
              Tool Analytics
              <span class="info-icon">?<div class="tooltip">
                <p>Tools invoked by Claude during this session.</p>
                <p><strong>Count:</strong> Number of times each tool was called</p>
                <p><strong>Success rate:</strong> Percentage of successful executions</p>
                <p><strong>Avg time:</strong> Average execution duration</p>
              </div></span>
            </div>
            <div class="tool-list" id="tool-list">
              <div class="tool-item"><span class="tool-name">No tools used yet</span></div>
            </div>
          </div>

          <div class="section" id="tool-eff-section" style="display: none;">
            <div class="section-title">Tool Efficiency</div>
            <div id="tool-eff-body"></div>
          </div>

          <div class="section" id="cache-eff-section" style="display: none;">
            <div class="section-title">Cache Effectiveness</div>
            <div id="cache-eff-body"></div>
          </div>

          <div class="section" id="burn-rate-section" style="display: none;">
            <div class="section-title">Advanced Burn Rate</div>
            <div id="burn-rate-body"></div>
          </div>
        </div>
      </div>

      <!-- Tasks & Recovery Group -->
      <div class="details-section" id="tasks-recovery-section">
        <div class="details-toggle" data-group-toggle="tasks-recovery-section">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Tasks &amp; Recovery</h3>
        </div>
        <div class="details-content">
          <div class="section" id="task-perf-section" style="display: none;">
            <div class="section-title">Task Performance</div>
            <div id="task-perf-body"></div>
          </div>

          <div class="section" id="recovery-section" style="display: none;">
            <div class="section-title">Recovery Patterns</div>
            <div id="recovery-body"></div>
          </div>
        </div>
      </div>

      <!-- Decisions Group -->
      <div class="details-section" id="decisions-section-group">
        <div class="details-toggle" data-group-toggle="decisions-section-group">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Decisions</h3>
        </div>
        <div class="details-content">
          <div class="section" id="decisions-section" style="display: none;">
            <div style="margin-bottom:8px;">
              <input type="text" id="decisions-search" placeholder="Search decisions..."
                style="width:100%;padding:4px 8px;background:var(--vscode-input-background);
                color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);
                border-radius:3px;font-size:11px;box-sizing:border-box;" />
            </div>
            <div id="decisions-count" style="font-size:11px;margin-bottom:8px;color:var(--vscode-descriptionForeground);"></div>
            <div id="decisions-list"></div>
          </div>
        </div>
      </div>

      <div class="last-updated">
        Last updated: <span id="last-updated">-</span>
      </div>
    </div>
  </div>

  <div id="summary-tab" class="tab-content">
    <div class="summary-empty" id="summary-empty">
      <p>No session summary available yet.</p>
      <p>A summary will be generated when a session ends, or you can request one during an active session.</p>
    </div>
    <div id="summary-content" style="display: none;">
      <div class="summary-metrics-row" id="summary-metrics">
        <div class="summary-metric-card"><div class="metric-val" id="sum-duration">-</div><div class="metric-lbl">Duration</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-tokens">-</div><div class="metric-lbl">Tokens</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-cost">-</div><div class="metric-lbl">Cost</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-api-calls">-</div><div class="metric-lbl">API Calls</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-context">-</div><div class="metric-lbl">Context Peak</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-completion">-</div><div class="metric-lbl">Tasks Done</div></div>
      </div>

      <div class="narrative-area">
        <button class="narrative-btn" id="generate-narrative-btn">Generate AI Narrative</button>
        <div class="narrative-loading" id="narrative-loading" style="display: none;">
          <span class="narrative-spinner"></span>
          <span>Generating narrative, this usually takes ~15-30s...</span>
        </div>
        <div class="narrative-text" id="narrative-display" style="display: none;"></div>
        <div class="narrative-error" id="narrative-error" style="display: none;"></div>
      </div>

      <div class="summary-section" id="sum-tasks-section">
        <div class="summary-section-title">Tasks</div>
        <div id="sum-tasks-content"></div>
      </div>

      <div class="summary-section" id="sum-files-section">
        <div class="summary-section-title">Files Changed</div>
        <div id="sum-files-content"></div>
      </div>

      <div class="summary-section" id="sum-cost-section">
        <div class="summary-section-title">Cost Breakdown</div>
        <div id="sum-cost-content"></div>
      </div>

      <div class="summary-section" id="sum-errors-section">
        <div class="summary-section-title">Errors &amp; Recovery</div>
        <div id="sum-errors-content"></div>
      </div>

    </div>
  </div>

  <div id="history-tab" class="tab-content">
    <div class="history-controls">
      <div class="range-selector">
        <button class="range-btn" data-range="today">Today</button>
        <button class="range-btn active" data-range="week">This Week</button>
        <button class="range-btn" data-range="month">This Month</button>
        <button class="range-btn" data-range="all">All Time</button>
      </div>
      <select class="metric-select" id="history-metric-select">
        <option value="tokens">Tokens</option>
        <option value="cost">Cost ($)</option>
        <option value="messages">Messages</option>
      </select>
    </div>

    <div class="chart-container history-chart">
      <canvas id="historyChart"></canvas>
    </div>

    <div class="breadcrumb" id="drill-breadcrumb" style="display: none;">
      <span class="breadcrumb-back" id="drill-up">← Back</span>
      <span class="breadcrumb-current" id="drill-label"></span>
    </div>

    <div class="history-summary" id="history-summary">
      <div class="history-stat">
        <div class="stat-value" id="history-total-tokens">0</div>
        <div class="stat-label">Total Tokens</div>
      </div>
      <div class="history-stat">
        <div class="stat-value" id="history-total-cost">$0.00</div>
        <div class="stat-label">Total Cost</div>
      </div>
      <div class="history-stat">
        <div class="stat-value" id="history-sessions">0</div>
        <div class="stat-label">Sessions</div>
      </div>
      <div class="history-stat">
        <div class="stat-value" id="history-messages">0</div>
        <div class="stat-label">Messages</div>
      </div>
    </div>

    <div class="history-empty" id="history-empty" style="display: none;">
      <p>No historical data available.</p>
      <button class="import-btn" id="import-historical-btn">Import Historical Data</button>
      <p class="hint">Scans ~/.claude/projects/ for past sessions</p>
    </div>

    <div class="history-loading" id="history-loading" style="display: none;">
      Loading historical data...
    </div>
  </div>

  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script nonce="${nonce}">
    // Initial session data embedded at HTML generation time (no postMessage needed)
    var __initialSessionData = ${this._safeJsonForScript({
      groups: initialGroups,
      isPinned: initialIsPinned,
      isUsingCustomPath: initialIsUsingCustomPath,
      customPathDisplay: initialCustomPath ? this._getShortPath(initialCustomPath) : null,
      providerId: initialProvider.id,
      providerName: initialProvider.displayName
    })};
  </script>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();

      // Catch uncaught errors
      window.onerror = function(msg, url, line) {
        var el = document.getElementById('session-list');
        if (el) el.innerHTML = '<div class="session-list-empty">JS Error: ' + msg + ' (line ' + line + ')</div>';
      };

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
      const sessionListEl = document.getElementById('session-list');
      const pinSessionBtn = document.getElementById('pin-session');
      const refreshSessionsBtn = document.getElementById('refresh-sessions');
      const browseFoldersBtn = document.getElementById('browse-folders');
      const sessionProviderSelect = document.getElementById('session-provider-select');
      const customPathIndicator = document.getElementById('custom-path-indicator');
      const customPathText = document.getElementById('custom-path-text');
      const resetCustomPath = document.getElementById('reset-custom-path');
      const emptyStateTitle = document.getElementById('empty-state-title');
      const emptyStateHint = document.getElementById('empty-state-hint');

      // Tab elements
      const tabBtns = document.querySelectorAll('.tab-btn');
      const tabContents = document.querySelectorAll('.tab-content');

      // Metric toggle elements
      const metricBtns = document.querySelectorAll('.metric-btn');
      const primaryMetricDisplay = document.getElementById('primary-metric-display');
      const primaryMetricValue = document.getElementById('primary-metric-value');
      const primaryMetricSubtitle = document.getElementById('primary-metric-subtitle');
      const gaugeRow = document.getElementById('gauge-row');

      // Group section toggle elements
      const groupToggles = document.querySelectorAll('[data-group-toggle]');

      // Inline stats elements
      const inlineDuration = document.getElementById('inline-duration');
      const inlineBurnRate = document.getElementById('inline-burn-rate');
      const inlineApiCalls = document.getElementById('inline-api-calls');

      // History tab elements
      const rangeBtns = document.querySelectorAll('.range-btn');
      const historyMetricSelect = document.getElementById('history-metric-select');
      const drillBreadcrumb = document.getElementById('drill-breadcrumb');
      const drillUpBtn = document.getElementById('drill-up');
      const drillLabel = document.getElementById('drill-label');
      const historyEmpty = document.getElementById('history-empty');
      const historyLoading = document.getElementById('history-loading');
      const historySummary = document.getElementById('history-summary');

      // Current state
      let currentMetric = 'quota';
      let currentRange = 'week';
      let currentHistoryData = null;
      let sessionState = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheWriteTokens: 0,
        totalCacheReadTokens: 0,
        totalCost: 0,
        messageCount: 0,
        burnRate: 0,
        sessionDuration: '0m'
      };

      let currentProviderId = 'claude-code';
      let currentProviderName = 'Claude Code';
      let currentQuota = null;

      // Provider-aware instruction file targeting
      var targetFileName = 'CLAUDE.md';
      var targetFileTip = 'After adding suggestions to your CLAUDE.md, run /init in Claude Code to consolidate and optimize the file.';
      var targetDocsUrl = 'https://docs.anthropic.com/en/docs/claude-code/memory#claudemd';

      // Suggestions state
      let currentSuggestions = [];
      let suggestionsLoading = false;

      // ==== CLAUDE.md Suggestions Functions ====

      function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      function setSuggestionsLoading(loading) {
        suggestionsLoading = loading;
        var panel = document.getElementById('suggestions-panel');
        var analyzeBtn = document.getElementById('analyze-btn');

        if (analyzeBtn) {
          analyzeBtn.disabled = loading;
          analyzeBtn.textContent = loading ? 'Analyzing...' : 'Get Suggestions';
        }

        if (panel && loading) {
          var content = panel.querySelector('.suggestions-content');
          if (content) {
            content.innerHTML = '<div class="suggestions-loading">Analyzing session data...</div>';
          }
        }
      }

      function showSuggestionsError(error) {
        var panel = document.getElementById('suggestions-panel');
        if (!panel) return;

        var content = panel.querySelector('.suggestions-content');
        if (content) {
          content.innerHTML = '<div class="suggestions-error">' + escapeHtml(error) + '</div>';
        }
      }

      function renderSuggestions(suggestions) {
        currentSuggestions = suggestions;
        var panel = document.getElementById('suggestions-panel');
        if (!panel) return;

        var content = panel.querySelector('.suggestions-content');
        if (!content) return;

        if (suggestions.length === 0) {
          content.innerHTML = '<div class="suggestions-empty">No suggestions generated. Try using Claude Code more before analyzing.</div>';
          return;
        }

        // Handle single consolidated suggestion (new format) or multiple suggestions (old format)
        var html;
        if (suggestions.length === 1 && suggestions[0].title === 'Recommended Addition') {
          // New consolidated format - single card with summary, code block, and rationale
          var s = suggestions[0];
          var rationaleItems = s.reasoning.split(' | ').filter(function(item) { return item.trim(); });
          var rationaleHtml = rationaleItems.length > 0
            ? '<ul class="suggestion-rationale-list">' +
                rationaleItems.map(function(item) {
                  return '<li>' + escapeHtml(item) + '</li>';
                }).join('') +
              '</ul>'
            : '<p>' + escapeHtml(s.reasoning) + '</p>';

          html = '<div class="suggestion-card suggestion-card-consolidated">' +
            '<div class="suggestion-header">' + escapeHtml(s.title) + '</div>' +
            '<div class="suggestion-summary"><span class="label">Summary:</span> ' + escapeHtml(s.observed) + '</div>' +
            '<div class="suggestion-code-header">Append this to ' + targetFileName + ':</div>' +
            '<pre class="suggestion-code">' + escapeHtml(s.suggestion) + '</pre>' +
            '<div class="suggestion-actions">' +
              '<button class="copy-btn" data-index="0">Copy to Clipboard</button>' +
            '</div>' +
            '<div class="suggestion-rationale">' +
              '<div class="label">Rationale:</div>' +
              rationaleHtml +
            '</div>' +
          '</div>';
        } else {
          // Legacy multi-suggestion format
          html = suggestions.map(function(s, i) {
            return '<div class="suggestion-card">' +
              '<div class="suggestion-header">' + (i + 1) + '. ' + escapeHtml(s.title) + '</div>' +
              '<div class="suggestion-observed"><span class="label">Observed:</span> ' + escapeHtml(s.observed) + '</div>' +
              '<pre class="suggestion-code">' + escapeHtml(s.suggestion) + '</pre>' +
              '<div class="suggestion-why"><span class="label">Why:</span> ' + escapeHtml(s.reasoning) + '</div>' +
              '<div class="suggestion-actions">' +
                '<button class="copy-btn" data-index="' + i + '">Copy</button>' +
              '</div>' +
            '</div>';
          }).join('');
        }

        content.innerHTML = html +
          '<div class="suggestions-footer">' +
            '<button class="open-claude-md-btn">Open ' + targetFileName + '</button>' +
          '</div>' +
          '<div class="suggestions-tip">' +
            '<strong>💡 Tip:</strong> ' + escapeHtml(targetFileTip) +
          '</div>';

        // Attach event listeners (CSP blocks inline onclick)
        content.querySelectorAll('.copy-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var index = parseInt(btn.getAttribute('data-index'), 10);
            if (index >= 0 && index < currentSuggestions.length) {
              vscode.postMessage({
                type: 'copySuggestion',
                text: currentSuggestions[index].suggestion
              });
            }
          });
        });

        var openBtn = content.querySelector('.open-claude-md-btn');
        if (openBtn) {
          openBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'openInstructionFile' });
          });
        }
      }

      // ==== End Suggestions Functions ====

      // Tab switching
      tabBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          var tab = btn.getAttribute('data-tab');

          tabBtns.forEach(function(b) { b.classList.remove('active'); });
          tabContents.forEach(function(c) { c.classList.remove('active'); });

          btn.classList.add('active');
          document.getElementById(tab + '-tab').classList.add('active');

          // Request data when switching tabs
          if (tab === 'history') {
            vscode.postMessage({ type: 'requestHistoricalData', range: currentRange, metric: 'tokens' });
          } else if (tab === 'summary') {
            vscode.postMessage({ type: 'requestSessionSummary' });
          }
        });
      });

      // Metric toggle switching
      metricBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          currentMetric = btn.getAttribute('data-metric');
          metricBtns.forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          updatePrimaryMetric();
        });
      });

      // Group section toggles
      groupToggles.forEach(function(toggle) {
        toggle.addEventListener('click', function() {
          var sectionId = toggle.getAttribute('data-group-toggle');
          var section = document.getElementById(sectionId);
          if (section) {
            section.classList.toggle('expanded');
          }
        });
      });

      // History range buttons
      rangeBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          currentRange = btn.getAttribute('data-range');
          rangeBtns.forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          vscode.postMessage({ type: 'requestHistoricalData', range: currentRange, metric: historyMetricSelect.value });
        });
      });

      // History metric selector
      if (historyMetricSelect) {
        historyMetricSelect.addEventListener('change', function() {
          if (currentHistoryData) {
            updateHistoryChart(currentHistoryData);
          }
        });
      }

      // Drill up button
      if (drillUpBtn) {
        drillUpBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'drillUp' });
        });
      }

      /**
       * Updates the primary metric display based on selected metric.
       */
      function updatePrimaryMetric() {
        if (!primaryMetricDisplay || !primaryMetricValue || !primaryMetricSubtitle || !gaugeRow) return;

        // Toggle between gauge view and numeric metric view
        if (currentMetric === 'quota') {
          gaugeRow.style.display = 'flex';
          primaryMetricDisplay.style.display = 'none';
        } else {
          gaugeRow.style.display = 'none';
          primaryMetricDisplay.style.display = 'block';
          primaryMetricDisplay.setAttribute('data-metric', currentMetric);

          switch (currentMetric) {
            case 'cost':
              primaryMetricValue.textContent = formatCost(sessionState.totalCost);
              primaryMetricSubtitle.textContent = 'Estimated session cost';
              break;
            case 'tokens':
              var totalTokens = sessionState.totalInputTokens + sessionState.totalOutputTokens;
              primaryMetricValue.textContent = formatNumber(totalTokens);
              primaryMetricSubtitle.textContent = formatNumber(sessionState.totalInputTokens) + ' in / ' + formatNumber(sessionState.totalOutputTokens) + ' out';
              break;
            case 'cache':
              var totalCache = sessionState.totalCacheWriteTokens + sessionState.totalCacheReadTokens;
              primaryMetricValue.textContent = formatNumber(totalCache);
              primaryMetricSubtitle.textContent = formatNumber(sessionState.totalCacheWriteTokens) + ' write / ' + formatNumber(sessionState.totalCacheReadTokens) + ' read';
              break;
          }
        }
      }

      /**
       * Updates inline stats display.
       */
      function updateInlineStats() {
        if (inlineDuration) inlineDuration.textContent = sessionState.sessionDuration;
        if (inlineBurnRate) inlineBurnRate.textContent = formatNumber(sessionState.burnRate);
        if (inlineApiCalls) inlineApiCalls.textContent = formatNumber(sessionState.messageCount);
      }

      // History chart
      let historyChart = null;

      /**
       * Initializes the history bar chart.
       */
      function initHistoryChart() {
        var canvas = document.getElementById('historyChart');
        if (!canvas || !window.Chart) return;

        var ctx = canvas.getContext('2d');
        if (!ctx) return;

        historyChart = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: [],
            datasets: [{
              label: 'Tokens',
              data: [],
              backgroundColor: 'rgba(75, 192, 192, 0.7)',
              borderColor: 'rgb(75, 192, 192)',
              borderWidth: 1
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: function(event, elements) {
              if (elements.length > 0 && currentHistoryData) {
                var index = elements[0].index;
                var dataPoint = currentHistoryData.dataPoints[index];
                if (dataPoint && (currentRange === 'all' || currentRange === 'month' || currentRange === 'week')) {
                  vscode.postMessage({
                    type: 'drillDown',
                    timestamp: dataPoint.timestamp,
                    currentRange: currentRange
                  });
                }
              }
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(context) {
                    var metric = historyMetricSelect ? historyMetricSelect.value : 'tokens';
                    if (metric === 'cost') {
                      return formatCost(context.raw);
                    }
                    return formatNumber(context.raw);
                  }
                }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: {
                  callback: function(value) {
                    var metric = historyMetricSelect ? historyMetricSelect.value : 'tokens';
                    if (metric === 'cost') {
                      return formatCost(value);
                    }
                    return formatNumber(value);
                  }
                }
              }
            }
          }
        });
      }

      /**
       * Updates the history chart with new data.
       */
      function updateHistoryChart(data) {
        currentHistoryData = data;

        if (!historyChart) {
          initHistoryChart();
        }
        if (!historyChart) return;

        var metric = historyMetricSelect ? historyMetricSelect.value : 'tokens';
        var labels = data.dataPoints.map(function(d) { return d.label; });
        var values = data.dataPoints.map(function(d) {
          switch (metric) {
            case 'cost': return d.totalCost;
            case 'messages': return d.messageCount;
            default: return d.inputTokens + d.outputTokens;
          }
        });

        var color = metric === 'cost' ? 'rgb(76, 175, 80)' :
                    metric === 'messages' ? 'rgb(33, 150, 243)' :
                    'rgb(75, 192, 192)';

        historyChart.data.labels = labels;
        historyChart.data.datasets[0].data = values;
        historyChart.data.datasets[0].backgroundColor = color.replace('rgb', 'rgba').replace(')', ', 0.7)');
        historyChart.data.datasets[0].borderColor = color;
        historyChart.data.datasets[0].label = metric === 'cost' ? 'Cost' : metric === 'messages' ? 'Messages' : 'Tokens';
        historyChart.update();

        // Update summary
        if (historySummary) {
          document.getElementById('history-total-tokens').textContent = formatNumber(data.totals.inputTokens + data.totals.outputTokens);
          document.getElementById('history-total-cost').textContent = formatCost(data.totals.totalCost);
          document.getElementById('history-sessions').textContent = formatNumber(data.totals.sessionCount);
          document.getElementById('history-messages').textContent = formatNumber(data.totals.messageCount);
        }

        // Show/hide empty state
        if (historyEmpty) {
          historyEmpty.style.display = data.dataPoints.length === 0 ? 'block' : 'none';
        }
        if (historySummary) {
          historySummary.style.display = data.dataPoints.length === 0 ? 'none' : 'grid';
        }
      }

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
       * Updates the projection display element.
       * @param projectionEl - The DOM element to update
       * @param projected - Projected utilization percentage (or undefined)
       */
      function updateProjectionDisplay(projectionEl, projected) {
        if (!projectionEl) return;

        // Hide if no projection data available
        if (projected === undefined) {
          projectionEl.classList.remove('visible', 'warning', 'danger');
          projectionEl.textContent = '';
          return;
        }

        projectionEl.classList.add('visible');
        projectionEl.classList.remove('warning', 'danger');

        if (projected >= 100) {
          projectionEl.textContent = 'May reach limit';
          projectionEl.classList.add('danger');
        } else if (projected >= 80) {
          projectionEl.textContent = '~' + Math.round(projected) + '% by reset';
          projectionEl.classList.add('warning');
        } else {
          projectionEl.textContent = '~' + Math.round(projected) + '% by reset';
        }
      }

      /**
       * Updates the quota display with new data.
       */
      function updateQuota(quota) {
        currentQuota = quota;

        var sectionEl = document.getElementById('quota-section');
        var contentEl = document.getElementById('quota-content');
        var errorEl = document.getElementById('quota-error');

        if (!sectionEl || !contentEl || !errorEl) return;

        if (currentProviderId === 'opencode') {
          sectionEl.classList.remove('visible');
          contentEl.style.display = 'none';
          errorEl.style.display = 'none';
          return;
        }

        if (!quota) {
          sectionEl.classList.remove('visible');
          contentEl.style.display = 'none';
          errorEl.style.display = 'none';
          return;
        }

        if (!quota.available) {
          // Hide quota section or show error
          if (quota.error) {
            sectionEl.classList.add('visible');
            contentEl.style.display = 'none';
            errorEl.style.display = 'block';
            errorEl.textContent = quota.error;
          } else {
            sectionEl.classList.remove('visible');
            contentEl.style.display = 'none';
            errorEl.style.display = 'none';
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
        var projection5hEl = document.getElementById('quota-5h-projection');
        updateQuotaGauge(quota5hChart, percent5hEl, quota.fiveHour.utilization);
        if (reset5hEl) {
          reset5hEl.textContent = formatResetTime(quota.fiveHour.resetsAt);
        }
        updateProjectionDisplay(projection5hEl, quota.projectedFiveHour);

        // Update 7-day gauge
        var percent7dEl = document.getElementById('quota-7d-percent');
        var reset7dEl = document.getElementById('quota-7d-reset');
        var projection7dEl = document.getElementById('quota-7d-projection');
        updateQuotaGauge(quota7dChart, percent7dEl, quota.sevenDay.utilization);
        if (reset7dEl) {
          reset7dEl.textContent = formatResetTime(quota.sevenDay.resetsAt);
        }
        updateProjectionDisplay(projection7dEl, quota.projectedSevenDay);
      }

      /**
       * Updates the latency display with new data.
       */
      function updateLatency(latency) {
        var sectionEl = document.getElementById('latency-section');
        if (!sectionEl) return;

        if (!latency || !latency.hasData) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';

        var lastEl = document.getElementById('latency-last');
        var avgEl = document.getElementById('latency-avg');
        var maxEl = document.getElementById('latency-max');
        var totalAvgEl = document.getElementById('latency-total-avg');
        var countEl = document.getElementById('latency-count');

        if (lastEl) lastEl.textContent = latency.lastFirstToken;
        if (avgEl) avgEl.textContent = latency.avgFirstToken;
        if (maxEl) maxEl.textContent = latency.maxFirstToken;
        if (totalAvgEl) totalAvgEl.textContent = latency.avgTotal;
        if (countEl) countEl.textContent = latency.cycleCount;
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

          return '<div class="tool-item" data-tool-name="' + escapeHtml(tool.name) + '" style="cursor: pointer;">' +
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
            '<div class="tool-drilldown" style="display: none;"></div>' +
          '</div>';
        }).join('');

        // Add click handlers for drill-down
        toolListEl.querySelectorAll('.tool-item[data-tool-name]').forEach(function(item) {
          item.addEventListener('click', function() {
            var toolName = item.getAttribute('data-tool-name');
            var drilldown = item.querySelector('.tool-drilldown');
            if (!drilldown) return;

            if (drilldown.style.display === 'none') {
              // Request details from extension
              vscode.postMessage({ type: 'requestToolCallDetails', toolName: toolName });
              drilldown.innerHTML = '<div style="padding: 4px; font-size: 10px; color: var(--vscode-descriptionForeground);">Loading...</div>';
              drilldown.style.display = 'block';
            } else {
              drilldown.style.display = 'none';
            }
          });
        });
      }

      /**
       * Renders tool call details in the drill-down area.
       */
      function renderToolCallDetails(toolName, calls) {
        var toolListEl = document.getElementById('tool-list');
        if (!toolListEl) return;

        var item = toolListEl.querySelector('.tool-item[data-tool-name="' + escapeHtml(toolName) + '"]');
        if (!item) return;

        var drilldown = item.querySelector('.tool-drilldown');
        if (!drilldown) return;

        if (!calls || calls.length === 0) {
          drilldown.innerHTML = '<div style="padding: 4px; font-size: 10px;">No calls recorded</div>';
          return;
        }

        drilldown.innerHTML = calls.slice(0, 20).map(function(call) {
          var errorStyle = call.isError ? 'color: var(--vscode-errorForeground);' : '';
          return '<div style="display: flex; gap: 6px; padding: 2px 4px; font-size: 10px; border-bottom: 1px solid var(--vscode-panel-border); ' + errorStyle + '">' +
            '<span style="min-width: 45px; color: var(--vscode-descriptionForeground);">' + call.time + '</span>' +
            '<span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + escapeHtml(call.description) + '</span>' +
            '<span style="min-width: 40px; text-align: right;">' + call.duration + '</span>' +
          '</div>';
        }).join('') +
        (calls.length > 20 ? '<div style="padding: 2px 4px; font-size: 10px; color: var(--vscode-descriptionForeground);">...and ' + (calls.length - 20) + ' more</div>' : '');
      }

      // Current timeline events cache for client-side filtering
      var currentTimelineEvents = [];

      // Current filter state
      var timelineFilters = { showUser: true, showAi: true, showSystem: false, showSidechain: false };

      /**
       * Updates timeline display with search and filter support.
       */
      function updateTimeline(events) {
        currentTimelineEvents = events || [];
        renderFilteredTimeline();
      }

      /**
       * Renders the timeline with current search query and filters applied.
       */
      function renderFilteredTimeline() {
        const timelineEl = document.getElementById('timeline-list');
        if (!timelineEl) return;

        var events = currentTimelineEvents;
        var searchQuery = '';
        var searchEl = document.getElementById('timeline-search');
        if (searchEl) {
          searchQuery = searchEl.value.trim().toLowerCase();
        }

        // Apply filters
        var filtered = events.filter(function(event) {
          // Noise-level filtering
          var noise = event.noiseLevel || 'ai';
          if (noise === 'user' && !timelineFilters.showUser) return false;
          if (noise === 'ai' && !timelineFilters.showAi) return false;
          if ((noise === 'system' || noise === 'noise') && !timelineFilters.showSystem) return false;
          if (event.isSidechain && !timelineFilters.showSidechain) return false;

          // Search filtering
          if (searchQuery) {
            var desc = (event.description || '').toLowerCase();
            var full = (event.fullText || '').toLowerCase();
            if (desc.indexOf(searchQuery) === -1 && full.indexOf(searchQuery) === -1) {
              return false;
            }
          }

          return true;
        });

        if (filtered.length === 0) {
          timelineEl.innerHTML = '<div class="timeline-item">' +
            '<span class="time">--:--</span>' +
            '<span class="description">' + (searchQuery ? 'No matching events' : 'No activity yet') + '</span>' +
          '</div>';
          return;
        }

        // Show result count when searching
        var countHtml = '';
        if (searchQuery) {
          countHtml = '<div class="timeline-search-count">Showing ' + filtered.length + ' of ' + events.length + ' events</div>';
        }

        const iconMap = {
          'user_prompt': '\uD83D\uDCAC',
          'tool_call': '\uD83D\uDD27',
          'tool_result': '\u2713',
          'error': '\u274C',
          'assistant_response': '\uD83E\uDD16',
          'compaction': '\u26A0'
        };

        timelineEl.innerHTML = countHtml + filtered.map(function(event, idx) {
          const icon = iconMap[event.type] || '\u25CF';
          var classes = 'timeline-item';
          if (event.isError) classes += ' error';
          if (event.type === 'assistant_response') classes += ' assistant';
          if (event.type === 'compaction') classes += ' compaction';
          if (event.isSidechain) classes += ' sidechain';
          if (event.noiseLevel === 'noise') classes += ' noise';
          if (event.noiseLevel === 'system') classes += ' system-event';

          // Highlight search matches
          var desc = escapeHtml(event.description);
          if (searchQuery) {
            try {
              var escaped = searchQuery.replace(/[-\\/^$*+?.()|[\\]{}]/g, String.fromCharCode(92) + '$&');
              var re = new RegExp('(' + escaped + ')', 'gi');
              desc = desc.replace(re, '<mark>$1</mark>');
            } catch(ex) { /* invalid regex, skip highlighting */ }
          }

          // Add expand link for assistant responses with full text
          let expandLink = '';
          if (event.type === 'assistant_response' && event.fullText) {
            expandLink = ' <span class="expand-link" data-idx="' + idx + '" data-expanded="false">[more]</span>';
          }

          return '<div class="' + classes + '" data-idx="' + idx + '">' +
            '<span class="time">' + event.time + '</span>' +
            '<span class="icon">' + icon + '</span>' +
            '<span class="description" data-truncated="' + escapeHtml(event.description) + '" data-full="' + (event.fullText ? escapeHtml(event.fullText) : '') + '">' + desc + expandLink + '</span>' +
          '</div>';
        }).join('');

        // Add click handlers for expand/collapse
        timelineEl.querySelectorAll('.expand-link').forEach(function(link) {
          link.addEventListener('click', function handleExpand(e) {
            e.stopPropagation();
            const idx = link.getAttribute('data-idx');
            const item = timelineEl.querySelector('.timeline-item[data-idx="' + idx + '"]');
            if (!item) return;

            const descEl = item.querySelector('.description');
            if (!descEl) return;

            const isExpanded = link.getAttribute('data-expanded') === 'true';
            const truncated = descEl.getAttribute('data-truncated');
            const full = descEl.getAttribute('data-full');

            if (isExpanded) {
              descEl.innerHTML = truncated + ' <span class="expand-link" data-idx="' + idx + '" data-expanded="false">[more]</span>';
            } else {
              descEl.innerHTML = full + ' <span class="expand-link" data-idx="' + idx + '" data-expanded="true">[less]</span>';
            }

            const newLink = descEl.querySelector('.expand-link');
            if (newLink) {
              newLink.addEventListener('click', handleExpand);
            }
          });
        });
      }

      /**
       * Updates compaction events display.
       */
      function updateCompactions(compactions) {
        var sectionEl = document.getElementById('compaction-section');
        var listEl = document.getElementById('compaction-list');
        if (!sectionEl || !listEl) return;

        if (!compactions || compactions.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';
        listEl.innerHTML = compactions.map(function(c) {
          var beforeK = Math.round(c.contextBefore / 1000);
          var afterK = Math.round(c.contextAfter / 1000);
          var reclaimedK = Math.round(c.tokensReclaimed / 1000);
          return '<div class="compaction-item">' +
            '<span class="compaction-time">' + c.time + '</span>' +
            '<span class="compaction-delta">' + beforeK + 'K → ' + afterK + 'K</span>' +
            '<span class="compaction-reclaimed">-' + reclaimedK + 'K (' + c.reclaimedPercent + '%)</span>' +
          '</div>';
        }).join('');
      }

      /**
       * Updates context attribution stacked bar + legend.
       */
      function updateContextAttribution(attribution) {
        var sectionEl = document.getElementById('context-attribution-section');
        var chartEl = document.getElementById('context-attribution-chart');
        var legendEl = document.getElementById('attribution-legend');
        if (!sectionEl || !chartEl || !legendEl) return;

        if (!attribution || attribution.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';

        // Stacked bar
        chartEl.innerHTML = attribution.map(function(a) {
          return '<div class="attr-bar" style="width:' + a.percent + '%;background:' + a.color + '" title="' +
            a.category + ': ' + formatTokensShort(a.tokens) + ' (' + a.percent + '%)"></div>';
        }).join('');

        // Legend
        legendEl.innerHTML = attribution.map(function(a) {
          return '<span class="legend-item">' +
            '<span class="legend-swatch" style="background:' + a.color + '"></span>' +
            '<span>' + a.category + '</span>' +
            '<span class="legend-tokens">' + formatTokensShort(a.tokens) + ' (' + a.percent + '%)</span>' +
          '</span>';
        }).join('');
      }

      function formatTokensShort(tokens) {
        if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + 'M';
        if (tokens >= 1000) return Math.round(tokens / 1000) + 'K';
        return String(tokens);
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

      function updateProviderDisplay(providerId, providerName) {
        if (!providerId || !providerName) return;
        currentQuota = null;
        currentProviderId = providerId;
        currentProviderName = providerName;

        // Update instruction file targeting based on provider
        var instructionTargets = {
          'claude-code': {
            file: 'CLAUDE.md',
            tip: 'After adding suggestions to your CLAUDE.md, run /init in Claude Code to consolidate and optimize the file.',
            docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/memory#claudemd'
          },
          'opencode': {
            file: 'AGENTS.md',
            tip: 'OpenCode reads AGENTS.md for project-specific instructions. It falls back to CLAUDE.md if AGENTS.md is not found.',
            docsUrl: 'https://github.com/opencode-ai/opencode'
          },
          'codex': {
            file: 'AGENTS.md',
            tip: 'Codex reads AGENTS.md for project-specific agent instructions.',
            docsUrl: 'https://github.com/openai/codex'
          }
        };
        var instrTarget = instructionTargets[providerId] || instructionTargets['claude-code'];
        targetFileName = instrTarget.file;
        targetFileTip = instrTarget.tip;
        targetDocsUrl = instrTarget.docsUrl;

        // Update docs link if present
        var docsLink = document.getElementById('guidance-docs-link');
        if (docsLink) docsLink.setAttribute('href', targetDocsUrl);

        if (sessionProviderSelect) {
          sessionProviderSelect.value = providerId;
        }

        if (emptyStateTitle) {
          emptyStateTitle.textContent = 'No active ' + providerName + ' session detected.';
        }
        if (emptyStateHint) {
          emptyStateHint.textContent = 'Start a ' + providerName + ' session to see analytics.';
        }

        var quotaSectionEl = document.getElementById('quota-section');
        var quotaContentEl = document.getElementById('quota-content');
        var quotaErrorEl = document.getElementById('quota-error');

        if (gaugeRow) {
          gaugeRow.classList.toggle('opencode-provider', currentProviderId === 'opencode');
        }

        // For OpenCode: repurpose the Quota button as "Context" (no subscription quota)
        // For Claude Code: restore the Quota button label and show subscription quota
        var quotaBtn = document.querySelector('.metric-btn[data-metric="quota"]');
        if (currentProviderId === 'opencode') {
          if (quotaSectionEl) quotaSectionEl.classList.remove('visible');
          if (quotaContentEl) quotaContentEl.style.display = 'none';
          if (quotaErrorEl) quotaErrorEl.style.display = 'none';
          if (quotaBtn) quotaBtn.textContent = 'Context';
          return;
        }

        // Restore for non-OpenCode providers
        if (quotaBtn) quotaBtn.textContent = 'Quota';

        if (currentQuota) {
          updateQuota(currentQuota);
        }
      }

      /**
       * Updates the session card navigator.
       */
      function updateSessionList(groups, isPinned, isUsingCustomPath, customPathDisplay) {
        if (!sessionListEl) return;

        // Update custom path indicator
        if (customPathIndicator && customPathText) {
          if (isUsingCustomPath && customPathDisplay) {
            customPathIndicator.classList.add('visible');
            customPathText.textContent = 'Custom: ' + customPathDisplay;
          } else {
            customPathIndicator.classList.remove('visible');
          }
        }

        // Update pin button
        if (pinSessionBtn) {
          pinSessionBtn.textContent = isPinned ? 'Unpin' : 'Pin';
          if (isPinned) {
            pinSessionBtn.classList.add('pinned');
            pinSessionBtn.title = 'Unpin session to allow auto-switching';
          } else {
            pinSessionBtn.classList.remove('pinned');
            pinSessionBtn.title = 'Pin session to prevent auto-switching';
          }
        }

        // Clear current content
        sessionListEl.innerHTML = '';

        if (!groups || groups.length === 0) {
          sessionListEl.innerHTML = '<div class="session-list-empty">No sessions available</div>';
          return;
        }

        var totalSessions = 0;
        groups.forEach(function(group) {
          // Add group header for non-current groups
          if (group.proximity !== 'current') {
            var header = document.createElement('div');
            header.className = 'session-group-header';
            header.textContent = group.displayPath || group.projectPath;
            sessionListEl.appendChild(header);
          }

          // Add session cards
          group.sessions.forEach(function(session, index) {
            var card = document.createElement('div');
            card.className = 'session-card' + (session.isCurrent ? ' current' : '');
            card.setAttribute('data-path', session.path);

            var statusDiv = document.createElement('div');
            statusDiv.className = 'session-card-status';
            var dot = document.createElement('span');
            dot.className = 'status-dot' + (session.isActive ? ' active' : '');
            statusDiv.appendChild(dot);

            var contentDiv = document.createElement('div');
            contentDiv.className = 'session-card-content';

            var labelDiv = document.createElement('div');
            labelDiv.className = 'session-card-label';
            labelDiv.textContent = session.label || session.filename.slice(0, 8) + '...';

            var metaDiv = document.createElement('div');
            metaDiv.className = 'session-card-meta';
            var date = new Date(session.modifiedTime);
            metaDiv.textContent = (index === 0 && group.proximity === 'current') ? 'Latest' : formatRelativeTime(date);

            contentDiv.appendChild(labelDiv);
            contentDiv.appendChild(metaDiv);

            card.appendChild(statusDiv);
            card.appendChild(contentDiv);

            sessionListEl.appendChild(card);
            totalSessions++;
          });
        });

        if (totalSessions === 0) {
          sessionListEl.innerHTML = '<div class="session-list-empty">No sessions available</div>';
        }
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
       * Updates the file changes display.
       */
      function updateFileChanges(summary) {
        var sectionEl = document.getElementById('file-changes-section');
        var fileCountEl = document.getElementById('file-count');
        var additionsEl = document.getElementById('file-additions');
        var deletionsEl = document.getElementById('file-deletions');

        if (!sectionEl || !fileCountEl || !additionsEl || !deletionsEl) return;

        // Hide section if no changes
        if (!summary || (summary.totalFilesChanged === 0 && summary.totalAdditions === 0 && summary.totalDeletions === 0)) {
          sectionEl.style.display = 'none';
          return;
        }

        // Show section with data
        sectionEl.style.display = 'block';
        var fileCount = summary.totalFilesChanged || 0;
        fileCountEl.textContent = fileCount + ' file' + (fileCount !== 1 ? 's' : '');
        additionsEl.textContent = '+' + formatNumber(summary.totalAdditions || 0);
        deletionsEl.textContent = '-' + formatNumber(summary.totalDeletions || 0);
      }

      /**
       * Updates the dashboard with new state.
       */
      function updateDashboard(state) {
        // Update session state for metric toggles
        sessionState.totalInputTokens = state.totalInputTokens;
        sessionState.totalOutputTokens = state.totalOutputTokens;
        sessionState.totalCacheWriteTokens = state.totalCacheWriteTokens;
        sessionState.totalCacheReadTokens = state.totalCacheReadTokens;
        sessionState.totalCost = state.totalCost;
        sessionState.messageCount = state.modelBreakdown.reduce(function(sum, m) { return sum + m.calls; }, 0);

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

        // Update tokens (in details section)
        if (inputTokensEl) inputTokensEl.textContent = formatNumber(state.totalInputTokens);
        if (outputTokensEl) outputTokensEl.textContent = formatNumber(state.totalOutputTokens);
        if (cacheWriteTokensEl) cacheWriteTokensEl.textContent = formatNumber(state.totalCacheWriteTokens);
        if (cacheReadTokensEl) cacheReadTokensEl.textContent = formatNumber(state.totalCacheReadTokens);

        // Update primary metric display
        updatePrimaryMetric();
        updateInlineStats();

        // Update context gauge
        updateContextGauge(state.contextUsagePercent || 0);

        // Update latency display
        if (state.latencyDisplay) {
          updateLatency(state.latencyDisplay);
        }

        // Update model breakdown
        if (modelListEl) {
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
        }

        // Update error details
        if (state.errorDetails) {
          updateErrorDetails(state.errorDetails);
        }

        // Update file changes
        updateFileChanges(state.fileChangeSummary);

        // Update compactions
        if (state.compactions) {
          updateCompactions(state.compactions);
        }

        // Update context attribution
        if (state.contextAttribution) {
          updateContextAttribution(state.contextAttribution);
        }

        // Update timestamp
        if (state.lastUpdated && lastUpdatedEl) {
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
            sessionState.burnRate = Math.round(message.burnRate);
            if (message.sessionStartTime) {
              var start = new Date(message.sessionStartTime);
              var now = new Date();
              var minutes = Math.floor((now - start) / 60000);
              var hours = Math.floor(minutes / 60);
              var mins = minutes % 60;
              sessionState.sessionDuration = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
            }
            updateInlineStats();
            break;

          case 'updateSessionList':
            updateSessionList(message.groups, message.isPinned, message.isUsingCustomPath, message.customPathDisplay);
            break;

          case 'sessionsLoading':
            if (message.loading && sessionListEl) {
              sessionListEl.innerHTML = '<div class="session-list-loading">' +
                '<span class="session-list-spinner"></span>' +
                'Loading sessions\u2026' +
                '</div>';
            }
            break;

          case 'updateSessionProvider':
            updateProviderDisplay(message.providerId, message.displayName);
            break;

          case 'updateHistoricalData':
            if (historyLoading) historyLoading.style.display = 'none';
            updateHistoryChart(message.data);
            break;

          case 'historicalDataLoading':
            if (historyLoading) historyLoading.style.display = message.loading ? 'block' : 'none';
            break;

          case 'updateQuota':
            updateQuota(message.quota);
            break;

          case 'updateLatency':
            updateLatency(message.latency);
            break;

          case 'showSuggestions':
            renderSuggestions(message.suggestions);
            break;

          case 'suggestionsLoading':
            setSuggestionsLoading(message.loading);
            break;

          case 'suggestionsError':
            showSuggestionsError(message.error);
            break;

          case 'updateSessionSummary':
            renderSessionSummary(message.summary);
            break;

          case 'updateTaskPerformance':
            renderTaskPerformance(message.data);
            break;

          case 'updateCacheEffectiveness':
            renderCacheEffectiveness(message.data);
            break;

          case 'updateRecoveryPatterns':
            renderRecoveryPatterns(message.data);
            break;

          case 'updateDecisions':
            renderDecisions(message.decisions, message.totalCount);
            break;

          case 'updateAdvancedBurnRate':
            renderAdvancedBurnRate(message.data);
            break;

          case 'updateToolEfficiency':
            renderToolEfficiency(message.data);
            break;

          case 'sessionNarrative':
            var narrativeEl = document.getElementById('narrative-display');
            var narrativeErrEl = document.getElementById('narrative-error');
            if (narrativeEl) {
              narrativeEl.textContent = message.narrative;
              narrativeEl.style.display = 'block';
            }
            if (narrativeErrEl) narrativeErrEl.style.display = 'none';
            break;

          case 'narrativeLoading':
            var narrBtn = document.getElementById('generate-narrative-btn');
            var narrSpinner = document.getElementById('narrative-loading');
            if (narrBtn) {
              narrBtn.disabled = message.loading;
              narrBtn.textContent = message.loading ? 'Generating...' : 'Generate AI Narrative';
            }
            if (narrSpinner) {
              narrSpinner.style.display = message.loading ? 'flex' : 'none';
            }
            break;

          case 'narrativeError':
            var narrErrEl = document.getElementById('narrative-error');
            if (narrErrEl) {
              narrErrEl.textContent = message.error;
              narrErrEl.style.display = 'block';
            }
            break;

          case 'updateCompactions':
            updateCompactions(message.compactions);
            break;

          case 'updateContextAttribution':
            updateContextAttribution(message.attribution);
            break;

          case 'toolCallDetails':
            renderToolCallDetails(message.toolName, message.calls);
            break;

          case 'syncEventLogState':
            var elToggle = document.getElementById('event-log-toggle');
            if (elToggle) elToggle.checked = message.enabled;
            break;
        }
      });

      // Timeline search input handler (debounced)
      var searchTimer = null;
      var searchInput = document.getElementById('timeline-search');
      if (searchInput) {
        searchInput.addEventListener('input', function() {
          if (searchTimer) clearTimeout(searchTimer);
          searchTimer = setTimeout(function() {
            var query = searchInput.value.trim();
            if (query.length > 0) {
              // Request all events from extension for search
              vscode.postMessage({ type: 'searchTimeline', query: query });
            } else {
              // Clear search - re-render with current events
              renderFilteredTimeline();
            }
          }, 300);
        });
      }

      // Timeline filter checkbox handlers
      var filtersEl = document.getElementById('timeline-filters');
      if (filtersEl) {
        filtersEl.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
          cb.addEventListener('change', function() {
            var filterName = cb.getAttribute('data-filter');
            if (filterName === 'user') timelineFilters.showUser = cb.checked;
            if (filterName === 'ai') timelineFilters.showAi = cb.checked;
            if (filterName === 'system') {
              timelineFilters.showSystem = cb.checked;
              timelineFilters.showSidechain = cb.checked;
            }
            renderFilteredTimeline();
          });
        });
      }

      // Event log toggle handler
      var eventLogToggle = document.getElementById('event-log-toggle');
      if (eventLogToggle) {
        eventLogToggle.addEventListener('change', function() {
          vscode.postMessage({ type: 'toggleEventLog', enabled: eventLogToggle.checked });
        });
      }

      // Session navigator event handlers
      if (sessionListEl) {
        sessionListEl.addEventListener('click', function(e) {
          var target = e.target;
          while (target && target !== sessionListEl) {
            if (target.classList && target.classList.contains('session-card')) {
              var sessionPath = target.getAttribute('data-path');
              if (sessionPath) {
                vscode.postMessage({ type: 'selectSession', sessionPath: sessionPath });
              }
              return;
            }
            target = target.parentElement;
          }
        });
      }

      if (pinSessionBtn) {
        pinSessionBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'togglePin' });
        });
      }

      if (refreshSessionsBtn) {
        refreshSessionsBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'refreshSessions' });
        });
      }

      if (sessionProviderSelect) {
        sessionProviderSelect.addEventListener('change', function() {
          var nextProvider = sessionProviderSelect.value;
          if (nextProvider && nextProvider !== currentProviderId) {
            var providerLabel = sessionProviderSelect.options[sessionProviderSelect.selectedIndex].text;
            if (sessionListEl) {
              sessionListEl.innerHTML = '<div class="session-list-loading">' +
                '<span class="session-list-spinner"></span>' +
                'Loading ' + escapeHtml(providerLabel) + ' sessions\u2026' +
                '</div>';
            }
            vscode.postMessage({ type: 'setSessionProvider', providerId: nextProvider });
          }
        });
      }

      if (browseFoldersBtn) {
        browseFoldersBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'browseSessionFolders' });
        });
      }

      if (resetCustomPath) {
        resetCustomPath.addEventListener('click', function() {
          vscode.postMessage({ type: 'clearCustomPath' });
        });
      }

      // Import historical data button
      var importHistoricalBtn = document.getElementById('import-historical-btn');
      if (importHistoricalBtn) {
        importHistoricalBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'importHistoricalData' });
        });
      }

      // Initialize charts and signal ready
      try {
        initContextGauge();
        initQuotaGauges();
        initHistoryChart();
      } catch (chartErr) {
        // Chart init failure should not block session list
      }

      // Set up event listeners for CLAUDE.md suggestions (CSP blocks inline onclick)
      var suggestionsPanel = document.getElementById('suggestions-panel');
      var suggestionsHeader = document.getElementById('suggestions-header');
      var analyzeBtn = document.getElementById('analyze-btn');

      if (suggestionsHeader && suggestionsPanel) {
        suggestionsHeader.addEventListener('click', function(e) {
          // Don't toggle if clicking the analyze button
          if (analyzeBtn && (e.target === analyzeBtn || analyzeBtn.contains(e.target))) {
            return;
          }
          suggestionsPanel.classList.toggle('expanded');
        });
      }

      if (analyzeBtn) {
        analyzeBtn.addEventListener('click', function(e) {
          e.stopPropagation(); // Prevent header toggle
          // Auto-expand when analyzing
          if (suggestionsPanel) {
            suggestionsPanel.classList.add('expanded');
          }
          vscode.postMessage({ type: 'analyzeSession' });
        });
      }

      // Set up handoff button
      var handoffBtn = document.getElementById('generate-handoff-btn');
      if (handoffBtn) {
        handoffBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'generateHandoff' });
        });
      }

      // ==== Collapsible panel toggles ====
      document.querySelectorAll('[data-collapsible="true"]').forEach(function(header) {
        header.addEventListener('click', function() {
          header.parentElement.classList.toggle('expanded');
        });
      });

      // ==== Summary tab + Richer panels ====

      var narrativeBtn = document.getElementById('generate-narrative-btn');
      if (narrativeBtn) {
        narrativeBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'generateNarrative' });
        });
      }

      function formatDurationMs(ms) {
        var sec = Math.floor(ms / 1000);
        if (sec < 60) return sec + 's';
        var min = Math.floor(sec / 60);
        var hours = Math.floor(min / 60);
        if (hours > 0) return hours + 'h ' + (min % 60) + 'm';
        return min + 'm';
      }

      function renderSessionSummary(summary) {
        var empty = document.getElementById('summary-empty');
        var content = document.getElementById('summary-content');
        if (!content) return;

        if (empty) empty.style.display = 'none';
        content.style.display = 'block';

        // Metric cards
        var durEl = document.getElementById('sum-duration');
        var tokEl = document.getElementById('sum-tokens');
        var costEl = document.getElementById('sum-cost');
        var apiEl = document.getElementById('sum-api-calls');
        var ctxEl = document.getElementById('sum-context');
        var compEl = document.getElementById('sum-completion');

        if (durEl) durEl.textContent = formatDurationMs(summary.duration);
        if (tokEl) tokEl.textContent = formatNumber(summary.totalTokens);
        if (costEl) costEl.textContent = formatCost(summary.totalCost);
        if (apiEl) apiEl.textContent = formatNumber(summary.apiCalls);
        if (ctxEl) ctxEl.textContent = Math.round(summary.contextPeak) + '%';
        if (compEl) compEl.textContent = Math.round(summary.taskCompletionRate * 100) + '%';

        // Tasks table
        var tasksEl = document.getElementById('sum-tasks-content');
        if (tasksEl) {
          if (summary.tasks.length === 0) {
            tasksEl.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">No tasks tracked</div>';
          } else {
            var html = '<table class="summary-task-table"><tr><th>Task</th><th>Status</th><th>Duration</th><th>Tools</th></tr>';
            summary.tasks.forEach(function(t) {
              html += '<tr><td>' + escapeHtml(t.subject) + '</td>' +
                '<td><span class="status-icon ' + t.status + '"></span>' + t.status + '</td>' +
                '<td>' + formatDurationMs(t.duration) + '</td>' +
                '<td>' + t.toolCallCount + '</td></tr>';
            });
            html += '</table>';
            tasksEl.innerHTML = html;
          }
        }

        // Files table
        var filesEl = document.getElementById('sum-files-content');
        if (filesEl) {
          if (summary.filesChanged.length === 0) {
            filesEl.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">No files changed</div>';
          } else {
            var fhtml = '<div style="margin-bottom:6px;font-size:11px;">' + summary.totalFilesChanged + ' files | <span style="color:var(--vscode-charts-green,#4caf50)">+' + summary.totalAdditions + '</span> / <span style="color:var(--vscode-charts-red,#f44336)">-' + summary.totalDeletions + '</span></div>';
            fhtml += '<table class="summary-file-table"><tr><th>File</th><th>+/-</th></tr>';
            summary.filesChanged.slice(0, 15).forEach(function(f) {
              fhtml += '<tr><td style="font-family:var(--vscode-editor-font-family)">' + escapeHtml(f.path) + '</td>' +
                '<td><span style="color:var(--vscode-charts-green,#4caf50)">+' + f.additions + '</span>/<span style="color:var(--vscode-charts-red,#f44336)">-' + f.deletions + '</span></td></tr>';
            });
            fhtml += '</table>';
            filesEl.innerHTML = fhtml;
          }
        }

        // Cost breakdown
        var costContentEl = document.getElementById('sum-cost-content');
        if (costContentEl) {
          var chtml = '';
          if (summary.costByModel.length > 0) {
            chtml += '<div style="font-size:11px;font-weight:600;margin-bottom:4px;">By Model</div>';
            chtml += '<table class="summary-cost-table"><tr><th>Model</th><th>Cost</th><th>%</th></tr>';
            summary.costByModel.forEach(function(m) {
              chtml += '<tr><td>' + escapeHtml(getShortModelName(m.model)) + '</td><td>' + formatCost(m.cost) + '</td><td>' + Math.round(m.percentage) + '%</td></tr>';
            });
            chtml += '</table>';
          }
          if (summary.costByTool.length > 0) {
            chtml += '<div style="font-size:11px;font-weight:600;margin:8px 0 4px;">By Tool (estimated)</div>';
            chtml += '<table class="summary-cost-table"><tr><th>Tool</th><th>Cost</th><th>Calls</th></tr>';
            summary.costByTool.slice(0, 8).forEach(function(t) {
              chtml += '<tr><td>' + escapeHtml(t.tool) + '</td><td>' + formatCost(t.estimatedCost) + '</td><td>' + t.calls + '</td></tr>';
            });
            chtml += '</table>';
          }
          costContentEl.innerHTML = chtml || '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">No cost data</div>';
        }

        // Errors & Recovery
        var errEl = document.getElementById('sum-errors-content');
        if (errEl) {
          if (summary.errors.length === 0) {
            errEl.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">No errors</div>';
          } else {
            var ehtml = '<div style="font-size:11px;margin-bottom:6px;">Recovery rate: <strong>' + Math.round(summary.recoveryRate * 100) + '%</strong></div>';
            summary.errors.forEach(function(e) {
              ehtml += '<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--vscode-panel-border);">' +
                '<span style="font-weight:500;">' + escapeHtml(e.category) + '</span>: ' + e.count +
                (e.recovered ? ' <span style="color:var(--vscode-charts-green,#4caf50);">(recovered)</span>' : '') + '</div>';
            });
            errEl.innerHTML = ehtml;
          }
        }
      }

      function renderTaskPerformance(data) {
        var section = document.getElementById('task-perf-section');
        var body = document.getElementById('task-perf-body');
        if (!section || !body) return;

        if (data.totalTasks === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        var html = '<div class="panel-metrics-row">' +
          '<div class="panel-metric-card"><div class="val">' + Math.round(data.completionRate * 100) + '%</div><div class="lbl">Completion</div></div>' +
          '<div class="panel-metric-card"><div class="val">' + data.completedTasks + '/' + data.totalTasks + '</div><div class="lbl">Tasks</div></div>' +
          '</div>';

        if (data.tasks.length > 0) {
          html += '<table class="summary-task-table"><tr><th>Task</th><th>Status</th><th>Tools</th></tr>';
          data.tasks.forEach(function(t) {
            html += '<tr><td>' + escapeHtml(t.subject) + '</td>' +
              '<td><span class="status-icon ' + t.status + '"></span>' + t.status + '</td>' +
              '<td>' + t.toolCallCount + '</td></tr>';
          });
          html += '</table>';
        }
        body.innerHTML = html;
      }

      function renderCacheEffectiveness(data) {
        var section = document.getElementById('cache-eff-section');
        var body = document.getElementById('cache-eff-body');
        if (!section || !body) return;

        if (data.cacheReadTokens === 0 && data.cacheWriteTokens === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        body.innerHTML = '<div class="panel-metrics-row">' +
          '<div class="panel-metric-card"><div class="val">' + Math.round(data.cacheHitRate * 100) + '%</div><div class="lbl">Cache Hit Rate</div></div>' +
          '<div class="panel-metric-card"><div class="val">' + formatNumber(data.estimatedTokensSaved) + '</div><div class="lbl">Tokens Saved</div></div>' +
          '<div class="panel-metric-card"><div class="val">' + formatCost(data.estimatedCostSaved) + '</div><div class="lbl">Cost Saved</div></div>' +
          '<div class="panel-metric-card"><div class="val">' + formatNumber(data.cacheWriteTokens) + '</div><div class="lbl">Cache Writes</div></div>' +
          '</div>';
      }

      function renderRecoveryPatterns(data) {
        var section = document.getElementById('recovery-section');
        var body = document.getElementById('recovery-body');
        if (!section || !body) return;

        if (data.patterns.length === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        var html = '<div style="font-size:11px;margin-bottom:8px;">Recovery rate: <strong>' + Math.round(data.recoveryRate * 100) + '%</strong> (' + data.totalRecoveries + '/' + data.totalErrors + ' errors)</div>';
        html += '<div class="recovery-list">';
        data.patterns.forEach(function(p) {
          html += '<div class="recovery-item">' +
            '<div class="recovery-desc">' + escapeHtml(p.description) + ' <span style="color:var(--vscode-descriptionForeground)">(' + p.occurrences + 'x)</span></div>' +
            '<div class="recovery-detail">' + escapeHtml(p.failedApproach) + ' → ' + escapeHtml(p.successfulApproach) + '</div>' +
            '</div>';
        });
        html += '</div>';
        body.innerHTML = html;
      }

      function renderDecisions(decisions, totalCount) {
        var section = document.getElementById('decisions-section');
        var listEl = document.getElementById('decisions-list');
        var countEl = document.getElementById('decisions-count');
        if (!section || !listEl) return;

        if (totalCount === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        if (countEl) {
          var countText = decisions.length === totalCount
            ? totalCount + ' decision' + (totalCount !== 1 ? 's' : '')
            : decisions.length + ' of ' + totalCount + ' decisions';
          countEl.textContent = countText;
        }

        var html = '';
        decisions.forEach(function(d) {
          var sourceLabel = d.source.replace(/_/g, ' ');
          var timeAgo = formatRelativeTime(d.timestamp);
          html += '<div class="decision-item">' +
            '<div class="decision-desc">' + escapeHtml(d.description) + '</div>' +
            '<div class="decision-chosen">Chosen: ' + escapeHtml(d.chosenOption) + '</div>' +
            '<div class="decision-rationale">' + escapeHtml(d.rationale) + '</div>' +
            (d.alternatives && d.alternatives.length > 0
              ? '<div class="decision-rationale">Alternatives: ' + d.alternatives.map(escapeHtml).join(', ') + '</div>'
              : '') +
            '<div class="decision-meta"><span class="decision-badge">' + escapeHtml(sourceLabel) + '</span> ' + timeAgo + '</div>' +
            '</div>';
        });
        listEl.innerHTML = html;
      }

      function formatRelativeTime(isoString) {
        var now = Date.now();
        var then = new Date(isoString).getTime();
        var diffMs = now - then;
        var diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return diffMin + 'min ago';
        var diffHours = Math.floor(diffMin / 60);
        if (diffHours < 24) return diffHours + 'h ago';
        var diffDays = Math.floor(diffHours / 24);
        return diffDays + 'd ago';
      }

      // Decisions search handler (300ms debounce)
      var decisionsSearchTimer = null;
      var decisionsSearchEl = document.getElementById('decisions-search');
      if (decisionsSearchEl) {
        decisionsSearchEl.addEventListener('input', function() {
          if (decisionsSearchTimer) clearTimeout(decisionsSearchTimer);
          decisionsSearchTimer = setTimeout(function() {
            vscode.postMessage({ type: 'searchDecisions', query: decisionsSearchEl.value });
          }, 300);
        });
      }

      function renderAdvancedBurnRate(data) {
        var section = document.getElementById('burn-rate-section');
        var body = document.getElementById('burn-rate-body');
        if (!section || !body) return;

        if (data.currentRate === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        var trendIcon = data.trendDirection === 'increasing' ? '↑' : data.trendDirection === 'decreasing' ? '↓' : '→';

        var html = '<div class="panel-metrics-row">' +
          '<div class="panel-metric-card"><div class="val">' + formatNumber(Math.round(data.currentRate)) + '</div><div class="lbl">tok/min</div></div>' +
          '<div class="panel-metric-card"><div class="val"><span class="trend-indicator ' + data.trendDirection + '">' + trendIcon + ' ' + data.trendDirection + '</span></div><div class="lbl">Trend</div></div>' +
          '</div>';

        if (data.projectedQuotaExhaustion) {
          var exDate = new Date(data.projectedQuotaExhaustion);
          html += '<div style="font-size:11px;color:var(--vscode-editorWarning-foreground);margin-bottom:8px;">Projected quota exhaustion: ' + exDate.toLocaleTimeString() + '</div>';
        }

        if (data.rateByModel.length > 0) {
          html += '<div style="font-size:11px;font-weight:600;margin-bottom:4px;">By Model</div>';
          data.rateByModel.forEach(function(m) {
            html += '<div style="font-size:11px;padding:2px 0;">' + escapeHtml(getShortModelName(m.model)) + ': ' + formatNumber(m.tokensPerMin) + ' tok/min</div>';
          });
        }
        body.innerHTML = html;
      }

      function renderToolEfficiency(data) {
        var section = document.getElementById('tool-eff-section');
        var body = document.getElementById('tool-eff-body');
        if (!section || !body) return;

        if (data.length === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        var html = '<table class="summary-cost-table"><tr><th>Tool</th><th>Calls</th><th>Cost</th><th>Fail%</th><th>Avg</th></tr>';
        data.forEach(function(t) {
          html += '<tr>' +
            '<td>' + escapeHtml(t.name) + '</td>' +
            '<td>' + t.totalCalls + '</td>' +
            '<td>' + formatCost(t.estimatedCost) + '</td>' +
            '<td>' + Math.round(t.failureRate * 100) + '%</td>' +
            '<td>' + t.avgDurationFormatted + '</td>' +
            '</tr>';
        });
        html += '</table>';
        body.innerHTML = html;
      }

      // Render initial session data embedded at HTML generation time
      if (window.__initialSessionData) {
        try {
          var init = window.__initialSessionData;
          updateSessionList(init.groups, init.isPinned, init.isUsingCustomPath, init.customPathDisplay);
          if (init.providerId && init.providerName) {
            updateProviderDisplay(init.providerId, init.providerName);
          }
        } catch (e) {
          var errEl = document.getElementById('session-list');
          if (errEl) errEl.innerHTML = '<div class="session-list-empty">Init error: ' + e.message + '</div>';
        }
      }

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
    // Final decision extraction as safety net before teardown
    try {
      this._extractAndPersistDecisions();
    } catch {
      // Best-effort — don't block dispose
    }
    if (this._richerPanelTimer) {
      clearTimeout(this._richerPanelTimer);
    }
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    log('DashboardViewProvider disposed');
  }
}
