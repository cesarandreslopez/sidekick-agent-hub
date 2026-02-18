/**
 * @fileoverview Session monitoring service for Claude Code sessions.
 *
 * This module provides real-time monitoring of Claude Code session files
 * using Node.js fs.watch. It watches JSONL files outside the workspace,
 * parses events incrementally, and emits structured events for consumption
 * by the dashboard and status bar.
 *
 * Key features:
 * - Detects active Claude Code sessions for workspace
 * - Watches session files using fs.watch (required for files outside workspace)
 * - Parses events incrementally as file grows
 * - Emits token usage and tool call events
 * - Tracks session statistics
 * - Handles missing/deleted sessions gracefully
 *
 * @module services/SessionMonitor
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import type { SessionGroup, SessionInfo, QuotaState } from '../types/dashboard';
import { extractTokenUsage } from './JsonlParser';
import type { SessionProvider, SessionReader } from '../types/sessionProvider';
import { ClaudeSessionEvent, TokenUsage, ToolCall, SessionStats, ToolAnalytics, TimelineEvent, PendingToolCall, SubagentStats, TaskState, TrackedTask, TaskStatus, PendingUserRequest, ResponseLatency, LatencyStats, CompactionEvent, ContextAttribution, PlanState, PlanStep } from '../types/claudeSession';
import { SessionSummary, ModelUsageRecord, ToolUsageRecord, createEmptyTokenTotals } from '../types/historicalData';
import { estimateTokens } from '../utils/tokenEstimator';
import { ModelPricingService } from './ModelPricingService';
import { log, logError } from './Logger';
import { extractTaskIdFromResult } from '../utils/taskHelpers';
import { parsePlanMarkdown, extractProposedPlan } from '../utils/planParser';
import type { SessionEventLogger } from './SessionEventLogger';

/**
 * Session monitoring service for Claude Code sessions.
 *
 * Watches Claude Code session files using Node.js fs.watch and emits
 * parsed events for external consumers. Handles incremental file reading,
 * session detection, and proper resource cleanup.
 *
 * @example
 * ```typescript
 * const monitor = new SessionMonitor();
 *
 * // Subscribe to token usage events
 * monitor.onTokenUsage(usage => {
 *   console.log(`Tokens: ${usage.inputTokens} in, ${usage.outputTokens} out`);
 *   console.log(`Model: ${usage.model}`);
 * });
 *
 * // Subscribe to tool calls
 * monitor.onToolCall(call => {
 *   console.log(`Tool: ${call.name}`);
 * });
 *
 * // Start monitoring
 * const active = await monitor.start('/path/to/workspace');
 * if (active) {
 *   console.log('Session monitoring active');
 * }
 *
 * // Check statistics
 * const stats = monitor.getStats();
 * console.log(`Total tokens: ${stats.totalInputTokens + stats.totalOutputTokens}`);
 *
 * // Clean up when done
 * monitor.dispose();
 * ```
 */
/** Storage key for persisted custom session path */
const CUSTOM_SESSION_PATH_KEY = 'sidekick.customSessionPath';

/** Type guard for content blocks with a `type` string property */
function isTypedBlock(block: unknown): block is Record<string, unknown> & { type: string } {
  return block !== null && typeof block === 'object' && typeof (block as Record<string, unknown>).type === 'string';
}

/**
 * Parses dependency references from a todo item's content text.
 *
 * Looks for patterns like "(blocked by Task A and Task B)" and maps
 * referenced task names back to todo-{i} IDs by substring matching.
 *
 * @param content - The todo item's content text
 * @param allTodos - All todo items from the TodoWrite input
 * @returns Array of todo-{i} task IDs that this task depends on
 */
export function parseTodoDependencies(
  content: string,
  allTodos: Array<Record<string, unknown>>
): string[] {
  const depPattern = /(?:blocked by|depends on|waiting on|requires)\s+(.+?)(?:\)|$)/i;
  const match = content.match(depPattern);
  if (!match) return [];

  // Split matched refs on common separators
  const refs = match[1].split(/\s+and\s+|,\s*|&\s*/).map(r => r.trim()).filter(Boolean);
  const result: string[] = [];

  for (const ref of refs) {
    const refLower = ref.toLowerCase();
    // Try to match against other todos' content
    for (let j = 0; j < allTodos.length; j++) {
      const otherContent = String(allTodos[j].content || allTodos[j].subject || '').toLowerCase();
      // Substring match: the reference should appear in the other task's content,
      // or the other task's content should start with the reference
      if (otherContent.includes(refLower) || refLower.includes(otherContent.split(':')[0].trim())) {
        result.push(`todo-${j}`);
        break;
      }
    }
  }

  return result;
}

export class SessionMonitor implements vscode.Disposable {
  /** File watcher for session directory */
  private watcher: fs.FSWatcher | undefined;

  /** Current workspace path being monitored */
  private workspacePath: string | null = null;

  /** Session provider for I/O operations */
  private provider: SessionProvider;

  /** Incremental reader for current session */
  private reader: SessionReader | null = null;

  /** Path to current session file */
  private sessionPath: string | null = null;

  /** Custom session directory (overrides workspace-based discovery) */
  private customSessionDir: string | null = null;

  /** Workspace state for persistence */
  private readonly workspaceState: vscode.Memento | undefined;

  /** Accumulated session statistics */
  private stats: SessionStats;

  /** Pending tool calls awaiting results */
  private pendingToolCalls: Map<string, PendingToolCall> = new Map();

  /** Per-tool analytics */
  private toolAnalyticsMap: Map<string, ToolAnalytics> = new Map();

  /** Session timeline (capped at 100 events) */
  private timeline: TimelineEvent[] = [];

  /** Error details by type (stores messages for display) */
  private errorDetails: Map<string, string[]> = new Map();

  /** Maximum timeline events to store */
  private readonly MAX_TIMELINE_EVENTS = 100;

  /** Current context window size (from most recent assistant message) */
  private currentContextSize: number = 0;

  /** Most recently observed model ID */
  private lastModelId: string | null = null;

  /** Accumulated cost reported by the provider (e.g., OpenCode per-message cost) */
  private totalReportedCost: number = 0;

  /** Recent usage events for burn rate calculation (keeps last 5 minutes worth) */
  private recentUsageEvents: Array<{ timestamp: Date; tokens: number }> = [];

  /** How long to keep usage events for burn rate (5 minutes) */
  private readonly USAGE_EVENT_WINDOW_MS = 5 * 60 * 1000;

  /** When the session started (first event timestamp) */
  private sessionStartTime: Date | null = null;

  /** Subagent statistics from subagent JSONL files */
  private _subagentStats: SubagentStats[] = [];

  /** Session ID for subagent scanning */
  private sessionId: string | null = null;

  /** Set of event hashes for deduplication */
  private seenHashes: Set<string> = new Set();

  /** Maximum number of hashes to track before pruning */
  private readonly MAX_SEEN_HASHES = 10000;

  /** Task tracking state */
  private taskState: TaskState = {
    tasks: new Map(),
    activeTaskId: null
  };

  /** Pending TaskCreate calls awaiting results (tool_use_id -> TaskCreate input) */
  private pendingTaskCreates: Map<string, {
    subject: string;
    description?: string;
    activeForm?: string;
    timestamp: Date;
  }> = new Map();

  /** Task-related tool names */
  private static readonly TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'Task', 'TodoWrite', 'TodoRead', 'UpdatePlan', 'EnterPlanMode', 'ExitPlanMode'];

  /** Creates an empty context attribution object */
  private static emptyAttribution(): ContextAttribution {
    return {
      systemPrompt: 0,
      userMessages: 0,
      assistantResponses: 0,
      toolInputs: 0,
      toolOutputs: 0,
      thinking: 0,
      other: 0
    };
  }

  /** Pending user request awaiting assistant response */
  private pendingUserRequest: PendingUserRequest | null = null;

  /** Recent latency records (capped at MAX_LATENCY_RECORDS) */
  private latencyRecords: ResponseLatency[] = [];

  /** Maximum number of latency records to keep */
  private readonly MAX_LATENCY_RECORDS = 100;

  /** Timeout for stale pending requests (10 minutes) */
  private readonly STALE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

  /** Compaction events detected during session */
  private compactionEvents: CompactionEvent[] = [];

  /** Context token attribution breakdown */
  private contextAttribution: ContextAttribution = SessionMonitor.emptyAttribution();

  /** Previous context size (for compaction delta detection) */
  private previousContextSize: number = 0;

  /** Optional event logger for JSONL audit trail */
  private eventLogger: SessionEventLogger | null = null;

  /** Assistant text snippets for decision extraction (capped at 200) */
  private assistantTexts: Array<{ text: string; timestamp: string }> = [];
  private readonly MAX_ASSISTANT_TEXTS = 200;
  private readonly MAX_ASSISTANT_TEXT_LENGTH = 500;

  /** Plan state tracking */
  private planState: PlanState | null = null;
  private planModeActive = false;
  private planModeEnteredAt: Date | null = null;
  private planAssistantTexts: string[] = [];

  // Event emitters for external consumers
  private readonly _onTokenUsage = new vscode.EventEmitter<TokenUsage>();
  private readonly _onToolCall = new vscode.EventEmitter<ToolCall>();
  private readonly _onSessionStart = new vscode.EventEmitter<string>();
  private readonly _onSessionEnd = new vscode.EventEmitter<void>();
  private readonly _onToolAnalytics = new vscode.EventEmitter<ToolAnalytics>();
  private readonly _onTimelineEvent = new vscode.EventEmitter<TimelineEvent>();
  private readonly _onDiscoveryModeChange = new vscode.EventEmitter<boolean>();
  private readonly _onLatencyUpdate = new vscode.EventEmitter<LatencyStats>();
  private readonly _onCompaction = new vscode.EventEmitter<CompactionEvent>();
  private readonly _onQuotaUpdate = new vscode.EventEmitter<QuotaState>();

  /** Fires when token usage is detected in session */
  readonly onTokenUsage = this._onTokenUsage.event;

  /** Fires when tool call is detected in session */
  readonly onToolCall = this._onToolCall.event;

  /** Fires when session monitoring starts */
  readonly onSessionStart = this._onSessionStart.event;

  /** Fires when session ends or is deleted */
  readonly onSessionEnd = this._onSessionEnd.event;

  /** Fires when tool analytics are updated */
  readonly onToolAnalytics = this._onToolAnalytics.event;

  /** Fires when timeline event is added */
  readonly onTimelineEvent = this._onTimelineEvent.event;

  /** Fires when discovery mode changes (true = waiting for session, false = monitoring active) */
  readonly onDiscoveryModeChange = this._onDiscoveryModeChange.event;

  /** Fires when response latency data is updated */
  readonly onLatencyUpdate = this._onLatencyUpdate.event;

  /** Fires when a context compaction event is detected */
  readonly onCompaction = this._onCompaction.event;

  /** Fires when subscription quota data is available from session provider */
  readonly onQuotaUpdate = this._onQuotaUpdate.event;

  /**
   * Sets or clears the event logger for JSONL audit trail recording.
   *
   * @param logger - Logger instance to enable recording, or null to disable
   */
  setEventLogger(logger: SessionEventLogger | null): void {
    if (this.eventLogger && !logger) {
      this.eventLogger.endSession();
    }
    this.eventLogger = logger;
  }

  /**
   * Creates a new SessionMonitor.
   *
   * Initializes the parser and empty statistics. Call start() to begin monitoring.
   *
   * @param workspaceState - Optional workspace state for persisting custom session path
   */
  constructor(provider: SessionProvider, workspaceState?: vscode.Memento) {
    this.provider = provider;
    this.workspaceState = workspaceState;
    // Load saved custom path on construction
    this.customSessionDir = workspaceState?.get<string>(CUSTOM_SESSION_PATH_KEY) || null;
    // Initialize empty statistics
    this.stats = this.createEmptyStats();
  }

  /**
   * Creates an empty stats object.
   */
  private createEmptyStats(): SessionStats {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      messageCount: 0,
      toolCalls: [],
      modelUsage: new Map(),
      lastUpdated: new Date(),
      toolAnalytics: new Map(),
      timeline: [],
      errorDetails: new Map(),
      currentContextSize: 0,
      lastModelId: undefined,
      recentUsageEvents: [],
      sessionStartTime: null
    };
  }

  /**
   * Starts monitoring for the given workspace.
   *
   * Detects the active Claude Code session, reads initial content,
   * and sets up file watching for incremental updates. Even if no
   * session is found, sets up directory watching and discovery polling
   * to detect new sessions when they appear.
   *
   * @param workspacePath - Absolute path to workspace directory
   * @returns True if session found and monitoring started, false if waiting for session
   *
   * @example
   * ```typescript
   * const monitor = new SessionMonitor();
   * const workspace = vscode.workspace.workspaceFolders?.[0];
   * if (workspace) {
   *   const active = await monitor.start(workspace.uri.fsPath);
   *   if (!active) {
   *     console.log('No active Claude Code session, waiting for one...');
   *   }
   * }
   * ```
   */
  async start(workspacePath: string): Promise<boolean> {
    // Store workspace path for session detection
    this.workspacePath = workspacePath;

    // Log diagnostic information for debugging path resolution issues
    const sessionDir = this.provider.getSessionDirectory(workspacePath);
    log(`Session monitoring starting for workspace: ${workspacePath} (provider: ${this.provider.displayName})`);
    log(`Looking for sessions in: ${sessionDir}`);

    // Find active session
    this.sessionPath = this.provider.findActiveSession(workspacePath);

    // Always set up directory watching, even without an active session
    await this.setupDirectoryWatcher();

    if (!this.sessionPath) {
      log(`No active ${this.provider.displayName} session detected, entering discovery mode`);
      log(`Expected session directory: ${sessionDir}`);
      if (this.provider.id === 'claude-code') {
        log('Tip: Check if ~/.claude/projects/ contains a directory matching your workspace path');
      }
      this.isWaitingForSession = true;
      this._onDiscoveryModeChange.fire(true);
      this.startDiscoveryPolling();
      return false;
    }

    log(`Found ${this.provider.displayName} session: ${this.sessionPath}`);

    try {
      this.isWaitingForSession = false;
      this.sessionId = this.provider.getSessionId(this.sessionPath);
      this.reader = this.provider.createReader(this.sessionPath);

      const usageSnapshot = this.provider.getCurrentUsageSnapshot?.(this.sessionPath);
      if (usageSnapshot) {
        const snapshotContextSize = this.provider.computeContextSize
          ? this.provider.computeContextSize(usageSnapshot)
          : usageSnapshot.inputTokens + usageSnapshot.cacheWriteTokens + usageSnapshot.cacheReadTokens;
        this.currentContextSize = snapshotContextSize;
        this.previousContextSize = snapshotContextSize;
        this.stats.currentContextSize = snapshotContextSize;
        this.lastModelId = usageSnapshot.model;
        this.stats.lastModelId = usageSnapshot.model;
      }

      // Seed context attribution from provider if available (e.g., OpenCode DB)
      const providerAttribution = this.provider.getContextAttribution?.(this.sessionPath);
      if (providerAttribution) {
        this.contextAttribution = providerAttribution;
      }

      // Read existing content
      await this.readInitialContent();

      // Start activity polling for providers without file-level updates
      this.startActivityPolling();

      log('Session monitoring active');

      // Emit session start event
      this._onSessionStart.fire(this.sessionPath);

      return true;
    } catch (error) {
      logError('Failed to start session monitoring', error);
      this.sessionPath = null;
      this.isWaitingForSession = true;
      this._onDiscoveryModeChange.fire(true);
      this.startDiscoveryPolling();
      return false;
    }
  }

  /**
   * Switches the session provider and restarts monitoring.
   *
   * @param newProvider - The new session provider to use
   * @returns True if a session was found and monitoring started
   */
  async switchProvider(newProvider: SessionProvider): Promise<boolean> {
    if (this.provider.id === newProvider.id) {
      // No change needed; dispose the unused provider instance.
      newProvider.dispose();
      return this.isActive();
    }

    log(`Switching session provider: ${this.provider.displayName} -> ${newProvider.displayName}`);

    if (this.sessionPath) {
      this.eventLogger?.endSession();
      this._onSessionEnd.fire();
    }

    if (this.fileChangeDebounceTimer) {
      clearTimeout(this.fileChangeDebounceTimer);
      this.fileChangeDebounceTimer = null;
    }
    if (this.newSessionCheckTimer) {
      clearTimeout(this.newSessionCheckTimer);
      this.newSessionCheckTimer = null;
    }

    this.stopDiscoveryPolling();
    this.stopActivityPolling();

    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.dbWalWatcher) {
      this.dbWalWatcher.close();
      this.dbWalWatcher = undefined;
    }

    this.sessionPath = null;
    this.sessionId = null;
    this.reader = null;
    this._isPinned = false;
    this.pendingToolCalls.clear();
    this.toolAnalyticsMap.clear();
    this.timeline = [];
    this.errorDetails.clear();
    this.currentContextSize = 0;
    this.lastModelId = null;
    this.totalReportedCost = 0;
    this.recentUsageEvents = [];
    this.sessionStartTime = null;
    this._subagentStats = [];
    this.seenHashes.clear();
    this.resetTaskState();
    this.pendingUserRequest = null;
    this.latencyRecords = [];
    this.compactionEvents = [];
    this.assistantTexts = [];
    this.contextAttribution = SessionMonitor.emptyAttribution();
    this.previousContextSize = 0;
    this.stats = this.createEmptyStats();
    this.isWaitingForSession = false;
    this.fastDiscoveryStartTime = null;

    await this.clearCustomPath();

    const oldProvider = this.provider;
    this.provider = newProvider;
    oldProvider.dispose();

    if (!this.workspacePath) {
      return false;
    }

    return this.start(this.workspacePath);
  }

  /**
   * Sets up the directory watcher for the session directory.
   * Creates the watcher even if no session exists yet.
   *
   * For DB-backed providers (OpenCode), watches the database file instead
   * of a session directory, since DB sessions use synthetic paths.
   */
  private async setupDirectoryWatcher(): Promise<void> {
    // Need either customSessionDir or workspacePath
    if (!this.customSessionDir && !this.workspacePath) {
      return;
    }

    // Close existing watchers if any
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.dbWalWatcher) {
      this.dbWalWatcher.close();
      this.dbWalWatcher = undefined;
    }

    // Use custom directory if set, otherwise discover from workspace
    let sessionDir: string;
    if (this.customSessionDir) {
      sessionDir = this.customSessionDir;
    } else {
      sessionDir = this.provider.discoverSessionDirectory(this.workspacePath!) || this.provider.getSessionDirectory(this.workspacePath!);
    }

    // If directory doesn't exist, try watching the DB file for DB-backed providers
    try {
      if (!fs.existsSync(sessionDir)) {
        // For DB-backed providers, watch the database file directly
        if (this.tryWatchDbFile(sessionDir)) {
          return;
        }
        log(`Session directory doesn't exist yet: ${sessionDir}`);
        // Still set up polling - directory will be created when CLI agent starts
        return;
      }
    } catch {
      log('Error checking session directory existence');
      return;
    }

    const currentSessionFile = this.sessionPath ? path.basename(this.sessionPath) : null;

    try {
      this.watcher = fs.watch(
        sessionDir,
        { persistent: false }, // Don't keep Node process alive
        (_eventType, filename) => {
          // React to any session file in the workspace session directory
          if (filename && this.provider.isSessionFile(filename)) {
            if (this.isWaitingForSession) {
              // In discovery mode - any new session file triggers check
              log(`New session file detected while waiting: ${filename}`);
              this.checkForNewerSession();
            } else if (currentSessionFile && filename === currentSessionFile) {
              // Current session file changed - read new content
              this.handleFileChange();
            } else {
              // Different session file changed - might be a new session starting
              this.checkForNewerSession();
            }
          }
        }
      );

      log(`Session directory watcher established: ${sessionDir}`);
    } catch (error) {
      logError('Failed to set up directory watcher', error);
    }
  }

  /** Additional watcher for DB WAL file */
  private dbWalWatcher: fs.FSWatcher | undefined;

  /**
   * Tries to watch a database file for DB-backed providers.
   * Watches both the main DB and WAL file — WAL changes while OpenCode
   * is running, and the main file updates on checkpoint/exit.
   * Returns true if a watcher was successfully set up.
   */
  private tryWatchDbFile(sessionDir: string): boolean {
    // Look for opencode.db in ancestor directories of the synthetic session path
    // Synthetic paths look like: <dataDir>/db-sessions/<projectId>/
    const dbSessionsIdx = sessionDir.indexOf(path.sep + 'db-sessions' + path.sep);
    if (dbSessionsIdx < 0) return false;

    const dataDir = sessionDir.substring(0, dbSessionsIdx);
    const dbPath = path.join(dataDir, 'opencode.db');
    const walPath = dbPath + '-wal';

    if (!fs.existsSync(dbPath)) return false;

    const onDbChange = () => {
      if (this.isWaitingForSession) {
        // In discovery mode — try to find a session in the DB
        this.performSessionDiscovery();
      } else {
        // Session active — check for new events and session switches
        this.handleFileChange();
        this.checkForNewerSession();
      }
    };

    try {
      // Watch the main DB file (updates on checkpoint/exit)
      this.watcher = fs.watch(dbPath, { persistent: false }, onDbChange);
      log(`Database file watcher established: ${dbPath}`);

      // Also watch the WAL file (updates while OpenCode is running)
      if (fs.existsSync(walPath)) {
        this.dbWalWatcher = fs.watch(walPath, { persistent: false }, onDbChange);
        log(`Database WAL watcher established: ${walPath}`);
      } else {
        // WAL might not exist yet — watch the data directory for its creation
        const dirWatcher = fs.watch(dataDir, { persistent: false }, (_event, filename) => {
          if (filename === 'opencode.db-wal' && !this.dbWalWatcher) {
            try {
              this.dbWalWatcher = fs.watch(walPath, { persistent: false }, onDbChange);
              log(`Database WAL watcher established (deferred): ${walPath}`);
              dirWatcher.close();
            } catch {
              // WAL file may have been removed again
            }
          }
        });
        // Store dir watcher for cleanup — reuse dbWalWatcher field temporarily
        this.dbWalWatcher = dirWatcher;
      }

      return true;
    } catch (error) {
      logError('Failed to set up database file watcher', error);
      return false;
    }
  }

  /**
   * Starts polling for OpenCode session activity.
   * OpenCode writes message/part files outside the session directory,
   * so we poll periodically to pick up new events.
   */
  private startActivityPolling(): void {
    this.stopActivityPolling();

    if (this.provider.id !== 'opencode') {
      return;
    }

    if (!this.sessionPath || !this.reader) {
      return;
    }

    this._lastEventTime = Date.now();
    this.opencodePollTimer = setInterval(() => {
      if (!this.sessionPath || !this.reader) return;
      const prevCount = this.stats.messageCount;
      this.processFileChange();
      // Track when we last saw new events
      if (this.stats.messageCount > prevCount) {
        this._lastEventTime = Date.now();
      } else if (Date.now() - this._lastEventTime > this.OPENCODE_INACTIVITY_MS) {
        // No new events for INACTIVITY threshold — check if a newer session exists
        this._checkForNewerSession();
      }
    }, this.OPENCODE_POLL_INTERVAL_MS);
  }

  /**
   * Stops OpenCode activity polling.
   */
  private stopActivityPolling(): void {
    if (this.opencodePollTimer) {
      clearInterval(this.opencodePollTimer);
      this.opencodePollTimer = null;
    }
  }

  /**
   * Checks if a newer OpenCode session exists after inactivity.
   * If a newer session is found, fires session end and switches to it.
   * This ensures persistence handlers run even when OpenCode sessions
   * don't explicitly signal termination.
   */
  private _checkForNewerSession(): void {
    if (!this.sessionPath || !this.workspacePath) return;
    try {
      const latestPath = this.provider.findActiveSession(this.workspacePath);
      if (latestPath && latestPath !== this.sessionPath) {
        log(`Inactivity detected: newer session found, ending current session`);
        this.eventLogger?.endSession();
        this._onSessionEnd.fire();
        this.stopActivityPolling();
        // Switch to the new session
        this.attachToSession(latestPath);
      }
    } catch {
      // Ignore errors during discovery
    }
  }

  /**
   * Starts polling for session discovery.
   * Uses faster polling after a session ends to quickly detect new sessions.
   */
  private startDiscoveryPolling(): void {
    // Stop existing polling
    this.stopDiscoveryPolling();

    const poll = () => {
      this.performSessionDiscovery();

      // Determine next interval
      let interval = this.DISCOVERY_INTERVAL_MS;
      if (this.fastDiscoveryStartTime) {
        const elapsed = Date.now() - this.fastDiscoveryStartTime;
        if (elapsed < this.FAST_DISCOVERY_DURATION_MS) {
          interval = this.FAST_DISCOVERY_INTERVAL_MS;
        } else {
          // Fast discovery period ended, switch to normal
          this.fastDiscoveryStartTime = null;
          log('Fast discovery period ended, switching to normal polling');
        }
      }

      this.discoveryInterval = setTimeout(poll, interval);
    };

    // Start immediately, then continue polling
    const initialInterval = this.fastDiscoveryStartTime
      ? this.FAST_DISCOVERY_INTERVAL_MS
      : this.DISCOVERY_INTERVAL_MS;

    log(`Starting session discovery polling (interval: ${initialInterval}ms)`);
    this.discoveryInterval = setTimeout(poll, initialInterval);
  }

  /**
   * Stops discovery polling.
   */
  private stopDiscoveryPolling(): void {
    if (this.discoveryInterval) {
      clearTimeout(this.discoveryInterval);
      this.discoveryInterval = null;
    }
  }

  /**
   * Performs session discovery check.
   * Called periodically when no active session.
   */
  private performSessionDiscovery(): void {
    // Need either customSessionDir or workspacePath
    if (!this.customSessionDir && !this.workspacePath) {
      return;
    }

    // Use custom directory if set, otherwise discover from workspace
    let sessionDir: string;
    if (this.customSessionDir) {
      sessionDir = this.customSessionDir;
    } else {
      sessionDir = this.provider.discoverSessionDirectory(this.workspacePath!) || this.provider.getSessionDirectory(this.workspacePath!);
    }

    // For file-based providers, wait for the directory to be created on disk.
    // For DB-backed providers (getSessionMetadata), skip this check since
    // session directories are synthetic and never exist on disk.
    if (!fs.existsSync(sessionDir) && !this.provider.getSessionMetadata) {
      return; // Still waiting for CLI agent to create directory
    }

    // Re-setup watcher if we don't have one (directory just appeared)
    if (!this.watcher) {
      this.setupDirectoryWatcher();
    }

    // Look for active session using appropriate discovery method
    let newSessionPath: string | null = null;
    if (this.customSessionDir) {
      // For custom directory, use direct directory scan
      const sessions = this.provider.findSessionsInDirectory(this.customSessionDir);
      newSessionPath = sessions.length > 0 ? sessions[0] : null;
    } else {
      // For workspace-based, use standard discovery
      newSessionPath = this.provider.findActiveSession(this.workspacePath!);
    }

    if (newSessionPath) {
      log(`Discovery found new session: ${newSessionPath}`);
      this.attachToSession(newSessionPath);
    }
  }

  /**
   * Attaches to a discovered session.
   * @param sessionPath - Path to the session file
   */
  private async attachToSession(sessionPath: string): Promise<void> {
    const wasWaiting = this.isWaitingForSession;
    this.sessionPath = sessionPath;
    this.sessionId = this.provider.getSessionId(sessionPath);
    this.isWaitingForSession = false;
    this.fastDiscoveryStartTime = null;
    this.stopDiscoveryPolling();

    // Notify if we were in discovery mode
    if (wasWaiting) {
      this._onDiscoveryModeChange.fire(false);
    }

    // Reset state for new session
    this.reader = this.provider.createReader(sessionPath);
    this.pendingToolCalls.clear();
    this.toolAnalyticsMap.clear();
    this.timeline = [];
    this.errorDetails.clear();
    this.currentContextSize = 0;
    this.lastModelId = null;
    this.totalReportedCost = 0;
    this.recentUsageEvents = [];
    this.sessionStartTime = null;
    this._subagentStats = [];
    this.seenHashes.clear();
    this.resetTaskState();
    this.pendingUserRequest = null;
    this.latencyRecords = [];
    this.compactionEvents = [];
    this.assistantTexts = [];
    this.contextAttribution = SessionMonitor.emptyAttribution();
    this.previousContextSize = 0;

    // Reset statistics
    this.stats = this.createEmptyStats();

    const usageSnapshot = this.provider.getCurrentUsageSnapshot?.(sessionPath);
    if (usageSnapshot) {
      const snapshotContextSize = this.provider.computeContextSize
        ? this.provider.computeContextSize(usageSnapshot)
        : usageSnapshot.inputTokens + usageSnapshot.cacheWriteTokens + usageSnapshot.cacheReadTokens;
      this.currentContextSize = snapshotContextSize;
      this.previousContextSize = snapshotContextSize;
      this.stats.currentContextSize = snapshotContextSize;
      this.lastModelId = usageSnapshot.model;
      this.stats.lastModelId = usageSnapshot.model;
    }

    // Seed context attribution from provider if available
    const providerAttribution = this.provider.getContextAttribution?.(sessionPath);
    if (providerAttribution) {
      this.contextAttribution = providerAttribution;
    }

    // Re-setup watcher to track the new session file
    await this.setupDirectoryWatcher();

    // Read content from session
    try {
      await this.readInitialContent();
      this.startActivityPolling();
      log(`Attached to session: ${sessionPath}`);
      this._onSessionStart.fire(sessionPath);
    } catch (error) {
      logError('Failed to attach to session', error);
      // Fall back to discovery mode
      this.sessionPath = null;
      this.isWaitingForSession = true;
      this.startDiscoveryPolling();
    }
  }

  /**
   * Manually triggers a session refresh/discovery.
   * Useful for users to force detection of new sessions.
   *
   * @returns True if a session was found and attached
   */
  async refreshSession(): Promise<boolean> {
    if (!this.workspacePath) {
      return false;
    }

    log('Manual session refresh triggered');

    const newSessionPath = this.provider.findActiveSession(this.workspacePath);

    if (newSessionPath && newSessionPath !== this.sessionPath) {
      await this.attachToSession(newSessionPath);
      return true;
    } else if (newSessionPath && newSessionPath === this.sessionPath) {
      log('Already monitoring the most recent session');
      return true;
    } else {
      log('No active session found during refresh');
      if (!this.isWaitingForSession) {
        this.isWaitingForSession = true;
        this._onDiscoveryModeChange.fire(true);
        this.startDiscoveryPolling();
      }
      return false;
    }
  }

  /**
   * Returns whether the monitor is waiting for a session to appear.
   */
  isInDiscoveryMode(): boolean {
    return this.isWaitingForSession;
  }

  /**
   * Returns whether the current session is pinned.
   * When pinned, auto-switching to newer sessions is prevented.
   */
  isPinned(): boolean {
    return this._isPinned;
  }

  /**
   * Toggles the pin state for the current session.
   * When pinned, auto-switching to newer sessions is prevented.
   */
  togglePin(): void {
    this._isPinned = !this._isPinned;
    log(`Session pin state: ${this._isPinned ? 'pinned' : 'unpinned'}`);
  }

  /**
   * Checks if actively monitoring a session.
   *
   * @returns True if monitoring is active
   */
  isActive(): boolean {
    return this.sessionPath !== null && this.watcher !== undefined;
  }

  /**
   * Gets the session provider for this monitor.
   */
  getProvider(): SessionProvider {
    return this.provider;
  }

  /**
   * Gets current session statistics.
   *
   * Returns a copy of accumulated statistics including token usage,
   * model breakdown, and tool calls.
   *
   * @returns Copy of current session statistics
   */
  getStats(): SessionStats {
    // Prune old usage events before returning
    this.pruneOldUsageEvents();

    return {
      ...this.stats,
      modelUsage: new Map(this.stats.modelUsage),
      toolCalls: [...this.stats.toolCalls],
      toolAnalytics: new Map(this.toolAnalyticsMap),
      timeline: [...this.timeline],
      errorDetails: new Map(this.errorDetails),
      currentContextSize: this.currentContextSize,
      lastModelId: this.lastModelId ?? undefined,
      recentUsageEvents: [...this.recentUsageEvents],
      sessionStartTime: this.sessionStartTime,
      taskState: this.taskState.tasks.size > 0 ? {
        tasks: new Map(this.taskState.tasks),
        activeTaskId: this.taskState.activeTaskId
      } : undefined,
      latencyStats: this.latencyRecords.length > 0 ? this.getLatencyStats() : undefined,
      compactionEvents: this.compactionEvents.length > 0 ? [...this.compactionEvents] : undefined,
      contextAttribution: { ...this.contextAttribution },
      totalReportedCost: this.totalReportedCost > 0 ? this.totalReportedCost : undefined,
      planState: this.planState ? { ...this.planState, steps: [...this.planState.steps] } : undefined
    };
  }

  /**
   * Removes usage events older than the window (5 minutes).
   */
  private pruneOldUsageEvents(): void {
    const cutoff = new Date(Date.now() - this.USAGE_EVENT_WINDOW_MS);
    this.recentUsageEvents = this.recentUsageEvents.filter(e => e.timestamp >= cutoff);
  }

  /**
   * Gets collected assistant text snippets for decision extraction.
   */
  getAssistantTexts(): Array<{ text: string; timestamp: string }> {
    return [...this.assistantTexts];
  }

  /**
   * Gets path to current session file.
   *
   * @returns Path to session file, or null if not monitoring
   */
  getSessionPath(): string | null {
    return this.sessionPath;
  }

  /**
   * Gets subagent statistics from all subagent JSONL files.
   *
   * Scans the subagents directory for the current session and
   * returns statistics for each subagent found.
   *
   * @returns Array of SubagentStats, empty if no subagents
   */
  getSubagentStats(): SubagentStats[] {
    // Refresh subagent stats before returning
    this.scanSubagents();
    return [...this._subagentStats];
  }

  /**
   * Scans subagent directory and updates cached stats.
   */
  private scanSubagents(): void {
    if (!this.sessionPath || !this.sessionId) {
      this._subagentStats = [];
      return;
    }

    const sessionDir = path.dirname(this.sessionPath);
    this._subagentStats = this.provider.scanSubagents(sessionDir, this.sessionId);
  }

  /**
   * Gets a summary of the current session for historical data aggregation.
   *
   * Returns null if no session is active or no data has been collected.
   * Call this when a session ends to get data for HistoricalDataService.
   *
   * @returns Session summary with tokens, cost, model/tool usage, or null
   */
  getSessionSummary(): SessionSummary | null {
    if (!this.sessionId || !this.sessionStartTime) {
      return null;
    }

    // Build model usage with costs
    const modelUsage: ModelUsageRecord[] = [];
    this.stats.modelUsage.forEach((usage, model) => {
      const pricing = ModelPricingService.getPricing(model);
      const cost = ModelPricingService.calculateCost({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheReadTokens: usage.cacheReadTokens,
      }, pricing);
      modelUsage.push({
        model,
        calls: usage.calls,
        tokens: usage.tokens,
        cost,
      });
    });

    // Build tool usage from analytics
    const toolUsage: ToolUsageRecord[] = [];
    this.toolAnalyticsMap.forEach((analytics, tool) => {
      toolUsage.push({
        tool,
        calls: analytics.successCount + analytics.failureCount,
        successCount: analytics.successCount,
        failureCount: analytics.failureCount,
      });
    });

    // Build token totals
    const tokens = createEmptyTokenTotals();
    tokens.inputTokens = this.stats.totalInputTokens;
    tokens.outputTokens = this.stats.totalOutputTokens;
    tokens.cacheWriteTokens = this.stats.totalCacheWriteTokens;
    tokens.cacheReadTokens = this.stats.totalCacheReadTokens;

    // Calculate total cost from model usage
    const totalCost = modelUsage.reduce((sum, m) => sum + m.cost, 0);

    return {
      sessionId: this.sessionId,
      startTime: this.sessionStartTime.toISOString(),
      endTime: new Date().toISOString(),
      tokens,
      totalCost,
      messageCount: this.stats.messageCount,
      modelUsage,
      toolUsage,
    };
  }

  /**
   * Gets all available sessions for the current workspace.
   *
   * Returns sessions sorted by modification time (most recent first).
   * Each session includes its path, filename, modification time, and
   * whether it's the currently monitored session.
   *
   * @returns Array of session info objects, or empty array if no workspace
   */
  getAvailableSessions(): Array<{
    path: string;
    filename: string;
    modifiedTime: Date;
    isCurrent: boolean;
    label: string | null;
    isActive: boolean;
  }> {
    // Use custom directory if set, otherwise workspace path
    if (!this.customSessionDir && !this.workspacePath) {
      return [];
    }

    try {
      // Get sessions from appropriate directory
      let sessions: string[];
      if (this.customSessionDir) {
        sessions = this.provider.findSessionsInDirectory(this.customSessionDir);
      } else {
        sessions = this.provider.findAllSessions(this.workspacePath!);
      }

      const now = Date.now();
      const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

      return sessions.map(sessionPath => {
        let mtime: Date;
        try {
          mtime = fs.statSync(sessionPath).mtime;
        } catch {
          const meta = this.provider.getSessionMetadata?.(sessionPath);
          if (!meta) return null;
          mtime = meta.mtime;
        }
        return {
          path: sessionPath,
          filename: this.provider.getSessionId(sessionPath),
          modifiedTime: mtime,
          isCurrent: sessionPath === this.sessionPath,
          label: this.provider.extractSessionLabel(sessionPath),
          isActive: (now - mtime.getTime()) < ACTIVE_THRESHOLD_MS
        };
      }).filter((s): s is NonNullable<typeof s> => s !== null);
    } catch (error) {
      logError('Error getting available sessions', error);
      return [];
    }
  }

  /**
   * Switches to monitoring a specific session file.
   *
   * Stops monitoring the current session (if any) and starts monitoring
   * the specified session. Fires sessionEnd for old session and sessionStart
   * for new session.
   *
   * @param sessionPath - Path to the session file to monitor
   * @returns True if switch was successful
   */
  async switchToSession(sessionPath: string): Promise<boolean> {
    if (!fs.existsSync(sessionPath) && !this.provider.getSessionMetadata?.(sessionPath)) {
      logError(`Cannot switch to session: file not found: ${sessionPath}`);
      return false;
    }

    log(`Manually switching to session: ${sessionPath}`);

    // Manual switch unpins
    this._isPinned = false;

    // Use the existing switchToNewSession method
    await this.switchToNewSession(sessionPath);
    return true;
  }

  /**
   * Starts monitoring with a custom session directory.
   *
   * This overrides the normal workspace-based session discovery and monitors
   * sessions from a specific directory. The custom path is persisted across
   * VS Code restarts.
   *
   * @param sessionDirectory - Path to the session directory to monitor
   * @returns True if a session was found and monitoring started
   */
  async startWithCustomPath(sessionDirectory: string): Promise<boolean> {
    if (!fs.existsSync(sessionDirectory) && !this.provider.getSessionMetadata?.(sessionDirectory)) {
      logError(`Custom session directory not found: ${sessionDirectory}`);
      return false;
    }

    log(`Starting with custom session directory: ${sessionDirectory}`);

    // Save the custom path
    this.customSessionDir = sessionDirectory;
    await this.workspaceState?.update(CUSTOM_SESSION_PATH_KEY, sessionDirectory);

    // Set up directory watcher for the custom directory
    await this.setupDirectoryWatcher();

    // Find sessions in the custom directory
    const sessions = this.provider.findSessionsInDirectory(sessionDirectory);
    if (sessions.length === 0) {
      log('No sessions found in custom directory, entering discovery mode');
      this.isWaitingForSession = true;
      this._onDiscoveryModeChange.fire(true);
      // Start polling to detect new sessions
      this.startDiscoveryPolling();
      return false;
    }

    // Attach to the most recent session
    await this.attachToSession(sessions[0]);
    return true;
  }

  /**
   * Gets all sessions from a specific directory.
   *
   * Unlike getAvailableSessions which uses workspace-based discovery,
   * this method accepts a direct path to a session directory.
   *
   * @param sessionDir - Path to the session directory
   * @returns Array of session info objects
   */
  getSessionsFromDirectory(sessionDir: string): Array<{
    path: string;
    filename: string;
    modifiedTime: Date;
    isCurrent: boolean;
    label: string | null;
    isActive: boolean;
  }> {
    try {
      const sessions = this.provider.findSessionsInDirectory(sessionDir);
      const now = Date.now();
      const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;

      return sessions.map(sessionPath => {
        let mtime: Date;
        try {
          mtime = fs.statSync(sessionPath).mtime;
        } catch {
          const meta = this.provider.getSessionMetadata?.(sessionPath);
          if (!meta) return null;
          mtime = meta.mtime;
        }
        return {
          path: sessionPath,
          filename: this.provider.getSessionId(sessionPath),
          modifiedTime: mtime,
          isCurrent: sessionPath === this.sessionPath,
          label: this.provider.extractSessionLabel(sessionPath),
          isActive: (now - mtime.getTime()) < ACTIVE_THRESHOLD_MS
        };
      }).filter((s): s is NonNullable<typeof s> => s !== null);
    } catch (error) {
      logError('Error getting sessions from directory', error);
      return [];
    }
  }

  /**
   * Gets all sessions grouped by project, with proximity tiers.
   *
   * Uses getAllProjectFolders() from SessionPathResolver which already sorts
   * by proximity: exact workspace match -> subdirectories -> recency.
   *
   * Limits to 5 sessions per project, max 3 projects beyond current.
   *
   * @returns Array of session groups with proximity tiers
   */
  getAllSessionsGrouped(): SessionGroup[] {
    const groups: SessionGroup[] = [];
    const now = Date.now();
    const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;
    const MAX_SESSIONS_PER_PROJECT = 5;
    const MAX_OTHER_PROJECTS = 3;


    try {
      // Custom directory overrides workspace-based discovery (same pattern as
      // performNewSessionCheck, performSessionDiscovery, getAvailableSessions)
      if (this.customSessionDir) {
        const sessions = this.provider.findSessionsInDirectory(this.customSessionDir);
        const limited = sessions.slice(0, MAX_SESSIONS_PER_PROJECT);
        const sessionInfos = this.mapSessionPaths(limited, now, ACTIVE_THRESHOLD_MS);
        if (sessionInfos.length > 0) {
          groups.push({
            projectPath: this.customSessionDir,
            displayPath: SessionMonitor.shortenPathForDisplay(this.customSessionDir),
            proximity: 'current',
            sessions: sessionInfos
          });
        }
        return groups;
      }

      const allFolders = this.provider.getAllProjectFolders(this.workspacePath || undefined);

      // Use encoded workspace path for reliable matching
      // (decoded paths are lossy — hyphens in names become indistinguishable from separators)
      const encodedWorkspace = this.workspacePath
        ? this.provider.encodeWorkspacePath(this.workspacePath).toLowerCase()
        : '';

      log(`getAllSessionsGrouped: ${allFolders.length} folders, encodedWorkspace=${encodedWorkspace}, workspacePath=${this.workspacePath}`);

      let otherProjectCount = 0;

      for (const folder of allFolders) {
        const encodedLower = (folder.encodedName || '').toLowerCase();

        // Determine proximity tier using encoded names (lossless comparison)
        let proximity: 'current' | 'related' | 'other';
        if (encodedWorkspace && (encodedLower === encodedWorkspace || encodedLower.startsWith(encodedWorkspace + '-'))) {
          proximity = 'current';
        } else if (encodedWorkspace && this.sharesEncodedPrefix(encodedLower, encodedWorkspace)) {
          proximity = 'related';
        } else {
          proximity = 'other';
        }

        // Limit non-current projects
        if (proximity !== 'current') {
          if (otherProjectCount >= MAX_OTHER_PROJECTS) continue;
          otherProjectCount++;
        }

        // Get sessions for this project
        const sessions = this.provider.findSessionsInDirectory(folder.dir);
        const limitedSessions = sessions.slice(0, MAX_SESSIONS_PER_PROJECT);

        log(`getAllSessionsGrouped: folder=${folder.name}, encoded=${encodedLower}, proximity=${proximity}, sessions=${sessions.length}, limited=${limitedSessions.length}`);

        if (limitedSessions.length === 0) continue;

        const sessionInfos = this.mapSessionPaths(limitedSessions, now, ACTIVE_THRESHOLD_MS);

        log(`getAllSessionsGrouped: mapped ${sessionInfos.length} session infos for ${folder.name}`);

        if (sessionInfos.length === 0) continue;

        groups.push({
          projectPath: folder.name,
          displayPath: SessionMonitor.shortenPathForDisplay(folder.name),
          proximity,
          sessions: sessionInfos
        });
      }
    } catch (error) {
      logError('Error getting grouped sessions', error);
    }

    return groups;
  }

  /**
   * Shortens a path for display by replacing the home directory with ~.
   * Works cross-platform (Linux, macOS, Windows).
   */
  private static shortenPathForDisplay(fullPath: string): string {
    const home = os.homedir();
    if (fullPath.startsWith(home)) {
      return '~' + fullPath.substring(home.length);
    }
    return fullPath;
  }

  /**
   * Maps raw session file paths to SessionInfo objects with metadata.
   */
  private mapSessionPaths(sessionPaths: string[], now: number, activeThresholdMs: number): SessionInfo[] {
    return sessionPaths.map(sessionPath => {
      let mtime: Date;
      try {
        mtime = fs.statSync(sessionPath).mtime;
      } catch {
        const meta = this.provider.getSessionMetadata?.(sessionPath);
        if (!meta) {
          log(`mapSessionPaths: no metadata for ${sessionPath}, filtering out`);
          return null;
        }
        mtime = meta.mtime;
      }
      log(`mapSessionPaths: ${path.basename(sessionPath)} mtime=${mtime.toISOString()}`);
      return {
        path: sessionPath,
        filename: this.provider.getSessionId(sessionPath),
        modifiedTime: mtime.toISOString(),
        isCurrent: sessionPath === this.sessionPath,
        label: this.provider.extractSessionLabel(sessionPath),
        isActive: (now - mtime.getTime()) < activeThresholdMs
      };
    }).filter((s): s is NonNullable<typeof s> => s !== null);
  }

  /**
   * Checks if two encoded directory names share a common prefix.
   * Uses encoded names to avoid lossy decoded path comparison.
   *
   * Splits on hyphens and checks for 3+ common leading segments.
   * E.g., "-home-cal-code-foo" and "-home-cal-code-bar" share "-home-cal-code".
   */
  private sharesEncodedPrefix(encodedA: string, encodedB: string): boolean {
    // Split encoded names — leading hyphen produces empty first element
    const partsA = encodedA.split('-').filter(Boolean);
    const partsB = encodedB.split('-').filter(Boolean);
    let common = 0;
    for (let i = 0; i < Math.min(partsA.length - 1, partsB.length - 1); i++) {
      if (partsA[i] === partsB[i]) {
        common++;
      } else {
        break;
      }
    }
    return common >= 3;
  }

  /**
   * Clears the custom session path and reverts to workspace-based discovery.
   */
  async clearCustomPath(): Promise<void> {
    log('Clearing custom session path');
    this.customSessionDir = null;
    await this.workspaceState?.update(CUSTOM_SESSION_PATH_KEY, undefined);
  }

  /**
   * Gets the current custom session directory path, if set.
   *
   * @returns Custom session directory path, or null if using auto-detect
   */
  getCustomPath(): string | null {
    return this.customSessionDir;
  }

  /**
   * Returns whether the monitor is using a custom session path.
   *
   * @returns True if using custom path, false if using auto-detect
   */
  isUsingCustomPath(): boolean {
    return this.customSessionDir !== null;
  }

  /**
   * Stops monitoring and cleans up resources.
   *
   * Closes file watcher, disposes event emitters, and resets state.
   * Safe to call multiple times.
   */
  dispose(): void {
    // Clear debounce timers
    if (this.fileChangeDebounceTimer) {
      clearTimeout(this.fileChangeDebounceTimer);
      this.fileChangeDebounceTimer = null;
    }
    if (this.newSessionCheckTimer) {
      clearTimeout(this.newSessionCheckTimer);
      this.newSessionCheckTimer = null;
    }

    // Stop discovery polling
    this.stopDiscoveryPolling();
    this.stopActivityPolling();

    // Close file watchers
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.dbWalWatcher) {
      this.dbWalWatcher.close();
      this.dbWalWatcher = undefined;
    }

    // Dispose event emitters
    this._onTokenUsage.dispose();
    this._onToolCall.dispose();
    this._onSessionStart.dispose();
    this._onSessionEnd.dispose();
    this._onToolAnalytics.dispose();
    this._onTimelineEvent.dispose();
    this._onDiscoveryModeChange.dispose();
    this._onLatencyUpdate.dispose();
    this._onCompaction.dispose();
    this._onQuotaUpdate.dispose();

    // Reset state
    this.sessionPath = null;
    this.sessionId = null;
    this.workspacePath = null;
    this.reader = null;
    this.pendingToolCalls.clear();
    this.toolAnalyticsMap.clear();
    this.timeline = [];
    this.errorDetails.clear();
    this.currentContextSize = 0;
    this.totalReportedCost = 0;
    this.recentUsageEvents = [];
    this.sessionStartTime = null;
    this._subagentStats = [];
    this.seenHashes.clear();
    this.isWaitingForSession = false;
    this.fastDiscoveryStartTime = null;
    this._isPinned = false;
    this.resetTaskState();
    this.pendingUserRequest = null;
    this.latencyRecords = [];
    this.compactionEvents = [];
    this.assistantTexts = [];
    this.contextAttribution = SessionMonitor.emptyAttribution();
    this.previousContextSize = 0;

    log('SessionMonitor disposed');
  }

  /**
   * Reads initial content from session file.
   *
   * Parses the entire file to establish initial state, then sets
   * file position for incremental reads.
   */
  private async readInitialContent(): Promise<void> {
    if (!this.sessionPath || !this.reader) {
      return;
    }

    try {
      const events = this.reader.readNew();
      log(`Reading initial content: ${events.length} events`);
      for (const event of events) {
        this.handleEvent(event);
      }
      this.reader.flush();
      log(`Initial content parsed: ${this.reader.getPosition()} position, stats: input=${this.stats.totalInputTokens}, output=${this.stats.totalOutputTokens}`);
    } catch (error) {
      logError('Failed to read initial session content', error);
      throw error;
    }
  }

  /** Debounce timer for file changes */
  private fileChangeDebounceTimer: NodeJS.Timeout | null = null;

  /** Debounce delay to avoid reading mid-write (ms) */
  private readonly FILE_CHANGE_DEBOUNCE_MS = 100;

  /**
   * Handles file change events from watcher.
   *
   * Debounces rapid changes to avoid reading mid-write,
   * then reads new content incrementally.
   */
  private handleFileChange(): void {
    // Debounce to avoid reading while file is being written
    if (this.fileChangeDebounceTimer) {
      clearTimeout(this.fileChangeDebounceTimer);
    }

    this.fileChangeDebounceTimer = setTimeout(() => {
      this.processFileChange();
    }, this.FILE_CHANGE_DEBOUNCE_MS);
  }

  /**
   * Actually processes the file change after debounce.
   */
  private processFileChange(): void {
    if (!this.sessionPath || !this.reader) {
      return;
    }

    try {
      // Check if file still exists
      if (!this.reader.exists()) {
        log('Session file deleted, entering fast discovery mode...');
        this.eventLogger?.endSession();
        this._onSessionEnd.fire();
        this.sessionPath = null;
        this.reader = null;
        this.stopActivityPolling();
        // Enter fast discovery mode to quickly find new session
        this.enterFastDiscoveryMode();
        return;
      }

      const newEvents = this.reader.readNew();

      // Handle file truncation detected by reader
      if (this.reader.wasTruncated()) {
        log('Session file truncated, resetting stats');
        // Reset stats for fresh read
        this.stats.totalInputTokens = 0;
        this.stats.totalOutputTokens = 0;
        this.stats.totalCacheWriteTokens = 0;
        this.stats.totalCacheReadTokens = 0;
        this.stats.messageCount = 0;
        this.currentContextSize = 0;
        this.totalReportedCost = 0;
        this.recentUsageEvents = [];
        this.sessionStartTime = null;
      }

      for (const event of newEvents) {
        this.handleEvent(event);
      }

      // Propagate session-based quota data (e.g., Codex rate_limits)
      if (newEvents.length > 0) {
        const quota = this.provider.getQuotaFromSession?.();
        if (quota) {
          this._onQuotaUpdate.fire(quota);
        }
      }
    } catch (error) {
      logError('Error reading session file changes', error);
      // Don't throw - continue monitoring
    }
  }

  /** Debounce timer for new session checks */
  private newSessionCheckTimer: NodeJS.Timeout | null = null;

  /** Debounce delay for new session detection (ms) */
  private readonly NEW_SESSION_CHECK_DEBOUNCE_MS = 500;

  /** Poll timer for OpenCode session activity */
  private opencodePollTimer: NodeJS.Timeout | null = null;

  /** OpenCode polling interval (ms) */
  private readonly OPENCODE_POLL_INTERVAL_MS = 1500;

  /** Timestamp of last event received during OpenCode polling */
  private _lastEventTime = 0;

  /** Inactivity threshold before triggering session end (ms) */
  private readonly OPENCODE_INACTIVITY_MS = 60_000;

  /** Cooldown period after switching sessions (ms) - prevents rapid bouncing */
  private readonly SESSION_SWITCH_COOLDOWN_MS = 5000;

  /** Timestamp of last session switch */
  private lastSessionSwitchTime = 0;

  /** Discovery interval timer for finding new sessions when none active */
  private discoveryInterval: NodeJS.Timeout | null = null;

  /** Normal discovery interval (30 seconds) */
  private readonly DISCOVERY_INTERVAL_MS = 30 * 1000;

  /** Fast discovery interval after session ends (5 seconds) */
  private readonly FAST_DISCOVERY_INTERVAL_MS = 5 * 1000;

  /** Duration of fast discovery mode (2 minutes) */
  private readonly FAST_DISCOVERY_DURATION_MS = 2 * 60 * 1000;

  /** When fast discovery mode started (null if not in fast mode) */
  private fastDiscoveryStartTime: number | null = null;

  /** Whether we're actively monitoring a session vs waiting for one */
  private isWaitingForSession = false;

  /** Whether the current session is pinned (prevents auto-switching) */
  private _isPinned = false;

  /**
   * Checks if a newer session file exists and switches to it.
   *
   * Debounces to avoid rapid switching when multiple files change.
   */
  private checkForNewerSession(): void {
    // Debounce to avoid rapid switching
    if (this.newSessionCheckTimer) {
      clearTimeout(this.newSessionCheckTimer);
    }

    this.newSessionCheckTimer = setTimeout(() => {
      this.performNewSessionCheck();
    }, this.NEW_SESSION_CHECK_DEBOUNCE_MS);
  }

  /**
   * Actually performs the new session check after debounce.
   */
  private performNewSessionCheck(): void {
    if (!this.customSessionDir && !this.workspacePath) {
      log('performNewSessionCheck: no path configured');
      return;
    }

    // Don't auto-switch when pinned
    if (this._isPinned) {
      log('performNewSessionCheck: session is pinned, skipping');
      return;
    }

    // Don't check if already in discovery mode
    if (this.isWaitingForSession) {
      log('performNewSessionCheck: already in discovery mode');
      return;
    }

    // Enforce cooldown to prevent rapid session bouncing
    const now = Date.now();
    if (now - this.lastSessionSwitchTime < this.SESSION_SWITCH_COOLDOWN_MS) {
      log(`performNewSessionCheck: in cooldown period, skipping (${now - this.lastSessionSwitchTime}ms since last switch)`);
      return;
    }

    try {
      log(`performNewSessionCheck: checking for newer session (current: ${this.sessionPath})`);

      // Use custom directory if set, otherwise use workspace discovery
      let newSessionPath: string | null = null;
      if (this.customSessionDir) {
        const sessions = this.provider.findSessionsInDirectory(this.customSessionDir);
        newSessionPath = sessions.length > 0 ? sessions[0] : null;
      } else {
        newSessionPath = this.provider.findActiveSession(this.workspacePath!);
      }
      log(`performNewSessionCheck: session lookup returned: ${newSessionPath}`);

      // If there's a different active session, switch to it
      if (newSessionPath && newSessionPath !== this.sessionPath) {
        log(`Detected new session: ${newSessionPath}, switching from ${this.sessionPath}`);
        this.switchToNewSession(newSessionPath);
      } else if (!newSessionPath && this.sessionPath) {
        // Current session gone and no new session found
        log('performNewSessionCheck: current session ended, entering fast discovery mode');
        this.eventLogger?.endSession();
        this._onSessionEnd.fire();
        this.sessionPath = null;
        this.enterFastDiscoveryMode();
      } else {
        log('performNewSessionCheck: no newer session found or same session');
      }
    } catch (error) {
      logError('Error checking for new session', error);
    }
  }

  /**
   * Switches monitoring to a new session file.
   *
   * @param newSessionPath - Path to the new session file
   */
  private async switchToNewSession(newSessionPath: string): Promise<void> {
    // Record switch time for cooldown enforcement
    this.lastSessionSwitchTime = Date.now();

    // End current session
    this.eventLogger?.endSession();
    this._onSessionEnd.fire();

    // Use the common attach logic
    await this.attachToSession(newSessionPath);
  }

  /**
   * Enters discovery mode with fast polling.
   * Called when a session ends to quickly detect new sessions.
   */
  private enterFastDiscoveryMode(): void {
    log('Entering fast discovery mode after session end');
    this.stopActivityPolling();
    this.isWaitingForSession = true;
    this.fastDiscoveryStartTime = Date.now();
    this._onDiscoveryModeChange.fire(true);
    this.startDiscoveryPolling();
  }

  /**
   * Generates a hash for event deduplication.
   *
   * Uses event type, timestamp, and message/request IDs to create a unique key.
   *
   * @param event - Session event to hash
   * @returns Hash string for deduplication
   */
  private generateEventHash(event: ClaudeSessionEvent): string {
    const messageId = (event.message as unknown as { id?: string })?.id || '';
    const requestId = (event as unknown as { requestId?: string })?.requestId || '';
    return `${event.type}:${event.timestamp}:${messageId}:${requestId}`;
  }

  /**
   * Checks if an event is a duplicate and tracks it if not.
   *
   * Uses a Set with bounded size to prevent memory leaks.
   * When the set reaches MAX_SEEN_HASHES, prunes the oldest half.
   *
   * @param event - Session event to check
   * @returns True if this event has been seen before
   */
  private isDuplicateEvent(event: ClaudeSessionEvent): boolean {
    const hash = this.generateEventHash(event);

    if (this.seenHashes.has(hash)) {
      return true;
    }

    // Prevent unbounded growth by pruning oldest 25% when limit reached.
    // V8 Sets maintain insertion order, so slicing keeps the most recent entries.
    if (this.seenHashes.size >= this.MAX_SEEN_HASHES) {
      const arr = Array.from(this.seenHashes);
      this.seenHashes = new Set(arr.slice(Math.floor(arr.length / 4)));
    }

    this.seenHashes.add(hash);
    return false;
  }

  /**
   * Handles parsed session events.
   *
   * Extracts token usage and tool calls, updates statistics,
   * and emits events for external consumers.
   *
   * @param event - Parsed session event
   */
  private handleEvent(event: ClaudeSessionEvent): void {
    // Deduplicate events to prevent double-counting when re-reading files
    if (this.isDuplicateEvent(event)) {
      return;
    }

    // Log event to JSONL audit trail (lazy-start on first event)
    if (this.eventLogger) {
      if (!this.eventLogger.isSessionActive() && this.sessionId) {
        this.eventLogger.startSession(this.provider.id, this.sessionId);
      }
      this.eventLogger.logEvent(event);
    }

    // Exclude synthetic provider token-count events from user-facing message count.
    const isSyntheticTokenCount = event.type === 'assistant' &&
      typeof event.message?.id === 'string' &&
      event.message.id.startsWith('token-count-');

    if (!isSyntheticTokenCount) {
      this.stats.messageCount++;
    }
    this.stats.lastUpdated = new Date();

    // Track session start time (first event)
    if (!this.sessionStartTime && event.timestamp) {
      this.sessionStartTime = new Date(event.timestamp);
    }

    // Track latency: user events with actual prompt content start a pending request
    if (event.type === 'user' && this.hasTextContent(event)) {
      // Check if we should discard a stale pending request
      if (this.pendingUserRequest) {
        const elapsed = Date.now() - this.pendingUserRequest.timestamp.getTime();
        if (elapsed > this.STALE_REQUEST_TIMEOUT_MS) {
          log(`Discarding stale pending request after ${elapsed}ms`);
          this.pendingUserRequest = null;
        }
      }

      // Create new pending request for latency tracking
      this.pendingUserRequest = {
        timestamp: new Date(event.timestamp),
        firstResponseReceived: false
      };
    }

    // Track latency: first assistant event with text content marks first token
    if (event.type === 'assistant' && this.pendingUserRequest && !this.pendingUserRequest.firstResponseReceived) {
      if (this.hasTextContent(event)) {
        const responseTimestamp = new Date(event.timestamp);
        const firstTokenLatencyMs = responseTimestamp.getTime() - this.pendingUserRequest.timestamp.getTime();

        this.pendingUserRequest.firstResponseReceived = true;
        this.pendingUserRequest.firstResponseTimestamp = responseTimestamp;
        this.pendingUserRequest.firstTokenLatencyMs = firstTokenLatencyMs;
      }
    }

    // Track latency: assistant event with usage data marks cycle completion
    const usage = extractTokenUsage(event);
    if (usage) {
      // Complete latency cycle if we have a pending request with first response
      if (this.pendingUserRequest && this.pendingUserRequest.firstResponseReceived) {
        const totalResponseTimeMs = new Date(event.timestamp).getTime() - this.pendingUserRequest.timestamp.getTime();

        this.recordLatency({
          firstTokenLatencyMs: this.pendingUserRequest.firstTokenLatencyMs!,
          totalResponseTimeMs,
          requestTimestamp: this.pendingUserRequest.timestamp
        });

        // Clear pending request after recording
        this.pendingUserRequest = null;
      }

      log(`Token usage extracted - input: ${usage.inputTokens}, output: ${usage.outputTokens}, cacheWrite: ${usage.cacheWriteTokens}, cacheRead: ${usage.cacheReadTokens}`);
      this.lastModelId = usage.model;
      this.stats.lastModelId = usage.model;
      // Update statistics
      this.stats.totalInputTokens += usage.inputTokens;
      this.stats.totalOutputTokens += usage.outputTokens;
      this.stats.totalCacheWriteTokens += usage.cacheWriteTokens;
      this.stats.totalCacheReadTokens += usage.cacheReadTokens;

      // Update per-model usage
      const modelStats = this.stats.modelUsage.get(usage.model) || { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
      modelStats.calls++;
      modelStats.tokens += usage.inputTokens + usage.outputTokens;
      modelStats.inputTokens += usage.inputTokens;
      modelStats.outputTokens += usage.outputTokens;
      modelStats.cacheWriteTokens += usage.cacheWriteTokens;
      modelStats.cacheReadTokens += usage.cacheReadTokens;
      this.stats.modelUsage.set(usage.model, modelStats);

      // Update current context window size (provider-specific formula)
      const newContextSize = this.provider.computeContextSize
        ? this.provider.computeContextSize(usage)
        : usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;

      const hasContextSignal = usage.inputTokens > 0
        || usage.outputTokens > 0
        || usage.cacheWriteTokens > 0
        || usage.cacheReadTokens > 0
        || (usage.reasoningTokens ?? 0) > 0;

      if (hasContextSignal) {
        // Detect compaction: significant context size drop (>20% decrease)
        if (this.previousContextSize > 0 && newContextSize < this.previousContextSize * 0.8) {
          const compactionEvent: CompactionEvent = {
            timestamp: new Date(event.timestamp),
            contextBefore: this.previousContextSize,
            contextAfter: newContextSize,
            tokensReclaimed: this.previousContextSize - newContextSize
          };
          this.compactionEvents.push(compactionEvent);
          this._onCompaction.fire(compactionEvent);
          log(`Compaction detected: ${this.previousContextSize} -> ${newContextSize} (reclaimed ${compactionEvent.tokensReclaimed} tokens)`);

          // Add compaction marker to timeline
          this.timeline.unshift({
            type: 'compaction',
            timestamp: event.timestamp,
            description: `Context compacted: ${Math.round(this.previousContextSize / 1000)}K -> ${Math.round(newContextSize / 1000)}K tokens (reclaimed ${Math.round(compactionEvent.tokensReclaimed / 1000)}K)`,
            noiseLevel: 'system',
            metadata: {
              contextBefore: this.previousContextSize,
              contextAfter: newContextSize,
              tokensReclaimed: compactionEvent.tokensReclaimed
            }
          });
          if (this.timeline.length > this.MAX_TIMELINE_EVENTS) {
            this.timeline = this.timeline.slice(0, this.MAX_TIMELINE_EVENTS);
          }
          this._onTimelineEvent.fire(this.timeline[0]);
        }

        this.previousContextSize = newContextSize;
        this.currentContextSize = newContextSize;
      }

      // Track for burn rate calculation (include cache writes as they count toward quota)
      const totalTokensForBurn = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
      this.recentUsageEvents.push({
        timestamp: usage.timestamp,
        tokens: totalTokensForBurn
      });
      this.pruneOldUsageEvents();

      // Accumulate provider-reported cost
      if (usage.reportedCost !== undefined && usage.reportedCost > 0) {
        this.totalReportedCost += usage.reportedCost;
      }

      // Emit event
      this._onTokenUsage.fire(usage);
    }

    // Extract tool_use from assistant message content blocks
    if (event.type === 'assistant' && event.message?.content) {
      this.extractToolUsesFromContent(event.message.content, event.timestamp);

      // Collect assistant text snippets for decision extraction and plan extraction
      if (Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
            const fullText = block.text as string;

            // Decision extraction (capped)
            if (this.assistantTexts.length < this.MAX_ASSISTANT_TEXTS) {
              const text = fullText.length > this.MAX_ASSISTANT_TEXT_LENGTH
                ? fullText.slice(0, this.MAX_ASSISTANT_TEXT_LENGTH)
                : fullText;
              this.assistantTexts.push({ text, timestamp: event.timestamp });
            }

            // Plan mode: accumulate assistant text for later parsing
            if (this.planModeActive) {
              this.planAssistantTexts.push(fullText);
            }

            // Detect <proposed_plan> blocks (OpenCode / Codex)
            const proposedPlan = extractProposedPlan(fullText);
            if (proposedPlan) {
              const parsed = parsePlanMarkdown(proposedPlan);
              const source = this.provider.id === 'opencode' ? 'opencode' as const
                : this.provider.id === 'codex' ? 'codex' as const
                : 'claude-code' as const;
              this.planState = {
                active: false,
                steps: parsed.steps,
                title: parsed.title,
                source,
              };
              log(`Proposed plan extracted: ${parsed.steps.length} steps (${source})`);
            }
          }
        }
      }
    }

    // Extract tool_result from user message content blocks
    if (event.type === 'user' && event.message?.content) {
      this.extractToolResultsFromContent(event.message.content, event.timestamp);
    }

    // Track context token attribution by content category
    this.updateContextAttribution(event);

    // Add to timeline
    this.addTimelineEvent(event);
  }

  /**
   * Checks if a user event contains actual prompt content (not just tool_result).
   *
   * User events that are only tool_result continuations should not start
   * a new latency tracking cycle.
   *
   * @param event - User session event
   * @returns True if event has user prompt text content
   */
  private hasTextContent(event: ClaudeSessionEvent): boolean {
    const content = event.message?.content;
    if (!content) return false;

    if (typeof content === 'string') {
      return content.trim().length > 0;
    }

    if (Array.isArray(content)) {
      return content.some((block: unknown) =>
        isTypedBlock(block) &&
        block.type === 'text' &&
        typeof block.text === 'string' &&
        (block.text as string).trim().length > 0
      );
    }

    return false;
  }

  /**
   * Updates context token attribution based on event content.
   *
   * Classifies event content into categories (system prompt, user messages,
   * assistant responses, tool I/O, thinking) using heuristics and estimates
   * token counts for each category.
   */
  private updateContextAttribution(event: ClaudeSessionEvent): void {
    const content = event.message?.content;
    if (!content) return;

    if (event.type === 'user') {
      // User events may contain: user prompts, tool_results, system-reminders
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isTypedBlock(block)) continue;

          if (block.type === 'tool_result') {
            // Tool result content sent back in user message
            const resultText = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content || '');
            this.contextAttribution.toolOutputs += estimateTokens(resultText);
          } else if (block.type === 'text' && typeof block.text === 'string') {
            const text = block.text as string;
            // Detect system prompt patterns
            if (text.includes('<system-reminder>') || text.includes('CLAUDE.md') ||
                text.includes('# System') || text.includes('<claude_code_instructions>')) {
              this.contextAttribution.systemPrompt += estimateTokens(text);
            } else {
              this.contextAttribution.userMessages += estimateTokens(text);
            }
          }
        }
      } else if (typeof content === 'string') {
        if (content.includes('<system-reminder>') || content.includes('CLAUDE.md')) {
          this.contextAttribution.systemPrompt += estimateTokens(content);
        } else {
          this.contextAttribution.userMessages += estimateTokens(content);
        }
      }
    } else if (event.type === 'assistant') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isTypedBlock(block)) continue;

          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            this.contextAttribution.thinking += estimateTokens(block.thinking as string);
          } else if (block.type === 'tool_use') {
            const inputText = JSON.stringify(block.input || {});
            this.contextAttribution.toolInputs += estimateTokens(inputText);
          } else if (block.type === 'text' && typeof block.text === 'string') {
            this.contextAttribution.assistantResponses += estimateTokens(block.text as string);
          }
        }
      } else if (typeof content === 'string') {
        this.contextAttribution.assistantResponses += estimateTokens(content);
      }
    } else if (event.type === 'summary') {
      // Summary events are compaction markers
      const summaryText = typeof content === 'string' ? content : JSON.stringify(content);
      this.contextAttribution.other += estimateTokens(summaryText);
    }
  }

  /**
   * Records a completed latency measurement.
   *
   * Adds to the latency records array (capped at MAX_LATENCY_RECORDS)
   * and emits a latency update event.
   *
   * @param latency - Response latency data to record
   */
  private recordLatency(latency: ResponseLatency): void {
    this.latencyRecords.push(latency);

    // Cap at MAX_LATENCY_RECORDS
    if (this.latencyRecords.length > this.MAX_LATENCY_RECORDS) {
      this.latencyRecords = this.latencyRecords.slice(-this.MAX_LATENCY_RECORDS);
    }

    // Emit update
    this._onLatencyUpdate.fire(this.getLatencyStats());
  }

  /**
   * Gets current latency statistics.
   *
   * Calculates aggregated latency metrics from recorded data.
   *
   * @returns Aggregated latency statistics
   */
  getLatencyStats(): LatencyStats {
    if (this.latencyRecords.length === 0) {
      return {
        recentLatencies: [],
        avgFirstTokenLatencyMs: 0,
        maxFirstTokenLatencyMs: 0,
        avgTotalResponseTimeMs: 0,
        lastFirstTokenLatencyMs: null,
        completedCycles: 0
      };
    }

    const firstTokenLatencies = this.latencyRecords.map(r => r.firstTokenLatencyMs);
    const totalResponseTimes = this.latencyRecords.map(r => r.totalResponseTimeMs);

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const max = (arr: number[]) => Math.max(...arr);

    return {
      recentLatencies: [...this.latencyRecords],
      avgFirstTokenLatencyMs: avg(firstTokenLatencies),
      maxFirstTokenLatencyMs: max(firstTokenLatencies),
      avgTotalResponseTimeMs: avg(totalResponseTimes),
      lastFirstTokenLatencyMs: firstTokenLatencies[firstTokenLatencies.length - 1],
      completedCycles: this.latencyRecords.length
    };
  }

  /**
   * Categorizes error by type based on output message.
   *
   * @param output - Error output from tool result
   * @returns Error category string
   */
  private categorizeError(output: unknown): string {
    const outputStr = String(output || '').toLowerCase();
    if (outputStr.includes('permission denied')) return 'permission';
    if (outputStr.includes('not found') || outputStr.includes('no such file')) return 'not_found';
    if (outputStr.includes('timeout')) return 'timeout';
    if (outputStr.includes('syntax error')) return 'syntax';
    if (outputStr.includes('exit code')) return 'exit_code';
    if (outputStr.includes('tool_use_error')) return 'tool_error';
    return 'other';
  }

  /**
   * Extracts a readable error message from tool result content.
   *
   * @param content - Tool result content
   * @param toolName - Name of the tool that failed
   * @returns Formatted error message (truncated to 150 chars)
   */
  private extractErrorMessage(content: unknown, toolName: string): string {
    let msg = String(content || 'Unknown error');

    // Clean up common patterns
    msg = msg.replace(/<tool_use_error>|<\/tool_use_error>/g, '');
    msg = msg.trim();

    // Truncate long messages
    if (msg.length > 150) {
      msg = msg.substring(0, 147) + '...';
    }

    return `${toolName}: ${msg}`;
  }

  /**
   * Extracts meaningful context from tool input for timeline display.
   *
   * @param toolName - Name of the tool
   * @param input - Tool input parameters
   * @returns Formatted description with context
   */
  private extractToolContext(toolName: string, input: Record<string, unknown>): string {
    let context = '';

    switch (toolName) {
      case 'Read':
      case 'Write':
      case 'Edit':
        // Show file path (basename for brevity)
        if (input.file_path) {
          const filePath = String(input.file_path);
          const basename = filePath.split('/').pop() || filePath;
          context = basename;
        }
        break;

      case 'Glob':
        // Show pattern and optional path
        if (input.pattern) {
          context = String(input.pattern);
          if (input.path) {
            const pathStr = String(input.path);
            const shortPath = pathStr.split('/').slice(-2).join('/');
            context += ` in ${shortPath}`;
          }
        }
        break;

      case 'Grep':
        // Show pattern
        if (input.pattern) {
          const pattern = String(input.pattern);
          context = pattern.length > 30 ? pattern.substring(0, 27) + '...' : pattern;
        }
        break;

      case 'Bash':
        // Show command (truncated)
        if (input.command) {
          const cmd = String(input.command);
          context = cmd.length > 40 ? cmd.substring(0, 37) + '...' : cmd;
        }
        break;

      case 'Task':
        // Include "subagent spawned" for detection by MindMap and SubagentTreeProvider
        if (input.description) {
          context = `Subagent spawned: ${String(input.description)}`;
        } else if (input.subagent_type) {
          context = `Subagent spawned (${String(input.subagent_type)})`;
        } else {
          context = 'Subagent spawned';
        }
        break;

      case 'WebFetch':
      case 'WebSearch':
        // Show URL or query
        if (input.url) {
          try {
            const url = new URL(String(input.url));
            context = url.hostname;
          } catch {
            context = String(input.url).substring(0, 30);
          }
        } else if (input.query) {
          context = String(input.query);
        }
        break;

      default:
        // For unknown tools, try common input field names
        if (input.file_path) context = String(input.file_path).split('/').pop() || '';
        else if (input.path) context = String(input.path).split('/').pop() || '';
        else if (input.command) context = String(input.command).substring(0, 30);
    }

    // Format: "ToolName: context" or just "ToolName" if no context
    if (context) {
      return `${toolName}: ${context}`;
    }
    return toolName;
  }

  /**
   * Adds event to timeline.
   *
   * @param event - Session event to add to timeline
   */
  private addTimelineEvent(event: ClaudeSessionEvent): void {
    const timelineEvent = this.createTimelineEvent(event);
    if (!timelineEvent) return;

    // Add to beginning (most recent first)
    this.timeline.unshift(timelineEvent);

    // Cap at MAX_TIMELINE_EVENTS
    if (this.timeline.length > this.MAX_TIMELINE_EVENTS) {
      this.timeline = this.timeline.slice(0, this.MAX_TIMELINE_EVENTS);
    }

    this._onTimelineEvent.fire(timelineEvent);
  }

  /**
   * Creates timeline event from session event.
   *
   * @param event - Session event
   * @returns Timeline event or null if not relevant for timeline
   */
  private createTimelineEvent(event: ClaudeSessionEvent): TimelineEvent | null {
    switch (event.type) {
      case 'user': {
        // Extract user prompt text
        const promptText = this.extractUserPromptText(event);
        if (promptText) {
          // Classify noise: tool_result-only user events are system noise
          const noiseLevel = this.classifyUserEventNoise(event);
          return {
            type: 'user_prompt',
            timestamp: event.timestamp,
            description: promptText,
            noiseLevel,
            isSidechain: event.isSidechain,
            metadata: {}
          };
        }
        return null;
      }

      case 'assistant': {
        // Extract assistant response text (skip if only tool_use blocks)
        const responseText = this.extractAssistantResponseText(event);
        if (responseText) {
          return {
            type: 'assistant_response',
            timestamp: event.timestamp,
            description: responseText.truncated,
            noiseLevel: event.isSidechain ? 'noise' : 'ai' as const,
            isSidechain: event.isSidechain,
            metadata: {
              model: event.message?.model,
              fullText: responseText.full !== responseText.truncated ? responseText.full : undefined
            }
          };
        }
        return null;
      }

      case 'tool_use':
        return {
          type: 'tool_call',
          timestamp: event.timestamp,
          description: `Called ${event.tool?.name || 'unknown'}`,
          metadata: { toolName: event.tool?.name }
        };

      case 'tool_result': {
        // Look up tool name from pending calls
        const toolName = event.result?.tool_use_id
          ? this.pendingToolCalls.get(event.result.tool_use_id)?.name || 'Tool'
          : 'Tool';
        return {
          type: event.result?.is_error ? 'error' : 'tool_result',
          timestamp: event.timestamp,
          description: event.result?.is_error
            ? `${toolName} failed`
            : `${toolName} completed`,
          noiseLevel: event.result?.is_error ? 'system' : 'ai' as const,
          isSidechain: event.isSidechain,
          metadata: { isError: event.result?.is_error, toolName }
        };
      }

      case 'summary':
        // Summary events indicate context compaction
        return {
          type: 'compaction' as const,
          timestamp: event.timestamp,
          description: 'Context compacted (summary event)',
          noiseLevel: 'system' as const,
          metadata: {}
        };

      default:
        return null;
    }
  }

  /**
   * Extracts user prompt text from a user event.
   *
   * @param event - User event
   * @returns Prompt text truncated to 100 chars, or null if not extractable
   */
  private extractUserPromptText(event: ClaudeSessionEvent): string | null {
    const content = event.message?.content;
    if (!content) return null;

    let text: string;

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // Content may be array of content blocks
      const textBlock = content.find((c: unknown) => isTypedBlock(c) && c.type === 'text' && typeof c.text === 'string');
      text = (isTypedBlock(textBlock) && typeof textBlock.text === 'string') ? textBlock.text : '';
    } else {
      return null;
    }

    // Clean up and truncate
    text = text.trim().replace(/\s+/g, ' ');
    if (text.length === 0) return null;

    // Truncate to 100 chars with ellipsis
    if (text.length > 100) {
      text = text.substring(0, 97) + '...';
    }

    return text;
  }

  /**
   * Extracts assistant response text from an assistant event.
   * Skips tool_use blocks (those are handled separately).
   *
   * @param event - Assistant event
   * @returns Object with truncated and full text, or null if no text content
   */
  private extractAssistantResponseText(event: ClaudeSessionEvent): { truncated: string; full: string } | null {
    const content = event.message?.content;
    if (!content) return null;

    const textParts: string[] = [];

    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      // Extract only text blocks, skip tool_use blocks
      for (const block of content) {
        if (isTypedBlock(block) && block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
    }

    if (textParts.length === 0) return null;

    // Join multiple text blocks with newlines
    const fullText = textParts.join('\n').trim().replace(/\s+/g, ' ');
    if (fullText.length === 0) return null;

    // Truncate to 150 chars for display
    let truncatedText = fullText;
    if (fullText.length > 150) {
      truncatedText = fullText.substring(0, 147) + '...';
    }

    return { truncated: truncatedText, full: fullText };
  }

  /**
   * Extracts tool_use blocks from message content array.
   *
   * @param content - Message content array
   * @param timestamp - Event timestamp
   */
  private extractToolUsesFromContent(content: unknown, timestamp: string): void {
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (isTypedBlock(block) && block.type === 'tool_use') {
        const toolUse = block as { type: string; id: string; name: string; input: Record<string, unknown> };

        // Store pending call for duration calculation
        this.pendingToolCalls.set(toolUse.id, {
          toolUseId: toolUse.id,
          name: toolUse.name,
          startTime: new Date(timestamp)
        });

        // Handle task-related tools
        this.handleTaskToolUse(toolUse, timestamp);

        // Initialize analytics for this tool if needed
        if (!this.toolAnalyticsMap.has(toolUse.name)) {
          this.toolAnalyticsMap.set(toolUse.name, {
            name: toolUse.name,
            successCount: 0,
            failureCount: 0,
            totalDuration: 0,
            completedCount: 0,
            pendingCount: 0
          });
        }

        // Increment pending count
        const analytics = this.toolAnalyticsMap.get(toolUse.name)!;
        analytics.pendingCount++;

        // Emit analytics update
        this._onToolAnalytics.fire({ ...analytics });

        // Add to timeline with context from tool input
        const toolContext = this.extractToolContext(toolUse.name, toolUse.input);
        this.timeline.unshift({
          type: 'tool_call',
          timestamp,
          description: toolContext,
          metadata: { toolName: toolUse.name }
        });
        if (this.timeline.length > this.MAX_TIMELINE_EVENTS) {
          this.timeline = this.timeline.slice(0, this.MAX_TIMELINE_EVENTS);
        }
        this._onTimelineEvent.fire(this.timeline[0]);

        // Build tool call object
        const rawToolName = typeof toolUse.input?._sidekickRawToolName === 'string'
          ? String(toolUse.input._sidekickRawToolName)
          : undefined;

        const toolCall: ToolCall = {
          name: toolUse.name,
          rawName: rawToolName,
          providerId: this.provider.id,
          input: toolUse.input,
          timestamp: new Date(timestamp)
        };

        // Associate non-task tool calls with active task
        if (!SessionMonitor.TASK_TOOLS.includes(toolUse.name) && this.taskState.activeTaskId) {
          const activeTask = this.taskState.tasks.get(this.taskState.activeTaskId);
          if (activeTask) {
            activeTask.associatedToolCalls.push(toolCall);
          }
        }

        // Emit tool call event
        this._onToolCall.fire(toolCall);
        this.stats.toolCalls.push(toolCall);
      }
    }
  }

  /**
   * Handles task-related tool uses (TaskCreate, TaskUpdate).
   *
   * @param toolUse - Tool use block with name and input
   * @param timestamp - Event timestamp
   */
  private handleTaskToolUse(
    toolUse: { id: string; name: string; input: Record<string, unknown> },
    timestamp: string
  ): void {
    const now = new Date(timestamp);

    if (toolUse.name === 'TaskCreate') {
      // Store pending TaskCreate to correlate with result
      this.pendingTaskCreates.set(toolUse.id, {
        subject: String(toolUse.input.subject || ''),
        description: toolUse.input.description ? String(toolUse.input.description) : undefined,
        activeForm: toolUse.input.activeForm ? String(toolUse.input.activeForm) : undefined,
        timestamp: now
      });
    } else if (toolUse.name === 'Task') {
      // Subagent spawn — create a TrackedTask immediately as in_progress
      const agentTaskId = 'agent-' + toolUse.id;
      const description = toolUse.input.description ? String(toolUse.input.description) : 'Subagent';
      const subagentType = toolUse.input.subagent_type ? String(toolUse.input.subagent_type) : undefined;

      const newTask: TrackedTask = {
        taskId: agentTaskId,
        subject: description,
        status: 'in_progress',
        createdAt: now,
        updatedAt: now,
        activeForm: subagentType ? `Running ${subagentType} agent` : 'Running subagent',
        blockedBy: [],
        blocks: [],
        associatedToolCalls: [],
        isSubagent: true,
        subagentType,
        toolUseId: toolUse.id
      };

      this.taskState.tasks.set(agentTaskId, newTask);
      log(`Subagent spawned: ${agentTaskId} - "${description}" (${subagentType || 'unknown'})`);
    } else if (toolUse.name === 'EnterPlanMode') {
      this.handleEnterPlanMode(now);
    } else if (toolUse.name === 'ExitPlanMode') {
      this.handleExitPlanMode(now);
    } else if (toolUse.name === 'TodoWrite') {
      this.handleTodoWriteToolUse(toolUse, now);
    } else if (toolUse.name === 'UpdatePlan') {
      this.handleUpdatePlanToolUse(toolUse, now);
    } else if (toolUse.name === 'TaskUpdate') {
      const taskId = String(toolUse.input.taskId || '');
      const task = this.taskState.tasks.get(taskId);

      if (task) {
        // Update task fields if provided
        if (toolUse.input.status) {
          const newStatus = toolUse.input.status as TaskStatus;
          const oldStatus = task.status;
          task.status = newStatus;

          // Track active task transitions
          if (newStatus === 'in_progress' && oldStatus !== 'in_progress') {
            this.taskState.activeTaskId = taskId;
          } else if (oldStatus === 'in_progress' && newStatus !== 'in_progress') {
            if (this.taskState.activeTaskId === taskId) {
              this.taskState.activeTaskId = null;
            }
          }
        }
        if (toolUse.input.subject) {
          task.subject = String(toolUse.input.subject);
        }
        if (toolUse.input.description) {
          task.description = String(toolUse.input.description);
        }
        if (toolUse.input.activeForm) {
          task.activeForm = String(toolUse.input.activeForm);
        }
        if (Array.isArray(toolUse.input.addBlockedBy)) {
          for (const id of toolUse.input.addBlockedBy) {
            const idStr = String(id);
            if (!task.blockedBy.includes(idStr)) {
              task.blockedBy.push(idStr);
            }
          }
        }
        if (Array.isArray(toolUse.input.addBlocks)) {
          for (const id of toolUse.input.addBlocks) {
            const idStr = String(id);
            if (!task.blocks.includes(idStr)) {
              task.blocks.push(idStr);
            }
          }
        }
        task.updatedAt = now;
      } else {
        // TaskUpdate for unknown task - create placeholder
        log(`TaskUpdate for unknown task ${taskId}, creating placeholder`);
        const newTask: TrackedTask = {
          taskId,
          subject: toolUse.input.subject ? String(toolUse.input.subject) : `Task ${taskId}`,
          description: toolUse.input.description ? String(toolUse.input.description) : undefined,
          status: (toolUse.input.status as TaskStatus) || 'pending',
          createdAt: now,
          updatedAt: now,
          activeForm: toolUse.input.activeForm ? String(toolUse.input.activeForm) : undefined,
          blockedBy: [],
          blocks: [],
          associatedToolCalls: []
        };
        this.taskState.tasks.set(taskId, newTask);

        // Set active if in_progress
        if (newTask.status === 'in_progress') {
          this.taskState.activeTaskId = taskId;
        }
      }
    }
  }

  /**
   * Handles entering plan mode (Claude Code EnterPlanMode or OpenCode text detection).
   *
   * Starts accumulating assistant text for plan extraction.
   */
  private handleEnterPlanMode(now: Date): void {
    this.planModeActive = true;
    this.planModeEnteredAt = now;
    this.planAssistantTexts = [];

    // Initialize plan state
    this.planState = {
      active: true,
      steps: [],
      enteredAt: now,
      source: this.provider.id === 'opencode' ? 'opencode' : 'claude-code',
    };

    log(`Plan mode entered at ${now.toISOString()} (${this.provider.id})`);
  }

  /**
   * Handles exiting plan mode (Claude Code ExitPlanMode or OpenCode text detection).
   *
   * Parses accumulated assistant text into plan steps.
   */
  private handleExitPlanMode(now: Date): void {
    if (this.planState) {
      this.planState.active = false;
      this.planState.exitedAt = now;

      // Parse accumulated assistant text into steps (if no steps yet from proposed_plan)
      if (this.planState.steps.length === 0 && this.planAssistantTexts.length > 0) {
        const combined = this.planAssistantTexts.join('\n');
        const parsed = parsePlanMarkdown(combined);
        if (parsed.steps.length > 0) {
          this.planState.steps = parsed.steps;
          if (parsed.title) {
            this.planState.title = parsed.title;
          }
        }
      }
    }

    this.planModeActive = false;
    this.planModeEnteredAt = null;
    this.planAssistantTexts = [];

    log(`Plan mode exited at ${now.toISOString()}, ${this.planState?.steps.length ?? 0} steps extracted`);
  }

  /**
   * Handles Codex UpdatePlan snapshots by projecting them into tracked tasks.
   *
   * Each plan step is represented as a synthetic task (`plan-{index}`) so the
   * Kanban view can render lifecycle transitions in a provider-agnostic way.
   */
  private handleUpdatePlanToolUse(
    toolUse: { id: string; name: string; input: Record<string, unknown> },
    now: Date
  ): void {
    const plan = toolUse.input.plan as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(plan)) return;

    const seenPlanTaskIds = new Set<string>();
    let activePlanTaskId: string | null = null;

    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i];
      const step = String(entry.step || '').trim();
      if (!step) continue;

      const rawStatus = String(entry.status || 'pending').toLowerCase();
      let status: TaskStatus;
      if (rawStatus === 'completed') status = 'completed';
      else if (rawStatus === 'in_progress' || rawStatus === 'in-progress') status = 'in_progress';
      else status = 'pending';

      const taskId = `plan-${i}`;
      seenPlanTaskIds.add(taskId);

      const existing = this.taskState.tasks.get(taskId);
      if (existing) {
        existing.subject = step;
        existing.status = status;
        existing.updatedAt = now;
        if (!existing.activeForm) {
          existing.activeForm = `Working on ${step}`;
        }
      } else {
        const task: TrackedTask = {
          taskId,
          subject: step,
          status,
          createdAt: now,
          updatedAt: now,
          activeForm: `Working on ${step}`,
          blockedBy: [],
          blocks: [],
          associatedToolCalls: []
        };
        this.taskState.tasks.set(taskId, task);
      }

      if (status === 'in_progress') {
        activePlanTaskId = taskId;
      }
    }

    // Mark missing synthetic plan tasks as deleted when absent from a new snapshot.
    for (const [taskId, task] of this.taskState.tasks) {
      if (!taskId.startsWith('plan-')) continue;
      if (!seenPlanTaskIds.has(taskId) && task.status !== 'deleted') {
        task.status = 'deleted';
        task.updatedAt = now;
      }
    }

    if (activePlanTaskId) {
      this.taskState.activeTaskId = activePlanTaskId;
    } else if (this.taskState.activeTaskId?.startsWith('plan-')) {
      this.taskState.activeTaskId = null;
    }

    // Dual-write: populate planState for mind map plan visualization
    const planSteps: PlanStep[] = [];
    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i];
      const step = String(entry.step || '').trim();
      if (!step) continue;
      const rawStatus = String(entry.status || 'pending').toLowerCase();
      let stepStatus: 'pending' | 'in_progress' | 'completed';
      if (rawStatus === 'completed') stepStatus = 'completed';
      else if (rawStatus === 'in_progress' || rawStatus === 'in-progress') stepStatus = 'in_progress';
      else stepStatus = 'pending';
      planSteps.push({ id: `step-${i}`, description: step, status: stepStatus });
    }

    const hasActive = planSteps.some(s => s.status === 'in_progress' || s.status === 'pending');
    this.planState = {
      active: hasActive,
      steps: planSteps,
      title: 'Plan',
      source: 'codex',
    };
  }

  /**
   * Handles TodoWrite tool use (OpenCode's equivalent of TaskCreate/TaskUpdate).
   *
   * Replaces all non-subagent tracked tasks with the new todo list from the
   * input's `todos` array. Each todo item has: content, status, priority.
   *
   * @param toolUse - Tool use block with input containing `todos` array
   * @param now - Parsed timestamp
   */
  private handleTodoWriteToolUse(
    toolUse: { id: string; name: string; input: Record<string, unknown> },
    now: Date
  ): void {
    const todos = toolUse.input.todos as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(todos)) return;

    // Remove all non-subagent tasks (subagent tasks should persist)
    for (const [taskId, task] of this.taskState.tasks) {
      if (!task.isSubagent) {
        this.taskState.tasks.delete(taskId);
      }
    }

    // Reset active task if it was a non-subagent task
    if (this.taskState.activeTaskId && !this.taskState.tasks.has(this.taskState.activeTaskId)) {
      this.taskState.activeTaskId = null;
    }

    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const taskId = `todo-${i}`;
      const content = String(todo.content || todo.subject || `Todo ${i + 1}`);
      const rawStatus = String(todo.status || 'pending').toLowerCase();
      const priority = todo.priority ? String(todo.priority) : undefined;

      // Map OpenCode todo status values to TaskStatus
      let status: TaskStatus;
      if (rawStatus === 'completed' || rawStatus === 'done') {
        status = 'completed';
      } else if (rawStatus === 'in_progress' || rawStatus === 'in-progress') {
        status = 'in_progress';
      } else {
        status = 'pending';
      }

      const task: TrackedTask = {
        taskId,
        subject: content,
        description: priority ? `Priority: ${priority}` : undefined,
        status,
        createdAt: now,
        updatedAt: now,
        blockedBy: [],
        blocks: [],
        associatedToolCalls: []
      };

      this.taskState.tasks.set(taskId, task);

      // Track active task
      if (status === 'in_progress') {
        this.taskState.activeTaskId = taskId;
      }
    }

    // Second pass: parse dependency info from content text
    for (let i = 0; i < todos.length; i++) {
      const task = this.taskState.tasks.get(`todo-${i}`);
      if (!task) continue;

      // Check for explicit blockedBy field (future-proofing)
      if (Array.isArray(todos[i].blockedBy)) {
        for (const ref of todos[i].blockedBy as string[]) {
          const refStr = String(ref);
          if (!task.blockedBy.includes(refStr)) {
            task.blockedBy.push(refStr);
          }
        }
      }

      // Parse dependency references from content text
      const deps = parseTodoDependencies(String(todos[i].content || ''), todos);
      for (const depId of deps) {
        if (depId !== `todo-${i}` && !task.blockedBy.includes(depId)) {
          task.blockedBy.push(depId);
          const depTask = this.taskState.tasks.get(depId);
          if (depTask && !depTask.blocks.includes(`todo-${i}`)) {
            depTask.blocks.push(`todo-${i}`);
          }
        }
      }
    }

    log(`TodoWrite: created ${todos.length} tasks from todo list`);
  }

  /**
   * Extracts tool_result blocks from message content array.
   *
   * @param content - Message content array
   * @param timestamp - Event timestamp
   */
  private extractToolResultsFromContent(content: unknown, timestamp: string): void {
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (isTypedBlock(block) && block.type === 'tool_result') {
        const toolResult = block as { type: string; tool_use_id: string; content?: unknown; is_error?: boolean; duration?: number };

        const pending = this.pendingToolCalls.get(toolResult.tool_use_id);
        if (pending) {
          // Handle TaskCreate results
          if (pending.name === 'TaskCreate') {
            this.handleTaskCreateResult(toolResult.tool_use_id, toolResult.content, timestamp, toolResult.is_error);
          }

          // Handle Task (subagent) results
          if (pending.name === 'Task') {
            const agentTaskId = 'agent-' + toolResult.tool_use_id;
            const agentTask = this.taskState.tasks.get(agentTaskId);
            if (agentTask) {
              agentTask.status = toolResult.is_error ? 'deleted' : 'completed';
              agentTask.updatedAt = new Date(timestamp);
              // Fire event so the board refreshes immediately
              this._onToolCall.fire({ name: 'Task', input: {}, timestamp: new Date(timestamp) });
            }
          }

          // Prefer provider-supplied duration (from OpenCode tool parts) over
          // calculated duration from event timestamps which can be inaccurate
          // when both tool_use and tool_result are emitted in the same batch.
          const endTime = new Date(timestamp);
          const duration = (typeof toolResult.duration === 'number' && toolResult.duration > 0)
            ? toolResult.duration
            : endTime.getTime() - pending.startTime.getTime();

          // Update the corresponding ToolCall with result data
          const toolCall = this.stats.toolCalls.find(
            tc => tc.timestamp.getTime() === pending.startTime.getTime() && tc.name === pending.name
          );
          if (toolCall) {
            toolCall.isError = toolResult.is_error ?? false;
            toolCall.duration = duration;
            if (toolResult.is_error && toolResult.content) {
              toolCall.errorMessage = this.extractErrorMessage(toolResult.content, pending.name);
              toolCall.errorCategory = this.categorizeError(toolResult.content);
            }
          }

          // Update analytics
          const analytics = this.toolAnalyticsMap.get(pending.name);
          if (analytics) {
            analytics.pendingCount = Math.max(0, analytics.pendingCount - 1);
            analytics.completedCount++;
            analytics.totalDuration += duration;

            if (toolResult.is_error) {
              analytics.failureCount++;
              // Track error type and message
              const errorType = this.categorizeError(toolResult.content);
              const errorMsg = this.extractErrorMessage(toolResult.content, pending.name);
              const messages = this.errorDetails.get(errorType) || [];
              messages.push(errorMsg);
              this.errorDetails.set(errorType, messages);
            } else {
              analytics.successCount++;
            }

            this._onToolAnalytics.fire({ ...analytics });
          }

          // Add to timeline
          this.timeline.unshift({
            type: toolResult.is_error ? 'error' : 'tool_result',
            timestamp,
            description: toolResult.is_error ? `${pending.name} failed` : `${pending.name} completed`,
            metadata: { isError: toolResult.is_error, toolName: pending.name }
          });
          if (this.timeline.length > this.MAX_TIMELINE_EVENTS) {
            this.timeline = this.timeline.slice(0, this.MAX_TIMELINE_EVENTS);
          }
          this._onTimelineEvent.fire(this.timeline[0]);

          // Remove from pending
          this.pendingToolCalls.delete(toolResult.tool_use_id);
        }
      }
    }
  }

  /**
   * Handles TaskCreate result to extract task ID and create TrackedTask.
   *
   * @param toolUseId - The tool_use_id for correlation
   * @param resultContent - The tool result content
   * @param timestamp - Event timestamp
   * @param isError - Whether the tool result is an error
   */
  private handleTaskCreateResult(
    toolUseId: string,
    resultContent: unknown,
    timestamp: string,
    isError?: boolean
  ): void {
    const pendingCreate = this.pendingTaskCreates.get(toolUseId);
    if (!pendingCreate) {
      return;
    }

    // Clean up pending create
    this.pendingTaskCreates.delete(toolUseId);

    // Don't create task on error
    if (isError) {
      log(`TaskCreate failed for tool_use_id ${toolUseId}`);
      return;
    }

    const taskId = extractTaskIdFromResult(resultContent);
    if (!taskId) {
      const resultStr = typeof resultContent === 'string'
        ? resultContent
        : JSON.stringify(resultContent || '');
      log(`Could not extract task ID from TaskCreate result: ${resultStr.substring(0, 100)}`);
      return;
    }

    const now = new Date(timestamp);

    // Create the tracked task
    const task: TrackedTask = {
      taskId,
      subject: pendingCreate.subject,
      description: pendingCreate.description,
      status: 'pending', // TaskCreate always creates in pending status
      createdAt: pendingCreate.timestamp,
      updatedAt: now,
      activeForm: pendingCreate.activeForm,
      blockedBy: [],
      blocks: [],
      associatedToolCalls: []
    };

    this.taskState.tasks.set(taskId, task);
    log(`Created TrackedTask: ${taskId} - "${task.subject}"`);
  }

  /**
   * Classifies the noise level of a user event.
   *
   * User events that contain only tool_result blocks (no actual user text)
   * are classified as system noise. Events with user text content are 'user'.
   * Sidechain events are always 'noise'.
   *
   * @param event - User session event
   * @returns Noise classification
   */
  private classifyUserEventNoise(event: ClaudeSessionEvent): 'user' | 'system' | 'noise' {
    if (event.isSidechain) return 'noise';

    const content = event.message?.content;
    if (!content || !Array.isArray(content)) return 'user';

    // Check if the event contains only tool_result blocks (no user text)
    const hasText = content.some((block: unknown) =>
      isTypedBlock(block) && block.type === 'text' &&
      typeof block.text === 'string' && (block.text as string).trim().length > 0
    );
    const hasToolResult = content.some((block: unknown) =>
      isTypedBlock(block) && block.type === 'tool_result'
    );

    // System reminder patterns in text content
    if (hasText) {
      const textBlock = content.find((block: unknown) =>
        isTypedBlock(block) && block.type === 'text' && typeof block.text === 'string'
      );
      if (textBlock && isTypedBlock(textBlock) && typeof textBlock.text === 'string') {
        const text = textBlock.text as string;
        if (text.includes('<system-reminder>') || text.includes('permission_prompt')) {
          return 'system';
        }
      }
    }

    if (!hasText && hasToolResult) return 'system';

    return 'user';
  }

  /**
   * Gets compaction events that occurred during the session.
   *
   * @returns Array of compaction events
   */
  getCompactionEvents(): CompactionEvent[] {
    return [...this.compactionEvents];
  }

  /**
   * Gets context token attribution breakdown.
   *
   * @returns Current context attribution
   */
  getContextAttribution(): ContextAttribution {
    return { ...this.contextAttribution };
  }

  /**
   * Resets task state. Called when session resets or switches.
   */
  private resetTaskState(): void {
    this.taskState = {
      tasks: new Map(),
      activeTaskId: null
    };
    this.pendingTaskCreates.clear();
    this.planState = null;
    this.planModeActive = false;
    this.planModeEnteredAt = null;
    this.planAssistantTexts = [];
  }
}
