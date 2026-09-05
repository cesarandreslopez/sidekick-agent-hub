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
import type {
  QuotaState as DashboardQuotaState,
  QuotaFailureDisplay,
  HistoricalSummary,
  HistoricalDataPoint,
  LatencyDisplay,
  ClaudeMdSuggestionDisplay,
  DashboardStatsPayload,
} from '../types/dashboard';
import { resolveInstructionTarget } from '../types/instructionFile';
import type { HandoffService } from '../services/HandoffService';
import { getProjectSlug, summarizeTokens } from 'sidekick-shared';
import { resolveModel } from '../services/ModelResolver';
import { TimeoutError } from '../types';
import type {
  TokenUsage,
  SessionStats,
  ToolAnalytics,
  TimelineEvent,
  ToolCall,
  LatencyStats,
} from '../types/claudeSession';
import type {
  DashboardMessage,
  DashboardWebviewMessage,
  DashboardState,
  CompactionEventDisplay,
  ToolCallDetailDisplay,
} from '../types/dashboard';
import type { SessionAnalyzer } from '../services/SessionAnalyzer';
import type { AuthService } from '../services/AuthService';
import type { SessionEventLogger } from '../services/SessionEventLogger';
import type { DecisionLogService } from '../services/DecisionLogService';
import type { NotificationPersistenceService } from '../services/NotificationPersistenceService';
import type { SessionSummaryData } from '../types/sessionSummary';
import { ModelPricingService } from '../services/ModelPricingService';
import { parseChangelog } from '../utils/changelogParser';
import type { ChangelogEntry } from '../utils/changelogParser';
import { calculateLineChanges } from '../utils/lineChangeCalculator';
import { BurnRateCalculator } from '../services/BurnRateCalculator';
import { SessionSummaryService } from '../services/SessionSummaryService';
import { extractDecisions } from '../services/DecisionExtractor';
import { log, logError } from '../services/Logger';
import { getNonce } from '../utils/nonce';
import {
  ATTRIBUTION_LABELS,
  ATTRIBUTION_VARS,
  attributionVarRef,
  attributionVarsByLabel,
  type AttributionCategory,
} from '../utils/themePalette';
import {
  BILLING_BLOCK_DURATION_MS,
  ClaudeCodeProvider,
  CodexProvider,
  OpenCodeProvider,
  billingBlockToStateFile,
  collectUsageEvents,
  computeBillingBlocks,
  describeQuotaFailure,
  findActiveBillingBlock,
  getActiveAccountStatus,
  quotaToStateFile,
  writeStateFile,
  formatDurationMs,
  readQuotaHistoryDailyBuckets,
  resolveQuota,
  scopePeakHoursToSessionProvider,
  calculateCompactionLedger,
} from 'sidekick-shared';
import type { BillingBlock, SessionProviderBase } from 'sidekick-shared';
import type {
  BillingBlockOfficialSample,
  DashboardInit,
  HistoricalRange,
  HistoricalSeries,
} from '../types/dashboard';
import { buildHistoricalSummary, buildHourlyPoints } from '../services/HistoricalSummaryBuilder';
import { renderDashboardHtml } from './dashboardTemplate';
import { getWorkspaceId } from '../utils/workspaceId';
import type { QuotaHistoryPayload, QuotaHistoryDailyCell } from '../types/dashboard';
import { PhraseRotationManager } from '../utils/PhraseRotationManager';
import {
  scopeProviderStatuses,
  type DashboardSessionProviderId,
} from '../utils/providerStatusScope';
import { formatProviderStatusDisplay } from '../utils/providerStatusDisplay';
import { MAX_DISPLAY_TIMELINE, DEFAULT_CONTEXT_WINDOW } from '../constants';

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
type DashboardFlushKind = 'stats' | 'timeline' | 'toolAnalytics' | 'plan' | 'burnRate';

/** The stats message without the timeline (sent separately as `updateTimeline`). */
function statsPayload(state: DashboardState): DashboardStatsPayload {
  const payload: Partial<DashboardState> = { ...state };
  delete payload.timeline;
  return payload as DashboardStatsPayload;
}

export class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  /** View type identifier for VS Code registration */
  public static readonly viewType = 'sidekick.dashboard';

  /** Current webview view instance */
  private _view?: vscode.WebviewView;

  /** Disposables for cleanup */
  private _disposables: vscode.Disposable[] = [];

  /** Bindings tied to the currently resolved webview instance. */
  private _viewDisposables: vscode.Disposable[] = [];
  private _changelogEntries: ChangelogEntry[] | undefined;

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

  /** QuotaService for subscription quota data */
  private readonly _quotaService?: QuotaService;

  /** HistoricalDataService for long-term analytics */
  private _historicalDataService?: HistoricalDataService;

  /** Current historical data range being displayed */
  private _currentHistoricalRange: HistoricalRange = 'week';
  private _currentHistoricalSeries: HistoricalSeries = 'total';
  private _currentHistoricalProject: string | null = null;

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
  /**
   * Coalesced webview sends. Hot handlers (token usage, timeline events, tool
   * analytics) mark a kind dirty; one trailing timer posts each dirty message
   * once, so a burst of events costs one post per kind.
   */
  private readonly _dirty = new Set<DashboardFlushKind>();
  private _flushTimer?: ReturnType<typeof setTimeout>;
  private static readonly FLUSH_MS = 250;

  /** Suppresses session list updates during provider switches */
  private _suppressSessionListUpdates = false;

  /** Throttles the billing-block recomputation triggered by token usage. */
  private _billingBlockTimer?: ReturnType<typeof setTimeout>;
  private _billingBlockLastRunMs = 0;
  private _billingBlockInFlight = false;
  /** Shared providers used only to read usage for the billing block, keyed by id. */
  private readonly _usageProviders = new Map<string, SessionProviderBase>();
  /** Last quota shown, for the public state file. */
  private _lastQuota: DashboardQuotaState | null = null;
  /** Last billing block computed, for the public state file. */
  private _lastBillingBlock: BillingBlock | null = null;

  /** Event logger reference for toggling from the dashboard */
  private _eventLogger?: SessionEventLogger;

  /** Decision log service for cross-session decision persistence */
  private _decisionLogService?: DecisionLogService;

  /** Handoff service for session context handoff */
  private _handoffService?: HandoffService;

  /** Manages rotating phrase timers */
  private readonly _phrases: PhraseRotationManager;

  /** Plan persistence service for historical plan data */
  private _planPersistenceService?: import('../services/PlanPersistenceService').PlanPersistenceService;

  /** Provider status service for Claude API health */
  private _providerStatusService?: import('../services/ProviderStatusService').ProviderStatusService;

  /** Peak-hours service for Claude Max subscription (promoclock.co) */
  private _peakHoursService?: import('../services/PeakHoursService').PeakHoursService;

  /** Last quota alert emitted into dashboard surfaces */
  private _lastQuotaAlertKey: string | null = null;

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
   * Sets the plan persistence service for historical plan analytics.
   */
  setPlanPersistenceService(
    service: import('../services/PlanPersistenceService').PlanPersistenceService,
  ): void {
    this._planPersistenceService = service;
  }

  /**
   * Sets the provider status service for Claude & OpenAI API health monitoring.
   *
   * Dashboard status cards follow the monitored session provider:
   * - claude-code → Claude status
   * - codex → OpenAI status
   * - opencode → no provider status card
   */
  setProviderStatusService(
    service: import('../services/ProviderStatusService').ProviderStatusService,
  ): void {
    this._providerStatusService = service;
    this._disposables.push(
      service.onStatusUpdate(() => this._syncProviderStatusCards()),
      service.onOpenAIStatusUpdate(() => this._syncProviderStatusCards()),
    );
  }

  /**
   * Sets the peak-hours service. Dashboard surfaces the indicator only when
   * the current inference provider is `claude-max`; off-peak and
   * unavailable states render nothing.
   */
  setPeakHoursService(service: import('../services/PeakHoursService').PeakHoursService): void {
    this._peakHoursService = service;
    this._disposables.push(service.onStatusUpdate(() => this._syncPeakHoursCard()));
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
    decisionLogService?: DecisionLogService,
    private readonly _notificationPersistence?: NotificationPersistenceService,
  ) {
    this._quotaService = quotaService;
    this._historicalDataService = historicalDataService;
    this._guidanceAdvisor = guidanceAdvisor;
    this._sessionAnalyzer = sessionAnalyzer;
    this._authService = authService;
    this._decisionLogService = decisionLogService;
    this._phrases = new PhraseRotationManager((msg) => this._postMessage(msg));
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
      errorDetails: [],
    };

    // Subscribe to session events
    this._disposables.push(
      this._sessionMonitor.onTokenUsage((usage) => this._handleTokenUsage(usage)),
    );

    this._disposables.push(
      this._sessionMonitor.onSessionStart((path) => this._handleSessionStart(path)),
    );

    this._disposables.push(this._sessionMonitor.onSessionEnd(() => this._handleSessionEnd()));

    this._disposables.push(
      this._sessionMonitor.onToolAnalytics((analytics) => this._handleToolAnalytics(analytics)),
    );

    this._disposables.push(
      this._sessionMonitor.onTimelineEvent((event) => this._handleTimelineEvent(event)),
    );

    this._disposables.push(
      this._sessionMonitor.onDiscoveryModeChange((inDiscoveryMode) =>
        this._handleDiscoveryModeChange(inDiscoveryMode),
      ),
    );

    this._disposables.push(
      this._sessionMonitor.onLatencyUpdate((stats) => this._handleLatencyUpdate(stats)),
    );

    this._disposables.push(
      this._sessionMonitor.onCompaction((event) => this._handleCompaction(event)),
    );

    this._disposables.push(this._sessionMonitor.onTruncation(() => this._handleTruncation()));

    // Subscribe to quota updates if service available
    if (this._quotaService) {
      this._disposables.push(
        this._quotaService.onQuotaUpdate((quota) => this._handleQuotaUpdate(quota)),
      );
    }

    // Subscribe to session-based quota updates (e.g., Codex rate_limits)
    this._disposables.push(
      this._sessionMonitor.onQuotaUpdate((quota) => this._handleQuotaUpdate(quota)),
    );

    // Subscribe to notification persistence changes
    if (this._notificationPersistence) {
      this._disposables.push(
        this._notificationPersistence.onDidChange(() => this._sendNotificationHistoryToWebview()),
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
    _token: vscode.CancellationToken,
  ): void {
    this._disposeViewBindings();
    this._view = webviewView;

    // Configure webview options
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'out', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'images'),
      ],
    };

    // Set HTML content
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Chart.js colors are baked into the canvas, so a theme switch needs an
    // explicit nudge. Registered on _viewDisposables, which the existing
    // teardown already clears.
    this._viewDisposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        this._postMessage({ type: 'themeChanged' });
      }),
    );

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (message: DashboardWebviewMessage) => this._handleDashboardWebviewMessage(message),
      undefined,
      this._viewDisposables,
    );

    // Resend state when view becomes visible, manage quota + status refresh
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._sendStateToWebview();
          this._sendSessionList();
          this._sendProviderInfo();
          // Start quota refresh when visible
          this._quotaService?.startRefresh();
          this._providerStatusService?.startRefresh();
          this._peakHoursService?.startRefresh();
          void this._sendBillingBlock();
        } else {
          // Stop quota + status refresh when hidden to save resources
          this._quotaService?.stopRefresh();
          this._providerStatusService?.stopRefresh();
          this._peakHoursService?.stopRefresh();
        }
      },
      undefined,
      this._viewDisposables,
    );

    webviewView.onDidDispose(
      () => {
        if (this._view === webviewView) {
          this._view = undefined;
          this._quotaService?.stopRefresh();
          this._providerStatusService?.stopRefresh();
          this._peakHoursService?.stopRefresh();
          this._phrases.stop();
        }
        this._disposeViewBindings();
      },
      undefined,
      this._viewDisposables,
    );

    // Start quota + status refresh if view is initially visible
    if (webviewView.visible) {
      this._quotaService?.startRefresh();
      this._providerStatusService?.startRefresh();
      this._peakHoursService?.startRefresh();
      void this._sendBillingBlock();
    }

    // Start phrase rotation timers
    this._phrases.start(() => this._state.sessionActive);

    log('Dashboard webview resolved');
  }

  private _disposeViewBindings(): void {
    const bindings = this._viewDisposables;
    this._viewDisposables = [];
    for (const binding of bindings) binding.dispose();
  }

  /**
   * Handles messages from the webview.
   *
   * @param message - Message from webview
   */
  private _handleDashboardWebviewMessage(message: DashboardWebviewMessage): void {
    log(`Dashboard: received message from webview: ${message.type}`);
    switch (message.type) {
      case 'webviewError':
        logError(
          `Dashboard webview error${message.line ? ` (line ${message.line})` : ''}`,
          message.message,
        );
        return;

      case 'webviewReady':
        log('Dashboard webview ready, sending initial state');
        // Always sync from session monitor to get current data
        if (this._sessionMonitor.isActive()) {
          this._syncFromSessionMonitor();
        }
        this._sendStateToWebview();
        this._sendPlanState();
        this._sendBurnRateUpdate();
        this._sendSessionList();
        this._sendProviderInfo();
        this._sendEventLogState();
        // Send provider quota if available (e.g., Codex rate_limits, z.ai API quota)
        void this._sendProviderQuotaToWebview();
        // Send plan history if available
        this._sendPlanHistory();
        void this._sendQuotaHistory();
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
        this._currentHistoricalSeries = message.series ?? 'total';
        this._currentHistoricalProject = message.project ?? null;
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
        this._handleAnalyzeSession().catch((err) => {
          logError('Dashboard: Unhandled error in _handleAnalyzeSession', err);
        });
        break;

      case 'copySuggestion':
        this._handleCopySuggestion(message.text);
        break;

      case 'openInstructionFile':
        this._handleOpenInstructionFile();
        break;

      case 'generateNarrative':
        this._handleGenerateNarrative().catch((err) => {
          logError('Dashboard: Unhandled error in _handleGenerateNarrative', err);
        });
        break;

      case 'requestSessionSummary':
        this._handleRequestSessionSummary();
        break;

      case 'searchTimeline':
        this._handleSearchTimeline(message.query);
        break;

      case 'requestToolCallDetails':
        this._handleToolCallDetails(message.toolName);
        break;

      case 'toggleEventLog': {
        const enabled = message.enabled;
        log(`Dashboard: event log toggled: ${enabled}`);
        vscode.workspace
          .getConfiguration('sidekick')
          .update('enableEventLog', enabled, vscode.ConfigurationTarget.Global);
        if (this._eventLogger) {
          this._sessionMonitor.setEventLogger(enabled ? this._eventLogger : null);
        }
        break;
      }

      case 'searchDecisions':
        this._sendDecisionsToWebview(message.query);
        break;

      case 'generateHandoff':
        this._handleGenerateHandoff().catch((err) => {
          logError('Dashboard: Unhandled error in _handleGenerateHandoff', err);
        });
        break;

      case 'requestNotificationHistory':
        this._sendNotificationHistoryToWebview();
        break;

      case 'markNotificationRead':
        if (this._notificationPersistence) {
          this._notificationPersistence.markRead(message.id);
        }
        break;

      case 'markAllNotificationsRead':
        if (this._notificationPersistence) {
          this._notificationPersistence.markAllRead();
        }
        break;

      case 'clearNotificationHistory':
        if (this._notificationPersistence) {
          this._notificationPersistence.clearAll();
          this._sendNotificationHistoryToWebview();
        }
        break;

      case 'openCliDashboard':
        vscode.commands.executeCommand('sidekick.openCliDashboard');
        break;

      case 'openExternal':
        if (message.url && /^https?:\/\//i.test(message.url)) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
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
    const allEvents = allTimeline.map((e) => ({
      type: e.type as
        | 'user_prompt'
        | 'tool_call'
        | 'tool_result'
        | 'error'
        | 'assistant_response'
        | 'compaction',
      time: new Date(e.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      description: e.description,
      isError: e.metadata?.isError,
      fullText: e.metadata?.fullText,
      noiseLevel: e.noiseLevel,
      isSidechain: e.isSidechain,
      contextBefore: e.metadata?.contextBefore,
      contextAfter: e.metadata?.contextAfter,
      tokensReclaimed: e.metadata?.tokensReclaimed,
    }));

    this._postMessage({
      type: 'updateTimeline',
      events: allEvents,
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
      .filter((tc) => tc.name === toolName)
      .map((tc) => {
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
          errorMessage: tc.errorMessage,
        } as ToolCallDetailDisplay;
      })
      .reverse(); // Most recent first

    this._postMessage({
      type: 'toolCallDetails',
      toolName,
      calls,
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
        error: 'Agent guidance analysis is not available. Please check extension configuration.',
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
          progress.report({
            message: `Using ${inferenceProvider} (${model})... This may take 30-60 seconds.`,
          });

          const result = await this._guidanceAdvisor!.analyze(
            timeoutOverride ? { timeout: timeoutOverride } : undefined,
          );

          if (result.success) {
            const suggestions: ClaudeMdSuggestionDisplay[] = result.suggestions.map((s) => ({
              title: s.title,
              observed: s.observed,
              suggestion: s.suggestion,
              reasoning: s.reasoning,
            }));
            this._postMessage({ type: 'showSuggestions', suggestions });
            log(`Dashboard: Analysis complete, ${suggestions.length} suggestions`);
          } else {
            this._postMessage({
              type: 'suggestionsError',
              error: result.error || 'Analysis failed',
            });
            logError(`Dashboard: Analysis failed: ${result.error}`);
          }
        },
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        const retry = await vscode.window.showWarningMessage(
          `Analysis timed out after ${error.timeoutMs / 1000}s. Try again with a longer timeout?`,
          'Retry (3 min)',
          'Retry (5 min)',
          'Cancel',
        );
        if (retry?.startsWith('Retry')) {
          const newTimeout = retry.includes('3') ? 180000 : 300000;
          return this._handleAnalyzeSession(newTimeout);
        }
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this._postMessage({
        type: 'suggestionsError',
        error: `Analysis failed: ${message}`,
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
        `Create ${target.primaryFile}`,
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
      vscode.window.showWarningMessage(
        'Handoff service is not available. Ensure a workspace is open.',
      );
      return;
    }

    const stats = this._sessionMonitor.getStats();
    const analysisData = this._sessionAnalyzer.getCachedData();
    const summaryData = this._summaryService.generateSummary(
      stats,
      analysisData,
      this._getContextWindowLimit(),
    );

    try {
      const handoffPath = await this._handoffService.generateHandoff(
        summaryData,
        analysisData,
        stats,
      );

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
          'Open Handoff',
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
          'Skip',
        );
        if (action === `Add to ${target.primaryFile}` && wsFolder) {
          const slug = getProjectSlug(wsFolder.uri.fsPath);
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
          progress.report({
            message: `Using ${inferenceProvider} (${model})... This may take 15-30 seconds.`,
          });
          const narrative = await this._summaryService.generateNarrative(
            this._cachedSummary!,
            this._authService!,
            timeoutOverride ? { timeout: timeoutOverride } : undefined,
          );
          this._postMessage({ type: 'sessionNarrative', narrative });
        },
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        const retry = await vscode.window.showWarningMessage(
          `Narrative generation timed out after ${error.timeoutMs / 1000}s. Try again with a longer timeout?`,
          'Retry (3 min)',
          'Retry (5 min)',
          'Cancel',
        );
        if (retry?.startsWith('Retry')) {
          const newTimeout = retry.includes('3') ? 180000 : 300000;
          return this._handleGenerateNarrative(newTimeout);
        }
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this._postMessage({
        type: 'narrativeError',
        error: `Narrative generation failed: ${message}`,
      });
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
    this._cachedSummary = this._summaryService.generateSummary(
      stats,
      analysisData,
      this._getContextWindowLimit(),
    );
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
        quotaState,
      );
      this._postMessage({ type: 'updateAdvancedBurnRate', data: burnData });

      // Tool Efficiency
      const toolEfficiency = this._summaryService.getToolEfficiency(stats);
      this._postMessage({ type: 'updateToolEfficiency', data: toolEfficiency });

      // Context Attribution
      if (this._state.contextAttribution && this._state.contextAttribution.length > 0) {
        this._postMessage({
          type: 'updateContextAttribution',
          attribution: this._state.contextAttribution,
        });
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
   * Builds the History tab summary for a range with the requested series and
   * project filter (see HistoricalSummaryBuilder), plus the quality trend.
   */
  private _buildHistoricalSummary(range: HistoricalRange): HistoricalSummary {
    if (!this._historicalDataService) {
      return {
        range,
        granularity: range === 'today' ? 'hourly' : range === 'all' ? 'monthly' : 'daily',
        dataPoints: [],
        totals: { inputTokens: 0, outputTokens: 0, totalCost: 0, messageCount: 0, sessionCount: 0 },
      };
    }
    const summary = buildHistoricalSummary(this._historicalDataService, range, {
      series: this._currentHistoricalSeries,
      project: this._currentHistoricalProject,
    });
    const latestQuality = this._historicalDataService.getLatestSessionRecord();
    return {
      ...summary,
      qualityTrend: this._historicalDataService.getQualityTrend(),
      latestQuality: latestQuality
        ? { score: latestQuality.qualityScore, factors: latestQuality.qualityFactors }
        : null,
    };
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
        const dataPoints: HistoricalDataPoint[] = days.map((day) => {
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
        // Drilling down from daily to hourly — show hourly breakdown for the day
        const dataPoints = buildHourlyPoints(this._historicalDataService, timestamp);

        const totals = {
          inputTokens: dataPoints.reduce((sum, d) => sum + d.inputTokens, 0),
          outputTokens: dataPoints.reduce((sum, d) => sum + d.outputTokens, 0),
          totalCost: dataPoints.reduce((sum, d) => sum + d.totalCost, 0),
          messageCount: dataPoints.reduce((sum, d) => sum + d.messageCount, 0),
          sessionCount: dataPoints.reduce((sum, d) => sum + d.sessionCount, 0),
        };

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
    // `null` pricing means the model isn't in our catalog (or LiteLLM hydration
    // hasn't happened yet) — contribute 0 to totals and flag it in
    // `unpricedModelIds` so the UI renders "—" instead of "$0".
    let cost: number;
    let priced: boolean;
    if (usage.reportedCost !== undefined && usage.reportedCost > 0) {
      cost = usage.reportedCost;
      priced = true;
    } else {
      const pricing = ModelPricingService.getPricing(usage.model);
      const computed = ModelPricingService.calculateCost(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          reasoningTokens: usage.reasoningTokens,
        },
        pricing,
      );
      if (computed !== null) {
        cost = computed;
        priced = true;
      } else {
        cost = 0;
        priced = false;
      }
    }

    if (!priced) {
      const seen = this._state.unpricedModelIds ?? [];
      if (!seen.includes(usage.model)) {
        this._state.unpricedModelIds = [...seen, usage.model];
      }
    }

    // Update totals
    this._state.totalInputTokens += usage.inputTokens;
    this._state.totalOutputTokens += usage.outputTokens;
    this._state.totalCacheWriteTokens += usage.cacheWriteTokens;
    this._state.totalCacheReadTokens += usage.cacheReadTokens;
    this._state.totalCost += cost;
    this._state.lastUpdated = new Date().toISOString();
    this._state.sessionActive = true;

    // Update model breakdown (keep `priced` sticky: one unpriced event taints
    // the aggregate so the UI shows "—" for the row).
    // Per-model tokens use the shared vocabulary (every billed bucket, cache
    // included) so this row agrees with the aggregator's per-model stats.
    const usageTokens = summarizeTokens(usage).total;
    const existingModel = this._state.modelBreakdown.find((m) => m.model === usage.model);
    if (existingModel) {
      existingModel.calls += 1;
      existingModel.tokens += usageTokens;
      existingModel.cost += cost;
      if (!priced) existingModel.priced = false;
    } else {
      this._state.modelBreakdown.push({
        model: usage.model,
        calls: 1,
        tokens: usageTokens,
        cost: cost,
        priced,
      });
    }

    // Track burn rate on the same total the aggregator samples.
    this._burnRateCalculator.addEvent(usageTokens, usage.timestamp);

    // Update current context size (provider-specific formula).
    // OpenCode emits some assistant step rows with zero token signal; those
    // should not zero out the gauge between real updates.
    const provider = this._sessionMonitor.getProvider();
    const hasContextSignal =
      usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.cacheWriteTokens > 0 ||
      usage.cacheReadTokens > 0 ||
      (usage.reasoningTokens ?? 0) > 0;

    if (hasContextSignal) {
      this._currentContextSize = provider.computeContextSize
        ? provider.computeContextSize(usage)
        : usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
    }

    // Update context usage
    this._updateContextUsage();

    // Send updated state to webview (coalesced)
    this._scheduleFlush('stats', 'burnRate');
    this._scheduleBillingBlockUpdate();
  }

  /** Mark message kinds dirty and arm the trailing flush timer. */
  private _scheduleFlush(...kinds: DashboardFlushKind[]): void {
    for (const kind of kinds) this._dirty.add(kind);
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = undefined;
      this._flushDirty();
    }, DashboardViewProvider.FLUSH_MS);
  }

  /** Post each dirty message once, in a stable order. */
  private _flushDirty(): void {
    const kinds = new Set(this._dirty);
    this._dirty.clear();
    if (kinds.has('stats')) this._sendStateToWebview();
    if (kinds.has('timeline')) this._sendTimelineToWebview();
    if (kinds.has('toolAnalytics')) this._sendToolAnalyticsToWebview();
    if (kinds.has('plan')) this._sendPlanState();
    if (kinds.has('burnRate')) this._sendBurnRateUpdate();
  }

  /**
   * Handles tool analytics updates from SessionMonitor.
   */
  private _handleToolAnalytics(analytics: ToolAnalytics): void {
    this._toolAnalytics.set(analytics.name, analytics);
    this._updateToolAnalyticsState();
    this._scheduleFlush('toolAnalytics', 'plan');
  }

  /**
   * Handles timeline events from SessionMonitor.
   */
  private _handleTimelineEvent(event: TimelineEvent): void {
    // Add to beginning
    this._timeline.unshift(event);

    // Cap at display limit
    if (this._timeline.length > MAX_DISPLAY_TIMELINE) {
      this._timeline = this._timeline.slice(0, MAX_DISPLAY_TIMELINE);
    }

    this._updateTimelineState();
    this._scheduleFlush('timeline');
  }

  /**
   * Converts internal tool analytics to display format.
   */
  private _updateToolAnalyticsState(): void {
    this._state.toolAnalytics = Array.from(this._toolAnalytics.values())
      .map((a) => ({
        name: a.name,
        totalCalls: a.completedCount,
        successRate: a.completedCount > 0 ? (a.successCount / a.completedCount) * 100 : 0,
        avgDuration: a.completedCount > 0 ? Math.round(a.totalDuration / a.completedCount) : 0,
        pendingCount: a.pendingCount,
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls); // Sort by most used
  }

  /**
   * Converts internal timeline to display format.
   */
  private _updateTimelineState(): void {
    this._state.timeline = this._timeline.map((e) => ({
      type: e.type as
        | 'user_prompt'
        | 'tool_call'
        | 'tool_result'
        | 'error'
        | 'assistant_response'
        | 'compaction',
      time: new Date(e.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      description: e.description,
      isError: e.metadata?.isError,
      fullText: e.metadata?.fullText,
      noiseLevel: e.noiseLevel,
      isSidechain: e.isSidechain,
      contextBefore: e.metadata?.contextBefore,
      contextAfter: e.metadata?.contextAfter,
      tokensReclaimed: e.metadata?.tokensReclaimed,
    }));
  }

  /**
   * Sends tool analytics update to webview.
   */
  private _sendToolAnalyticsToWebview(): void {
    this._postMessage({
      type: 'updateToolAnalytics',
      analytics: this._state.toolAnalytics,
    });
  }

  /**
   * Sends timeline update to webview.
   */
  private _sendTimelineToWebview(): void {
    this._postMessage({
      type: 'updateTimeline',
      events: this._state.timeline,
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
    this._state.compactions = [];
    this._state.contextAttribution = [];
    this._state.contextTimeline = [];
    this._state.permissionMode = undefined;
    this._currentContextSize = 0;
    this._syncFromSessionMonitor();

    // Notify webview
    this._postMessage({ type: 'sessionStart', sessionPath });
    this._sendStateToWebview();
    this._sendPlanState();
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
    this._sendSessionList();
  }

  /**
   * Handles quota updates from QuotaService.
   * @param quota - Updated quota state
   */
  private _handleQuotaUpdate(quota: DashboardQuotaState): void {
    const quotaFailure = describeQuotaFailure(quota) ?? undefined;
    this._lastQuota = quota;
    this._postMessage({ type: 'updateQuota', quota, quotaFailure });
    this._maybeEmitQuotaAlert(quota, quotaFailure);
    void this._sendQuotaHistory();
    this._writeStateFile();
  }

  /**
   * Public `state.json` for external tools (tmux, menu bars): written on quota
   * updates and on the billing-block tick, only when something changed.
   */
  private _writeStateFile(): void {
    try {
      const providerId = this._sessionMonitor.getProvider().id;
      const accounts = getActiveAccountStatus(undefined, { selfHeal: false });
      const account =
        providerId === 'codex' && accounts.codex.present
          ? {
              providerId: 'codex' as const,
              id: accounts.codex.accountId ?? null,
              label: accounts.codex.label ?? null,
            }
          : accounts.claude.present
            ? {
                providerId: 'claude-code' as const,
                id: accounts.claude.accountId ?? null,
                label: accounts.claude.label ?? null,
              }
            : null;
      const quota = quotaToStateFile(this._lastQuota);
      writeStateFile({
        writer: 'vscode-dashboard',
        account,
        quota: {
          claude: providerId === 'claude-code' ? quota : null,
          codex: providerId === 'codex' ? quota : null,
        },
        context: {
          usedPercentage: this._state.contextUsagePercent,
          contextWindowSize: this._getContextWindowLimit() || null,
          totalInputTokens:
            this._state.totalInputTokens +
            this._state.totalCacheReadTokens +
            this._state.totalCacheWriteTokens,
          totalOutputTokens: this._state.totalOutputTokens,
        },
        session: {
          sessionId: this._sessionMonitor.getSessionId(),
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
          model: this._state.modelBreakdown[0]?.model ?? null,
          costUsd: this._state.totalCost,
          durationMs: null,
          linesAdded: this._state.fileChangeSummary?.totalAdditions ?? null,
          linesRemoved: this._state.fileChangeSummary?.totalDeletions ?? null,
          promptCacheHitRatio: null,
        },
        billingBlock: billingBlockToStateFile(this._lastBillingBlock),
      });
    } catch (error) {
      logError('Dashboard failed to write state.json', error);
    }
  }

  /** Minimum spacing between billing-block recomputations. */
  private static readonly BILLING_BLOCK_REFRESH_MS = 60_000;

  /**
   * Schedules a billing-block recomputation, at most once per minute. Token
   * usage arrives many times per minute; the collector caches sessions by
   * fingerprint, so a run that finds nothing changed is a few small reads.
   */
  private _scheduleBillingBlockUpdate(): void {
    if (this._billingBlockTimer || !this._view?.visible) return;
    const elapsed = Date.now() - this._billingBlockLastRunMs;
    const delay = Math.max(0, DashboardViewProvider.BILLING_BLOCK_REFRESH_MS - elapsed);
    this._billingBlockTimer = setTimeout(() => {
      this._billingBlockTimer = undefined;
      void this._sendBillingBlock();
    }, delay);
  }

  private _usageProviderFor(id: string): SessionProviderBase | null {
    const cached = this._usageProviders.get(id);
    if (cached) return cached;
    const created =
      id === 'codex'
        ? new CodexProvider()
        : id === 'opencode'
          ? new OpenCodeProvider()
          : id === 'claude-code'
            ? new ClaudeCodeProvider()
            : null;
    if (created) this._usageProviders.set(id, created);
    return created;
  }

  /**
   * Computes the active five-hour billing block from session logs (a local
   * estimate) and pairs it with the official status-line sample when one has
   * been persisted, then posts both to the webview.
   */
  private async _sendBillingBlock(): Promise<void> {
    if (this._billingBlockInFlight) return;
    this._billingBlockInFlight = true;
    this._billingBlockLastRunMs = Date.now();
    try {
      const providerId = this._sessionMonitor.getProvider().id;
      const provider = this._usageProviderFor(providerId);
      if (!provider) return;
      const now = new Date();
      const collected = await collectUsageEvents({
        providers: [provider],
        since: new Date(now.getTime() - 2 * BILLING_BLOCK_DURATION_MS),
        until: now,
      });
      const block = findActiveBillingBlock(computeBillingBlocks(collected.events, { now }));

      let official: BillingBlockOfficialSample | null = null;
      if (providerId === 'claude-code' || providerId === 'codex') {
        const quota = await resolveQuota({ providerId, allowApi: false, selfHeal: false });
        if (quota.available && quota.capturedSource === 'statusline') {
          official = {
            fiveHourUtilization: quota.fiveHour.utilization,
            fiveHourResetsAt: quota.fiveHour.resetsAt,
            sevenDayUtilization: quota.sevenDay.utilization,
            capturedAt: quota.capturedAt,
            ageMs: quota.ageMs,
          };
        }
      }
      this._lastBillingBlock = block;
      this._postMessage({ type: 'updateBillingBlock', block, official });
      this._writeStateFile();
    } catch (error) {
      logError('Dashboard failed to compute the billing block', error);
    } finally {
      this._billingBlockInFlight = false;
    }
  }

  /**
   * First quota paint for the active session provider, through the shared
   * resolver so the card agrees with `sidekick quota` and the MCP facts server:
   * a fresh status-line, session, or API sample is shown without a network
   * round trip; otherwise the resolver falls through to the API and then to an
   * older snapshot labelled by age.
   */
  private async _sendProviderQuotaToWebview(): Promise<void> {
    const provider = this._sessionMonitor.getProvider();
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    try {
      if (provider.id === 'codex') {
        this._handleQuotaUpdate(await resolveQuota({ providerId: 'codex', workspacePath }));
        return;
      }

      const sessionQuota = await Promise.resolve(provider.getQuotaFromSession?.() ?? null);
      if (sessionQuota) {
        this._handleQuotaUpdate(sessionQuota);
        return;
      }

      if (this._quotaService && provider.id === 'claude-code') {
        // The poller's first live fetch follows immediately, so this paint only
        // uses local samples (no API call) and never overwrites a cached value
        // with an "unavailable" placeholder.
        const local = await resolveQuota({
          providerId: 'claude-code',
          workspacePath,
          allowApi: false,
        });
        const cached = this._quotaService.getCachedQuota();
        if (local.available) {
          this._handleQuotaUpdate(local);
        } else if (cached) {
          this._handleQuotaUpdate(cached);
        }
        this._quotaService.startRefresh();
        return;
      }

      this._handleQuotaUpdate({
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
      });
    } catch (error) {
      logError('Dashboard failed to resolve provider quota', error);
    }
  }

  /**
   * Reads daily-bucket quota history for both providers in the current workspace
   * and posts a {@link QuotaHistoryPayload} to the webview heatmap.
   *
   * No-op when no workspace is open or when both providers have empty history.
   */
  private async _sendQuotaHistory(): Promise<void> {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) return;
    const weeks = 13;
    const toMs = Date.now();
    // -1 because readQuotaHistoryDailyBuckets emits inclusive endpoints (start..end ⇒ end-start+1 buckets).
    const fromMs = toMs - (weeks * 7 - 1) * 86_400_000;
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    try {
      const [claude, codex, zai] = await Promise.all([
        readQuotaHistoryDailyBuckets({ workspaceId, provider: 'claude', from, to }),
        readQuotaHistoryDailyBuckets({ workspaceId, provider: 'codex', from, to }),
        readQuotaHistoryDailyBuckets({ workspaceId, provider: 'zai', from, to }),
      ]);
      const toCells = (
        buckets: Awaited<ReturnType<typeof readQuotaHistoryDailyBuckets>>,
      ): QuotaHistoryDailyCell[] =>
        buckets.map((b) => ({
          date: b.date,
          utilization: Math.max(b.maxUtilizationFiveHour, b.maxUtilizationSevenDay),
          unavailable: b.anyUnavailable,
          samples: b.samples,
        }));
      const claudeHasData = claude.some((b) => b.samples > 0);
      const codexHasData = codex.some((b) => b.samples > 0);
      const zaiHasData = zai.some((b) => b.samples > 0);
      const payload: QuotaHistoryPayload = {
        weeks,
        providers: {
          ...(claudeHasData ? { claude: { cells: toCells(claude) } } : {}),
          ...(codexHasData ? { codex: { cells: toCells(codex) } } : {}),
          ...(zaiHasData ? { zai: { cells: toCells(zai) } } : {}),
        },
        generatedAt: new Date().toISOString(),
      };
      this._postMessage({ type: 'updateQuotaHistory', payload });
    } catch (err) {
      log(`Quota history read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _maybeEmitQuotaAlert(
    quota: DashboardQuotaState,
    quotaFailure?: QuotaFailureDisplay,
  ): void {
    const providerId = this._sessionMonitor.getProvider().id;
    // z.ai rides on OpenCode sessions, so an opencode session provider with
    // active z.ai routing also surfaces quota alerts.
    const supportsQuotaAlerts =
      providerId === 'claude-code' || providerId === 'codex' || providerId === 'opencode';
    if (!supportsQuotaAlerts || quota.available || !quotaFailure) {
      this._lastQuotaAlertKey = null;
      return;
    }

    if (this._lastQuotaAlertKey === quotaFailure.alertKey) return;
    this._lastQuotaAlertKey = quotaFailure.alertKey;

    this._postMessage({
      type: 'notification',
      title: quotaFailure.title,
      body: [quotaFailure.message, quotaFailure.detail].filter(Boolean).join(' '),
      severity: quotaFailure.severity,
    });

    this._notificationPersistence?.addNotification({
      triggerId: `quota:${quotaFailure.alertKey}`,
      triggerName: 'Quota status',
      severity: quotaFailure.severity,
      title: quotaFailure.title,
      body: [quotaFailure.message, quotaFailure.detail].filter(Boolean).join(' '),
    });
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
  private _handleCompaction(event: {
    contextBefore: number;
    contextAfter: number;
    tokensReclaimed: number;
    timestamp: Date;
    source: 'reported' | 'heuristic';
  }): void {
    const ledger = calculateCompactionLedger(
      [event],
      this._sessionMonitor.getStatsView().lastModelId,
    );
    const display: CompactionEventDisplay = {
      time: event.timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      contextBefore: event.contextBefore,
      contextAfter: event.contextAfter,
      tokensReclaimed: event.tokensReclaimed,
      reclaimedPercent:
        event.contextBefore > 0
          ? Math.round((event.tokensReclaimed / event.contextBefore) * 100)
          : 0,
      source: event.source,
      reestablishmentCostUsd: ledger.reestablishmentCostUsd,
    };

    if (!this._state.compactions) {
      this._state.compactions = [];
    }
    this._state.compactions.push(display);

    this._postMessage({
      type: 'updateCompactions',
      compactions: this._state.compactions,
    });

    // Also update context health after each compaction
    const stats = this._sessionMonitor.getStatsView();
    this._postMessage({
      type: 'updateContextHealth',
      score: stats.contextHealth,
      compactionCount: stats.compactionEvents?.length ?? 0,
    });
  }

  /**
   * Handles truncation events from SessionMonitor.
   * Posts truncation count and per-tool breakdown to the dashboard.
   */
  private _handleTruncation(): void {
    const stats = this._sessionMonitor.getStatsView();
    const byTool: Array<{ tool: string; count: number }> = [];
    if (stats.truncationEvents) {
      const toolCounts = new Map<string, number>();
      for (const te of stats.truncationEvents) {
        toolCounts.set(te.toolName, (toolCounts.get(te.toolName) || 0) + 1);
      }
      for (const [tool, count] of toolCounts) {
        byTool.push({ tool, count });
      }
    }
    this._postMessage({
      type: 'updateTruncations',
      count: stats.truncationCount,
      byTool,
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
        hasData: false,
      };
    }

    return {
      avgFirstToken: this._formatDuration(stats.avgFirstTokenLatencyMs),
      maxFirstToken: this._formatDuration(stats.maxFirstTokenLatencyMs),
      lastFirstToken:
        stats.lastFirstTokenLatencyMs !== null
          ? this._formatDuration(stats.lastFirstTokenLatencyMs)
          : '-',
      avgTotal: this._formatDuration(stats.avgTotalResponseTimeMs),
      cycleCount: stats.completedCycles,
      hasData: true,
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
    return formatDurationMs(ms);
  }

  /**
   * Syncs state from SessionMonitor stats.
   */
  private _syncFromSessionMonitor(): void {
    const stats: SessionStats = this._sessionMonitor.getStats();

    this._state.compactions = [];
    this._state.contextAttribution = [];
    this._state.contextTimeline = [];
    this._state.permissionMode = undefined;

    log(
      `Sync from SessionMonitor - input: ${stats.totalInputTokens}, output: ${stats.totalOutputTokens}, cacheWrite: ${stats.totalCacheWriteTokens}, cacheRead: ${stats.totalCacheReadTokens}, contextSize: ${stats.currentContextSize}, recentEvents: ${stats.recentUsageEvents.length}`,
    );

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
    const unpricedThisRebuild: string[] = [];

    if (stats.totalReportedCost !== undefined && stats.totalReportedCost > 0) {
      // Use provider-reported cost, distribute proportionally by token count.
      // Provider-reported cost is assumed authoritative — mark each row as priced.
      const totalTokens = Array.from(stats.modelUsage.values()).reduce(
        (sum, u) => sum + u.tokens,
        0,
      );

      stats.modelUsage.forEach((usage, model) => {
        const proportion = totalTokens > 0 ? usage.tokens / totalTokens : 0;
        const cost = stats.totalReportedCost! * proportion;

        this._state.modelBreakdown.push({
          model,
          calls: usage.calls,
          tokens: usage.tokens,
          cost,
          priced: true,
        });

        this._state.totalCost += cost;
      });
    } else {
      stats.modelUsage.forEach((usage, model) => {
        // Honest pricing: null pricing → priced=false, cost=0, row renders as "—".
        const pricing = ModelPricingService.getPricing(model);
        const computed = ModelPricingService.calculateCost(
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            cacheReadTokens: usage.cacheReadTokens,
          },
          pricing,
        );
        const priced = computed !== null;
        const cost = computed ?? 0;
        if (!priced) unpricedThisRebuild.push(model);

        this._state.modelBreakdown.push({
          model,
          calls: usage.calls,
          tokens: usage.tokens,
          cost,
          priced,
        });

        this._state.totalCost += cost;
      });
    }
    this._state.unpricedModelIds = unpricedThisRebuild.length > 0 ? unpricedThisRebuild : undefined;

    // Calculate context window usage (uses _currentContextSize synced above)
    this._updateContextUsage();

    // Sync tool analytics
    this._toolAnalytics = new Map(stats.toolAnalytics);
    this._updateToolAnalyticsState();

    // Sync timeline
    this._timeline = [...stats.timeline].slice(0, MAX_DISPLAY_TIMELINE);
    this._updateTimelineState();

    // Sync error details
    this._state.errorDetails = Array.from(stats.errorDetails.entries()).map(([type, messages]) => ({
      type,
      count: messages.length,
      messages,
    }));

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
      this._state.compactions = stats.compactionEvents.map((e) => ({
        time: e.timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        contextBefore: e.contextBefore,
        contextAfter: e.contextAfter,
        tokensReclaimed: e.tokensReclaimed,
        reclaimedPercent:
          e.contextBefore > 0 ? Math.round((e.tokensReclaimed / e.contextBefore) * 100) : 0,
        source: e.source,
        reestablishmentCostUsd: calculateCompactionLedger([e], stats.lastModelId)
          .reestablishmentCostUsd,
      }));
    }

    // Sync context attribution
    if (stats.contextAttribution) {
      const attr = stats.contextAttribution;
      const total =
        attr.systemPrompt +
        attr.userMessages +
        attr.assistantResponses +
        attr.toolInputs +
        attr.toolOutputs +
        attr.thinking +
        attr.other;

      if (total > 0) {
        this._state.contextAttribution = Object.entries(attr)
          .filter(([, tokens]) => tokens > 0)
          .map(([category, tokens]) => ({
            category: ATTRIBUTION_LABELS[category as AttributionCategory] || category,
            tokens,
            percent: Math.round((tokens / total) * 100),
            // Consumed only as CSS, so a var() reference re-themes for free.
            color: ATTRIBUTION_VARS[category as AttributionCategory]
              ? attributionVarRef(category as AttributionCategory)
              : attributionVarRef('other'),
          }))
          .sort((a, b) => b.tokens - a.tokens);
      }
    }

    // Sync turn attributions
    if (stats.turnAttributions && stats.turnAttributions.length > 0) {
      const turnDisplays = stats.turnAttributions.map((turn) => {
        const bd = turn.breakdown;
        const turnTotal =
          bd.systemPrompt +
          bd.userMessages +
          bd.assistantResponses +
          bd.toolInputs +
          bd.toolOutputs +
          bd.thinking +
          bd.other;
        const categories = Object.entries(bd)
          .filter(([, tokens]) => tokens > 0)
          .map(([cat, tokens]) => ({
            category: ATTRIBUTION_LABELS[cat as AttributionCategory] || cat,
            tokens,
            percent: turnTotal > 0 ? Math.round((tokens / turnTotal) * 100) : 0,
            // The webview re-derives this from the label for its canvas, so
            // this value only has to be a valid CSS color.
            color: ATTRIBUTION_VARS[cat as AttributionCategory]
              ? attributionVarRef(cat as AttributionCategory)
              : attributionVarRef('other'),
          }));

        return {
          turnIndex: turn.turnIndex,
          time: new Date(turn.timestamp).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          }),
          role: turn.role,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          categories,
        };
      });

      this._postMessage({ type: 'updateTurnAttributions', turns: turnDisplays });
    } else {
      this._postMessage({ type: 'updateTurnAttributions', turns: [] });
    }

    // Sync permission mode and context timeline into state
    const aggregatedMetrics = this._sessionMonitor.getAggregatedMetrics?.();
    if (aggregatedMetrics) {
      this._state.permissionMode = aggregatedMetrics.permissionMode ?? undefined;
      this._state.contextTimeline = aggregatedMetrics.contextTimeline ?? [];
      if (aggregatedMetrics.errorRollup.totalFailures > 0) {
        this._state.errorDetails = aggregatedMetrics.errorRollup.byToolCategory.map((entry) => ({
          type: `${entry.tool} · ${entry.category}`,
          count: entry.count,
          messages: [`${entry.count} ${entry.category} failure${entry.count === 1 ? '' : 's'}`],
        }));
      }
    }

    // Sync context waterfall
    {
      const waterfallDisplay = {
        points: (stats.contextTimeline ?? []).map((p) => ({
          time: new Date(p.timestamp).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          }),
          tokens: p.inputTokens,
          turnIndex: p.turnIndex,
        })),
        compactions: (stats.compactionEvents || []).map((c) => ({
          time: c.timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          before: c.contextBefore,
          after: c.contextAfter,
        })),
      };

      this._postMessage({ type: 'updateContextWaterfall', waterfall: waterfallDisplay });
    }

    // Send analytics data (tool frequency, patterns, heatmap)
    if (aggregatedMetrics) {
      this._postMessage({
        type: 'updateAnalytics',
        analytics: {
          toolFrequency: aggregatedMetrics.toolFrequency ?? [],
          wordFrequency: aggregatedMetrics.wordFrequency ?? [],
          patterns: aggregatedMetrics.patterns ?? [],
          heatmapBuckets: aggregatedMetrics.heatmapBuckets ?? [],
        },
      });
    }

    // Send richer panel updates (debounced)
    this._sendRicherPanelUpdates();
  }

  /**
   * Sends notification history to webview.
   */
  private _sendNotificationHistoryToWebview(): void {
    if (!this._notificationPersistence) return;

    const notifications = this._notificationPersistence.getNotifications(50);
    const unreadCount = this._notificationPersistence.getUnreadCount();

    const displays = notifications.map((n) => ({
      id: n.id,
      triggerId: n.triggerId,
      triggerName: n.triggerName,
      severity: n.severity,
      title: n.title,
      body: n.body,
      time: new Date(n.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      isRead: n.isRead,
    }));

    this._postMessage({ type: 'updateNotificationHistory', notifications: displays, unreadCount });
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
    costPerChangedLine: number | null;
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
      totalDeletions,
      costPerChangedLine:
        totalAdditions + totalDeletions > 0
          ? this._state.totalCost / (totalAdditions + totalDeletions)
          : null,
    };
  }

  /**
   * Sends current state to the webview.
   */
  private _sendStateToWebview(): void {
    this._postMessage({ type: 'updateStats', state: statsPayload(this._state) });
  }

  /** Sends plan state only on initialization and plan-relevant events. */
  private _sendPlanState(): void {
    const plan = this._sessionMonitor.getStatsView().planState;
    this._postMessage({
      type: 'updatePlan',
      plan: plan
        ? {
            title: plan.title ?? 'Plan',
            active: plan.active,
            completionRate: plan.completionRate ?? 0,
            totalDurationMs: plan.totalDurationMs,
            steps: plan.steps.map((step) => ({
              id: step.id,
              description: step.description,
              status: step.status,
              phase: step.phase,
              complexity: step.complexity,
              durationMs: step.durationMs,
              tokensUsed: step.tokensUsed,
              toolCalls: step.toolCalls,
              errorMessage: step.errorMessage,
            })),
            rawMarkdown: plan.rawMarkdown,
          }
        : null,
    });
  }

  /**
   * Sends historical plan analytics to the webview.
   */
  private _sendPlanHistory(): void {
    if (!this._planPersistenceService) return;

    const plans = this._planPersistenceService.getPlans();
    if (plans.length === 0) return;

    const completedPlans = plans.filter((p) => p.status === 'completed').length;
    const failedPlans = plans.filter((p) => p.status === 'failed').length;
    const avgCompletionRate = plans.reduce((s, p) => s + p.completionRate, 0) / plans.length;

    const plansWithDuration = plans.filter(
      (p) => p.totalDurationMs != null && p.totalDurationMs > 0,
    );
    const avgDurationMs =
      plansWithDuration.length > 0
        ? plansWithDuration.reduce((s, p) => s + (p.totalDurationMs || 0), 0) /
          plansWithDuration.length
        : 0;

    const avgStepsPerPlan = plans.reduce((s, p) => s + p.steps.length, 0) / plans.length;

    const plansWithTokens = plans.filter((p) => p.totalTokensUsed != null && p.totalTokensUsed > 0);
    const avgTokensPerPlan =
      plansWithTokens.length > 0
        ? plansWithTokens.reduce((s, p) => s + (p.totalTokensUsed || 0), 0) / plansWithTokens.length
        : 0;

    const plansWithCost = plans.filter((p) => p.totalCostUsd != null && p.totalCostUsd > 0);
    const avgCostPerPlan =
      plansWithCost.length > 0
        ? plansWithCost.reduce((s, p) => s + (p.totalCostUsd || 0), 0) / plansWithCost.length
        : 0;

    const recentPlans = plans.slice(0, 10).map((p) => ({
      title: p.title,
      status: p.status,
      completionRate: p.completionRate,
      createdAt: p.createdAt,
      source: p.source,
      stepCount: p.steps.length,
    }));

    this._postMessage({
      type: 'updatePlanHistory',
      history: {
        totalPlans: plans.length,
        completedPlans,
        failedPlans,
        avgCompletionRate,
        avgDurationMs,
        avgStepsPerPlan,
        avgTokensPerPlan,
        avgCostPerPlan,
        recentPlans,
      },
    });
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
    this._sendPlanState();
    this._sendBurnRateUpdate();
    this._sendTimelineToWebview();
    this._sendToolAnalyticsToWebview();
    this._sendSessionList();
    this._sendProviderInfo();

    void this._sendProviderQuotaToWebview();
  }

  /**
   * Sends burn rate and session timing update to the webview.
   */
  private _sendBurnRateUpdate(): void {
    const stats = this._sessionMonitor.getStatsView();
    this._postMessage({
      type: 'updateBurnRate',
      burnRate: this._burnRateCalculator.calculateBurnRate(),
      sessionStartTime: stats.sessionStartTime?.toISOString() ?? null,
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
      customPathDisplay: customPath ? this._getShortPath(customPath) : null,
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
      displayName: provider.displayName,
    });
    this._syncProviderStatusCards();
    this._syncPeakHoursCard();
  }

  /**
   * Sends the current event log enabled state to the webview.
   */
  private _sendEventLogState(): void {
    const enabled = vscode.workspace
      .getConfiguration('sidekick')
      .get<boolean>('enableEventLog', false);
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
      .replace(/</g, '\\u003c') // Prevents </script> breaking HTML parser
      .replace(/>/g, '\\u003e') // Prevents --> breaking HTML comments
      .replace(/\u2028/g, '\\u2028') // Line separator (breaks JS strings)
      .replace(/\u2029/g, '\\u2029'); // Paragraph separator (breaks JS strings)
  }

  /**
   * Gets the context window limit from the session provider.
   */
  private _getContextWindowLimit(): number {
    const provider = this._sessionMonitor.getProvider();
    return provider.getContextWindowLimit?.(this._lastModelId) ?? DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * Updates context window usage percentage.
   * Uses the actual context size from the most recent message, not cumulative tokens.
   */
  private _updateContextUsage(): void {
    // Context window = actual tokens in context from most recent message
    // This is input + cache_write + cache_read tokens
    this._state.contextUsagePercent =
      (this._currentContextSize / this._getContextWindowLimit()) * 100;
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
   * Sends provider-scoped status cards to the webview and clears stale cards.
   */
  private _syncProviderStatusCards(): void {
    const providerId = this._sessionMonitor.getProvider().id as DashboardSessionProviderId;
    const { claude, openai } = scopeProviderStatuses(
      providerId,
      this._providerStatusService?.getCachedStatus(),
      this._providerStatusService?.getCachedOpenAIStatus(),
    );

    this._postMessage({
      type: 'updateProviderStatus',
      display: formatProviderStatusDisplay('Claude', claude),
    });
    this._postMessage({
      type: 'updateOpenAIStatus',
      display: formatProviderStatusDisplay('OpenAI', openai),
    });
  }

  /**
   * Posts the current peak-hours state to the webview. Pushes `null` when
   * gated off (wrong provider, setting disabled, or fetch unavailable) so
   * the UI clears any stale pill.
   */
  private _syncPeakHoursCard(): void {
    const providerId = this._sessionMonitor.getProvider().id;
    const status = scopePeakHoursToSessionProvider(
      providerId,
      this._peakHoursService?.getCachedStatus() ?? null,
    );
    this._postMessage({ type: 'updatePeakHours', status });
  }

  /**
   * Generates HTML content for the webview.
   *
   * @param webview - The webview to generate HTML for
   * @returns HTML string for the webview
   */
  /** Parsed changelog, read once. */
  private _getChangelogEntries(): ChangelogEntry[] {
    if (this._changelogEntries) return this._changelogEntries;
    try {
      const raw = fs.readFileSync(path.join(this._extensionUri.fsPath, 'CHANGELOG.md'), 'utf-8');
      this._changelogEntries = parseChangelog(raw, 5);
    } catch {
      /* graceful fallback — no modal available */
      this._changelogEntries = [];
    }
    return this._changelogEntries;
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const webviewUri = (...segments: string[]): string =>
      String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...segments)));

    // Version badge + modal. Cached on the instance: this is a shipped
    // extension asset, immutable for the process lifetime, and the read was
    // happening on every resolve — including every collapse/expand cycle.
    const changelogEntries = this._getChangelogEntries();
    const extVersion =
      vscode.extensions.getExtension('CesarAndresLopez.sidekick-for-max')?.packageJSON?.version ||
      changelogEntries[0]?.version ||
      '?';
    const extDate = changelogEntries[0]?.date || '';

    // Cheap flags only: the session groups arrive through `updateSessionList`
    // once the webview posts `webviewReady`, so resolving the view no longer
    // walks the session corpus synchronously.
    const initialCustomPath = this._sessionMonitor.getCustomPath();
    const initialProvider = this._sessionMonitor.getProvider();
    const init: DashboardInit = {
      session: {
        groups: null,
        isPinned: this._sessionMonitor.isPinned(),
        isUsingCustomPath: this._sessionMonitor.isUsingCustomPath(),
        customPathDisplay: initialCustomPath ? this._getShortPath(initialCustomPath) : null,
        providerId: initialProvider.id,
        providerName: initialProvider.displayName,
      },
      changelog: changelogEntries,
      attributionVars: attributionVarsByLabel(),
    };

    return renderDashboardHtml({
      nonce,
      cspSource: webview.cspSource,
      chartjsUri: webviewUri('out', 'webview', 'chartjs-vendor.js'),
      scriptUri: webviewUri('out', 'webview', 'dashboard.js'),
      iconUri: webviewUri('images', 'icon.png'),
      extVersion,
      extDate,
      initJson: this._safeJsonForScript(init),
    });
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    // Final extraction as safety net before teardown
    try {
      this._extractAndPersistDecisions();
    } catch {
      // Best-effort — don't block dispose
    }
    if (this._richerPanelTimer) {
      clearTimeout(this._richerPanelTimer);
    }
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = undefined;
    }
    this._dirty.clear();
    if (this._billingBlockTimer) {
      clearTimeout(this._billingBlockTimer);
      this._billingBlockTimer = undefined;
    }
    for (const provider of this._usageProviders.values()) provider.dispose();
    this._usageProviders.clear();
    this._phrases.stop();
    this._disposeViewBindings();
    this._view = undefined;
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
    log('DashboardViewProvider disposed');
  }
}
