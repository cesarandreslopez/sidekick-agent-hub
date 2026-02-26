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
import { ClaudeSessionEvent, TokenUsage, ToolCall, SessionStats, ToolAnalytics, TimelineEvent, PendingToolCall, SubagentStats, TaskState, TrackedTask, TaskStatus, LatencyStats, CompactionEvent, TruncationEvent, ContextAttribution, PlanState, PlanStep, TurnAttribution, ContextSizePoint } from '../types/claudeSession';
import { SessionSummary, ModelUsageRecord, ToolUsageRecord, createEmptyTokenTotals } from '../types/historicalData';
import { estimateTokens } from '../utils/tokenEstimator';
import { ModelPricingService } from './ModelPricingService';
import { log, logError } from './Logger';
import { extractTaskIdFromResult } from '../utils/taskHelpers';
import { parsePlanMarkdown, extractProposedPlan } from '../utils/planParser';
import { detectCycle } from '../utils/cycleDetector';
import type { SessionEventLogger } from './SessionEventLogger';
import { EventAggregator } from 'sidekick-shared/dist/aggregation/EventAggregator';
import { saveSnapshot, loadSnapshot, isSnapshotValid, deleteSnapshot } from 'sidekick-shared/dist/aggregation/snapshot';
import type { SessionSnapshot } from 'sidekick-shared/dist/aggregation/snapshot';

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

  /** Shared aggregation engine (tokens, model stats, context, compaction, latency, etc.) */
  private aggregator: EventAggregator;

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

  /** Most recently observed model ID */
  private lastModelId: string | null = null;

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

  /** Timestamp of last cycle notification (for throttling) */
  private lastCycleNotificationTime: number = 0;

  /** Minimum interval between cycle notifications (ms) */
  private static readonly CYCLE_THROTTLE_MS = 60_000;

  /** Per-turn attribution history (capped at MAX_TURN_ATTRIBUTIONS) */
  private turnAttributions: TurnAttribution[] = [];
  private readonly MAX_TURN_ATTRIBUTIONS = 200;

  /** Current turn index (incremented on each user or assistant event with content) */
  private currentTurnIndex: number = 0;

  /** Context size timeline for waterfall chart (capped at MAX_CONTEXT_TIMELINE) */
  private contextTimeline: ContextSizePoint[] = [];
  private readonly MAX_CONTEXT_TIMELINE = 500;

  /** Optional event logger for JSONL audit trail */
  private eventLogger: SessionEventLogger | null = null;

  /** Assistant text snippets for decision extraction (capped at 200) */
  private assistantTexts: Array<{ text: string; timestamp: string }> = [];
  private readonly MAX_ASSISTANT_TEXTS = 200;
  private readonly MAX_ASSISTANT_TEXT_LENGTH = 500;

  /** True while replaying historical events during initial session load */
  private _isReplaying = false;

  /** Whether the monitor is replaying historical events (initial load) */
  get isReplaying(): boolean {
    return this._isReplaying;
  }

  /** Plan state tracking */
  private planState: PlanState | null = null;
  private planModeActive = false;
  private planModeEnteredAt: Date | null = null;
  private planAssistantTexts: string[] = [];
  private planFileContent: string | null = null;
  private planFilePath: string | null = null;

  /** Step-level metrics tracking for active plan */
  private planStepTokens = 0;
  private planStepToolCalls = 0;
  private planRevisionCount = 0;
  private lastUserPromptForPlan: string | undefined;

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
  private readonly _onTruncation = new vscode.EventEmitter<TruncationEvent>();
  private readonly _onCycleDetected = new vscode.EventEmitter<import('../types/analysis').CycleDetection>();
  private readonly _onQuotaUpdate = new vscode.EventEmitter<QuotaState>();
  private readonly _onReplayStateChange = new vscode.EventEmitter<boolean>();

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

  /** Fires when a tool output truncation is detected */
  readonly onTruncation = this._onTruncation.event;

  /** Fires when a tool call cycle is detected */
  readonly onCycleDetected = this._onCycleDetected.event;

  /** Fires when subscription quota data is available from session provider */
  readonly onQuotaUpdate = this._onQuotaUpdate.event;

  /** Fires when replay state changes (true = replaying historical events, false = live) */
  readonly onReplayStateChange = this._onReplayStateChange.event;

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
    // Initialize shared aggregation engine
    this.aggregator = new EventAggregator({
      computeContextSize: provider.computeContextSize
        ? (usage) => provider.computeContextSize!(usage as TokenUsage)
        : undefined,
      providerId: provider.id as 'claude-code' | 'opencode' | 'codex',
      readPlanFile: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
    });
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
      sessionStartTime: null,
      truncationCount: 0,
      contextHealth: 100,
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
        this.aggregator.seedContextSize(snapshotContextSize);
        this.stats.currentContextSize = snapshotContextSize;
        this.lastModelId = usageSnapshot.model;
        this.stats.lastModelId = usageSnapshot.model;
      }

      // Seed context attribution from provider if available (e.g., OpenCode DB)
      const providerAttribution = this.provider.getContextAttribution?.(this.sessionPath);
      if (providerAttribution) {
        this.aggregator.seedContextAttribution(providerAttribution);
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
    this.lastModelId = null;
    this.sessionStartTime = null;
    this._subagentStats = [];
    this.seenHashes.clear();
    this.resetTaskState();
    this.assistantTexts = [];
    this.turnAttributions = [];
    this.currentTurnIndex = 0;
    this.contextTimeline = [];
    this.aggregator.reset();
    this.stats = this.createEmptyStats();
    this.isWaitingForSession = false;
    this.fastDiscoveryStartTime = null;

    await this.clearCustomPath();

    const oldProvider = this.provider;
    this.provider = newProvider;
    // Re-create aggregator for new provider
    this.aggregator = new EventAggregator({
      computeContextSize: newProvider.computeContextSize
        ? (usage) => newProvider.computeContextSize!(usage as TokenUsage)
        : undefined,
      providerId: newProvider.id as 'claude-code' | 'opencode' | 'codex',
      readPlanFile: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
    });
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
    this.lastModelId = null;
    this.sessionStartTime = null;
    this._subagentStats = [];
    this.seenHashes.clear();
    this.resetTaskState();
    this.assistantTexts = [];
    this.turnAttributions = [];
    this.currentTurnIndex = 0;
    this.contextTimeline = [];
    this.aggregator.reset();

    // Reset statistics
    this.stats = this.createEmptyStats();

    // Re-setup watcher to track the new session file
    await this.setupDirectoryWatcher();

    // Try to restore from snapshot for fast resume
    const restored = this.tryRestoreFromSnapshot(sessionPath);

    if (!restored) {
      // No valid snapshot — seed from provider and do full replay
      const usageSnapshot = this.provider.getCurrentUsageSnapshot?.(sessionPath);
      if (usageSnapshot) {
        const snapshotContextSize = this.provider.computeContextSize
          ? this.provider.computeContextSize(usageSnapshot)
          : usageSnapshot.inputTokens + usageSnapshot.cacheWriteTokens + usageSnapshot.cacheReadTokens;
        this.aggregator.seedContextSize(snapshotContextSize);
        this.stats.currentContextSize = snapshotContextSize;
        this.lastModelId = usageSnapshot.model;
        this.stats.lastModelId = usageSnapshot.model;
      }

      const providerAttribution = this.provider.getContextAttribution?.(sessionPath);
      if (providerAttribution) {
        this.aggregator.seedContextAttribution(providerAttribution);
      }
    }

    // Read content from session (full replay if no snapshot, incremental if restored)
    try {
      await this.readInitialContent();

      // Save snapshot after initial replay for future fast resume
      this.persistSnapshot();

      this.startActivityPolling();
      log(`Attached to session: ${sessionPath}${restored ? ' (restored from snapshot)' : ''}`);
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
    const aggTokens = this.aggregator.getAggregatedTokens();
    const aggCompactions = this.aggregator.getCompactionEvents();
    const aggTruncations = this.aggregator.getTruncationEvents();
    const aggLatency = this.aggregator.getLatencyStats();
    const aggMetrics = this.aggregator.getMetrics();

    return {
      ...this.stats,
      modelUsage: new Map(this.stats.modelUsage),
      toolCalls: [...this.stats.toolCalls],
      toolAnalytics: new Map(this.toolAnalyticsMap),
      timeline: [...this.timeline],
      errorDetails: new Map(this.errorDetails),
      currentContextSize: aggMetrics.currentContextSize,
      lastModelId: this.lastModelId ?? undefined,
      recentUsageEvents: [],
      sessionStartTime: this.sessionStartTime,
      taskState: this.taskState.tasks.size > 0 ? {
        tasks: new Map(this.taskState.tasks),
        activeTaskId: this.taskState.activeTaskId
      } : undefined,
      latencyStats: aggLatency ?? undefined,
      compactionEvents: aggCompactions.length > 0 ? aggCompactions : undefined,
      contextAttribution: this.aggregator.getContextAttribution(),
      turnAttributions: this.turnAttributions.length > 0 ? [...this.turnAttributions] : undefined,
      contextTimeline: this.contextTimeline.length > 0 ? [...this.contextTimeline] : undefined,
      totalReportedCost: aggTokens.reportedCost > 0 ? aggTokens.reportedCost : undefined,
      planState: this.planState ? { ...this.planState, steps: [...this.planState.steps] } : undefined,
      contextHealth: this.calculateContextHealth(),
      truncationCount: aggTruncations.length,
      truncationEvents: aggTruncations.length > 0 ? aggTruncations : undefined,
    };
  }

  /**
   * Calculates context health score based on compaction history.
   * Score degrades with each compaction and the total percentage of tokens reclaimed.
   */
  private calculateContextHealth(): number {
    const compactions = this.aggregator.getCompactionEvents();
    if (compactions.length === 0) return 100;

    let totalReclaimedPercent = 0;
    for (const event of compactions) {
      if (event.contextBefore > 0) {
        totalReclaimedPercent += (event.tokensReclaimed / event.contextBefore) * 100;
      }
    }

    return Math.max(0, Math.round(100 - (compactions.length * 15) - (totalReclaimedPercent * 0.3)));
  }

  /** Regex for goal gate keyword detection */
  private static readonly GOAL_GATE_REGEX = /\b(CRITICAL|MUST|blocker|required|must.?complete|goal.?gate|essential|do.?not.?skip|blocking)\b/i;

  /**
   * Checks whether a task qualifies as a goal gate.
   * A task is a goal gate if it matches critical keywords or blocks 3+ tasks.
   */
  private isGoalGateTask(task: TrackedTask): boolean {
    // Criterion 1: subject or description matches keyword regex
    if (SessionMonitor.GOAL_GATE_REGEX.test(task.subject)) return true;
    if (task.description && SessionMonitor.GOAL_GATE_REGEX.test(task.description)) return true;
    // Criterion 2: blocks 3+ other tasks
    if (task.blocks.length >= 3) return true;
    return false;
  }

  // Truncation detection is now handled by the shared aggregator.
  // VS Code event firing for truncations happens in handleEvent after processEvent().

  /**
   * Checks recent tool calls for repeating cycles.
   * Fires onCycleDetected event if found (throttled to 60s intervals).
   */
  private checkForCycles(): void {
    if (this._isReplaying) return;

    const now = Date.now();
    if (now - this.lastCycleNotificationTime < SessionMonitor.CYCLE_THROTTLE_MS) return;

    const calls = this.stats.toolCalls;
    // Check windows of 6 and 10
    const cycle = detectCycle(calls, 6) || detectCycle(calls, 10);
    if (cycle) {
      this.lastCycleNotificationTime = now;
      this._onCycleDetected.fire(cycle);
      log(`Cycle detected: ${cycle.description}`);
    }
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
   * Returns the full aggregated metrics from the EventAggregator.
   *
   * Includes permission mode tracking, context timeline, noise-classified
   * timeline events, and all other aggregation outputs.
   */
  getAggregatedMetrics() {
    return this.aggregator.getMetrics();
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
    // Save final snapshot before teardown
    if (this.sessionId && this.reader) {
      this.persistSnapshot();
    }

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
    this.sessionStartTime = null;
    this._subagentStats = [];
    this.seenHashes.clear();
    this.isWaitingForSession = false;
    this.fastDiscoveryStartTime = null;
    this._isPinned = false;
    this.resetTaskState();
    this.assistantTexts = [];
    this.turnAttributions = [];
    this.currentTurnIndex = 0;
    this.contextTimeline = [];
    this.aggregator.reset();

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

    this._isReplaying = true;
    this._onReplayStateChange.fire(true);
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
    } finally {
      this._isReplaying = false;
      this._onReplayStateChange.fire(false);
    }
  }

  /**
   * Attempts to restore session state from a snapshot sidecar file.
   *
   * If a valid snapshot exists for this session, restores the aggregator state,
   * local stats, and seeks the reader past already-processed content.
   * Returns true if restoration succeeded (readInitialContent will only
   * process new events), false if full replay is needed.
   */
  private tryRestoreFromSnapshot(sessionPath: string): boolean {
    if (!this.sessionId || !this.reader) return false;

    const snapshot = loadSnapshot(this.sessionId);
    if (!snapshot) return false;

    // Verify provider matches
    if (snapshot.providerId !== this.provider.id) {
      deleteSnapshot(this.sessionId);
      return false;
    }

    // Validate against source file
    let sourceSize = 0;
    try {
      const stat = fs.statSync(sessionPath);
      sourceSize = stat.size;
    } catch {
      // DB-backed providers may not have a real file — sourceSize stays 0
    }

    if (!isSnapshotValid(snapshot, sourceSize)) {
      log(`Snapshot invalidated for ${this.sessionId} (source changed)`);
      deleteSnapshot(this.sessionId);
      return false;
    }

    // Restore aggregator state
    this.aggregator.restore(snapshot.aggregator);

    // Restore consumer-specific state
    const c = snapshot.consumer;
    if (c.stats && typeof c.stats === 'object') {
      const s = c.stats as Record<string, unknown>;
      this.stats.totalInputTokens = (s.totalInputTokens as number) || 0;
      this.stats.totalOutputTokens = (s.totalOutputTokens as number) || 0;
      this.stats.totalCacheWriteTokens = (s.totalCacheWriteTokens as number) || 0;
      this.stats.totalCacheReadTokens = (s.totalCacheReadTokens as number) || 0;
      this.stats.messageCount = (s.messageCount as number) || 0;
      this.stats.currentContextSize = (s.currentContextSize as number) || 0;
      this.stats.lastModelId = (s.lastModelId as string) || undefined;
      this.stats.truncationCount = (s.truncationCount as number) || 0;
      this.stats.contextHealth = (s.contextHealth as number) ?? 100;

      // Restore Maps from serialized arrays
      if (Array.isArray(s.modelUsage)) {
        this.stats.modelUsage = new Map(s.modelUsage as Array<[string, { calls: number; tokens: number; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }]>);
      }
      if (Array.isArray(s.toolCalls)) {
        this.stats.toolCalls = (s.toolCalls as ToolCall[]).map(tc => ({
          ...tc,
          timestamp: new Date(tc.timestamp),
        }));
      }
    }

    if (typeof c.lastModelId === 'string') {
      this.lastModelId = c.lastModelId;
    }
    if (c.sessionStartTime) {
      this.sessionStartTime = new Date(c.sessionStartTime as string);
    }
    if (typeof c.currentTurnIndex === 'number') {
      this.currentTurnIndex = c.currentTurnIndex;
    }
    if (Array.isArray(c.turnAttributions)) {
      this.turnAttributions = c.turnAttributions as TurnAttribution[];
    }
    if (Array.isArray(c.contextTimeline)) {
      this.contextTimeline = c.contextTimeline as ContextSizePoint[];
    }
    if (Array.isArray(c.timeline)) {
      this.timeline = c.timeline as TimelineEvent[];
      // Backfill empty descriptions from older snapshots
      for (const ev of this.timeline) {
        if (!ev.description) {
          if (ev.metadata?.toolName) {
            ev.description = ev.metadata.toolName;
          } else {
            const fallbacks: Record<string, string> = {
              user_prompt: '(user message)', assistant_response: '(assistant)',
              tool_call: '(tool call)', tool_result: '(tool result)',
              compaction: 'Context compacted', error: '(error)',
              session_start: 'Session started', session_end: 'Session ended',
            };
            ev.description = fallbacks[ev.type] || ev.type;
          }
        }
      }
    }
    if (Array.isArray(c.toolAnalyticsMap)) {
      this.toolAnalyticsMap = new Map(c.toolAnalyticsMap as Array<[string, ToolAnalytics]>);
    }
    if (Array.isArray(c.seenHashes)) {
      this.seenHashes = new Set(c.seenHashes as string[]);
    }

    // Seek reader past already-processed content
    this.reader.seekTo(snapshot.readerPosition);

    log(`Restored snapshot for ${this.sessionId}: position=${snapshot.readerPosition}, events=${snapshot.aggregator.eventCount}`);
    return true;
  }

  /**
   * Persists the current session state as a snapshot sidecar file.
   * Called after initial content replay and periodically during monitoring.
   */
  private persistSnapshot(): void {
    if (!this.sessionId || !this.reader) return;

    let sourceSize = 0;
    if (this.sessionPath) {
      try {
        const stat = fs.statSync(this.sessionPath);
        sourceSize = stat.size;
      } catch {
        // DB-backed — leave as 0
      }
    }

    const snapshot: SessionSnapshot = {
      version: 1,
      sessionId: this.sessionId,
      providerId: this.provider.id,
      readerPosition: this.reader.getPosition(),
      sourceSize,
      createdAt: new Date().toISOString(),
      aggregator: this.aggregator.serialize(),
      consumer: {
        stats: {
          totalInputTokens: this.stats.totalInputTokens,
          totalOutputTokens: this.stats.totalOutputTokens,
          totalCacheWriteTokens: this.stats.totalCacheWriteTokens,
          totalCacheReadTokens: this.stats.totalCacheReadTokens,
          messageCount: this.stats.messageCount,
          currentContextSize: this.stats.currentContextSize,
          lastModelId: this.stats.lastModelId,
          truncationCount: this.stats.truncationCount,
          contextHealth: this.stats.contextHealth,
          modelUsage: Array.from(this.stats.modelUsage.entries()),
          toolCalls: this.stats.toolCalls,
        },
        lastModelId: this.lastModelId,
        sessionStartTime: this.sessionStartTime?.toISOString() ?? null,
        currentTurnIndex: this.currentTurnIndex,
        turnAttributions: this.turnAttributions,
        contextTimeline: this.contextTimeline,
        timeline: this.timeline,
        toolAnalyticsMap: Array.from(this.toolAnalyticsMap.entries()),
        seenHashes: Array.from(this.seenHashes),
      },
    };

    saveSnapshot(snapshot);
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
        this.aggregator.reset();
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

        // Periodically update snapshot (throttled to avoid excessive writes)
        this.throttledSnapshotSave();
      }
    } catch (error) {
      logError('Error reading session file changes', error);
      // Don't throw - continue monitoring
    }
  }

  /** Minimum interval between snapshot writes (30 seconds). */
  private readonly SNAPSHOT_SAVE_INTERVAL_MS = 30_000;
  /** When the last snapshot was saved. */
  private lastSnapshotSaveTime = 0;

  /** Saves a snapshot if enough time has passed since the last save. */
  private throttledSnapshotSave(): void {
    const now = Date.now();
    if (now - this.lastSnapshotSaveTime < this.SNAPSHOT_SAVE_INTERVAL_MS) {
      return;
    }
    this.lastSnapshotSaveTime = now;
    this.persistSnapshot();
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

    // ── Delegate shared aggregation (tokens, model, context, compaction,
    //    latency, burn rate, tool analytics, truncation, context attribution) ──
    const prevCompactionCount = this.aggregator.getCompactionEvents().length;
    const prevTruncationCount = this.aggregator.getTruncationEvents().length;
    this.aggregator.processEvent(event);

    // During replay, skip expensive VS Code event firing — views will get
    // a batch update via onSessionStart after replay completes.
    if (!this._isReplaying) {
      // Fire VS Code events for newly detected compactions
      const compactions = this.aggregator.getCompactionEvents();
      if (compactions.length > prevCompactionCount) {
        const newCompaction = compactions[compactions.length - 1];
        this._onCompaction.fire(newCompaction);
        log(`Compaction detected: ${newCompaction.contextBefore} -> ${newCompaction.contextAfter} (reclaimed ${newCompaction.tokensReclaimed} tokens, health: ${this.calculateContextHealth()}%)`);
      }

      // Fire VS Code events for newly detected truncations
      const truncations = this.aggregator.getTruncationEvents();
      if (truncations.length > prevTruncationCount) {
        const newTruncation = truncations[truncations.length - 1];
        this._onTruncation.fire(newTruncation);
      }

      // Fire latency update if aggregator has data
      const latencyStats = this.aggregator.getLatencyStats();
      if (latencyStats) {
        this._onLatencyUpdate.fire(latencyStats);
      }
    }

    // Add compaction/truncation markers to timeline (always, to keep state consistent)
    const compactions = this.aggregator.getCompactionEvents();
    if (compactions.length > prevCompactionCount) {
      const newCompaction = compactions[compactions.length - 1];
      this.timeline.unshift({
        type: 'compaction',
        timestamp: event.timestamp,
        description: `Context compacted: ${Math.round(newCompaction.contextBefore / 1000)}K -> ${Math.round(newCompaction.contextAfter / 1000)}K tokens (reclaimed ${Math.round(newCompaction.tokensReclaimed / 1000)}K)`,
        noiseLevel: 'system',
        metadata: {
          contextBefore: newCompaction.contextBefore,
          contextAfter: newCompaction.contextAfter,
          tokensReclaimed: newCompaction.tokensReclaimed
        }
      });
      if (this.timeline.length > this.MAX_TIMELINE_EVENTS) {
        this.timeline = this.timeline.slice(0, this.MAX_TIMELINE_EVENTS);
      }
    }

    const truncations = this.aggregator.getTruncationEvents();
    if (truncations.length > prevTruncationCount) {
      const newTruncation = truncations[truncations.length - 1];
      this.timeline.unshift({
        type: 'tool_result',
        timestamp: event.timestamp,
        description: `Truncated output from ${newTruncation.toolName}: ${newTruncation.marker}`,
        noiseLevel: 'system',
        metadata: { toolName: newTruncation.toolName, isError: false },
      });
      if (this.timeline.length > this.MAX_TIMELINE_EVENTS) {
        this.timeline = this.timeline.slice(0, this.MAX_TIMELINE_EVENTS);
      }
    }

    // ── VS Code-specific processing below ──

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

    // Capture user prompt text for plan context
    if (event.type === 'user' && this.hasTextContent(event)) {
      this.lastUserPromptForPlan = this.extractUserText(event);
    }

    // Extract token usage for stats and event emission
    const usage = extractTokenUsage(event);
    if (usage) {
      log(`Token usage extracted - input: ${usage.inputTokens}, output: ${usage.outputTokens}, cacheWrite: ${usage.cacheWriteTokens}, cacheRead: ${usage.cacheReadTokens}`);
      this.lastModelId = usage.model;
      this.stats.lastModelId = usage.model;
      // Update local stats (kept for SessionSummary and model pricing)
      this.stats.totalInputTokens += usage.inputTokens;
      this.stats.totalOutputTokens += usage.outputTokens;
      this.stats.totalCacheWriteTokens += usage.cacheWriteTokens;
      this.stats.totalCacheReadTokens += usage.cacheReadTokens;

      // Update per-model usage (kept for SessionSummary cost calculation)
      const modelStats = this.stats.modelUsage.get(usage.model) || { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
      modelStats.calls++;
      modelStats.tokens += usage.inputTokens + usage.outputTokens;
      modelStats.inputTokens += usage.inputTokens;
      modelStats.outputTokens += usage.outputTokens;
      modelStats.cacheWriteTokens += usage.cacheWriteTokens;
      modelStats.cacheReadTokens += usage.cacheReadTokens;
      this.stats.modelUsage.set(usage.model, modelStats);

      // Track context size for waterfall chart
      const newContextSize = this.aggregator.getMetrics().currentContextSize;
      const hasContextSignal = usage.inputTokens > 0
        || usage.outputTokens > 0
        || usage.cacheWriteTokens > 0
        || usage.cacheReadTokens > 0
        || (usage.reasoningTokens ?? 0) > 0;

      if (hasContextSignal) {
        this.addContextTimelinePoint(event.timestamp, newContextSize, this.currentTurnIndex);
      }

      // Attribute tokens to active plan step
      if (this.planState && !this.planState.active) {
        const activeStep = this.planState.steps.find(s => s.status === 'in_progress');
        if (activeStep) {
          const stepTokens = usage.inputTokens + usage.outputTokens;
          activeStep.tokensUsed = (activeStep.tokensUsed ?? 0) + stepTokens;
          this.planStepTokens += stepTokens;
        }
      }

      // Emit event (suppressed during replay — views get batch update after)
      if (!this._isReplaying) {
        this._onTokenUsage.fire(usage);
      }
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
                rawMarkdown: proposedPlan,
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

    // Track per-turn context attribution (VS Code-specific — aggregator handles cumulative)
    this.updateTurnAttribution(event);

    // Add to timeline
    this.addTimelineEvent(event);
  }

  /**
   * Checks if a user event contains actual prompt content (not just tool_result).
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
   * Updates per-turn context attribution breakdown.
   *
   * The cumulative contextAttribution is now handled by the aggregator.
   * This method only tracks the per-turn breakdown for the waterfall chart.
   */
  private updateTurnAttribution(event: ClaudeSessionEvent): void {
    const content = event.message?.content;
    if (!content) return;

    // Per-turn breakdown accumulator (cumulative attribution is handled by aggregator)
    const turnBreakdown: ContextAttribution = SessionMonitor.emptyAttribution();

    if (event.type === 'user') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isTypedBlock(block)) continue;

          if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content || '');
            turnBreakdown.toolOutputs += estimateTokens(resultText);
          } else if (block.type === 'text' && typeof block.text === 'string') {
            const text = block.text as string;
            if (text.includes('<system-reminder>') || text.includes('CLAUDE.md') ||
                text.includes('# System') || text.includes('<claude_code_instructions>')) {
              turnBreakdown.systemPrompt += estimateTokens(text);
            } else {
              turnBreakdown.userMessages += estimateTokens(text);
            }
          }
        }
      } else if (typeof content === 'string') {
        if (content.includes('<system-reminder>') || content.includes('CLAUDE.md')) {
          turnBreakdown.systemPrompt += estimateTokens(content);
        } else {
          turnBreakdown.userMessages += estimateTokens(content);
        }
      }

      const totalEstimated = turnBreakdown.systemPrompt + turnBreakdown.userMessages +
        turnBreakdown.toolOutputs + turnBreakdown.toolInputs +
        turnBreakdown.assistantResponses + turnBreakdown.thinking + turnBreakdown.other;
      if (totalEstimated > 0) {
        this.addTurnAttribution({
          turnIndex: this.currentTurnIndex++,
          timestamp: event.timestamp,
          role: 'user',
          inputTokens: totalEstimated,
          outputTokens: 0,
          breakdown: turnBreakdown,
        });
      }
    } else if (event.type === 'assistant') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isTypedBlock(block)) continue;

          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            turnBreakdown.thinking += estimateTokens(block.thinking as string);
          } else if (block.type === 'tool_use') {
            turnBreakdown.toolInputs += estimateTokens(JSON.stringify(block.input || {}));
          } else if (block.type === 'text' && typeof block.text === 'string') {
            turnBreakdown.assistantResponses += estimateTokens(block.text as string);
          }
        }
      } else if (typeof content === 'string') {
        turnBreakdown.assistantResponses += estimateTokens(content);
      }

      const usage = event.message?.usage;
      const actualInput = usage?.input_tokens ?? 0;
      const actualOutput = usage?.output_tokens ?? 0;

      const totalEstimated = turnBreakdown.systemPrompt + turnBreakdown.userMessages +
        turnBreakdown.toolOutputs + turnBreakdown.toolInputs +
        turnBreakdown.assistantResponses + turnBreakdown.thinking + turnBreakdown.other;
      if (totalEstimated > 0 || actualInput > 0 || actualOutput > 0) {
        this.addTurnAttribution({
          turnIndex: this.currentTurnIndex++,
          timestamp: event.timestamp,
          role: 'assistant',
          inputTokens: actualInput > 0 ? actualInput : totalEstimated,
          outputTokens: actualOutput,
          breakdown: turnBreakdown,
        });
      }
    }
    // Summary events: cumulative attribution handled by aggregator, no per-turn breakdown needed
  }

  /**
   * Adds a turn attribution entry, capping at MAX_TURN_ATTRIBUTIONS.
   */
  private addTurnAttribution(turn: TurnAttribution): void {
    this.turnAttributions.push(turn);
    if (this.turnAttributions.length > this.MAX_TURN_ATTRIBUTIONS) {
      this.turnAttributions = this.turnAttributions.slice(-this.MAX_TURN_ATTRIBUTIONS);
    }
  }

  /**
   * Adds a context size data point for waterfall chart.
   */
  private addContextTimelinePoint(timestamp: string, inputTokens: number, turnIndex: number): void {
    this.contextTimeline.push({ timestamp, inputTokens, turnIndex });
    if (this.contextTimeline.length > this.MAX_CONTEXT_TIMELINE) {
      // Thin older points: keep every other point from the first half
      const half = Math.floor(this.contextTimeline.length / 2);
      const thinned = this.contextTimeline.filter((_p, i) => i >= half || i % 2 === 0);
      this.contextTimeline = thinned;
    }
  }

  /**
   * Gets current latency statistics.
   * Delegates to the shared aggregator.
   */
  getLatencyStats(): LatencyStats {
    return this.aggregator.getLatencyStats() ?? {
      recentLatencies: [],
      avgFirstTokenLatencyMs: 0,
      maxFirstTokenLatencyMs: 0,
      avgTotalResponseTimeMs: 0,
      lastFirstTokenLatencyMs: null,
      completedCycles: 0
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

    if (!this._isReplaying) {
      this._onTimelineEvent.fire(timelineEvent);
    }
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
        if (!this._isReplaying) {
          this._onTimelineEvent.fire(this.timeline[0]);
        }

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

        // Attribute tool calls to active plan step
        if (this.planState && !this.planState.active) {
          const activeStep = this.planState.steps.find(s => s.status === 'in_progress');
          if (activeStep) {
            activeStep.toolCalls = (activeStep.toolCalls ?? 0) + 1;
            this.planStepToolCalls++;
          }
        }

        // Emit tool call event (suppressed during replay)
        if (!this._isReplaying) {
          this._onToolCall.fire(toolCall);
        }
        this.stats.toolCalls.push(toolCall);

        // Check for repeating cycles after each new tool call (skip during replay)
        if (!this._isReplaying) {
          this.checkForCycles();
        }
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
    } else if (toolUse.name === 'Write' && this.planModeActive) {
      const filePath = toolUse.input?.file_path as string | undefined;
      const content = toolUse.input?.content as string | undefined;
      if (filePath && content && filePath.includes('.claude/plans/')) {
        this.planFileContent = content;
        this.planFilePath = filePath;
      }
    } else if (toolUse.name === 'Edit' && this.planModeActive) {
      // Edit contains a diff, not full content — capture path for disk-read fallback
      const filePath = toolUse.input?.file_path as string | undefined;
      if (filePath?.includes('.claude/plans/')) {
        this.planFilePath = filePath;
      }
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
        // Re-evaluate goal gate status after any update
        task.isGoalGate = this.isGoalGateTask(task);

        // Sync plan step status for plan-linked tasks (plan-0 → step-0)
        if (taskId.startsWith('plan-') && toolUse.input.status) {
          const stepIndex = taskId.replace('plan-', '');
          const stepId = `step-${stepIndex}`;
          const rawStatus = String(toolUse.input.status).toLowerCase();
          let planStatus: PlanStep['status'];
          if (rawStatus === 'completed') planStatus = 'completed';
          else if (rawStatus === 'in_progress' || rawStatus === 'in-progress') planStatus = 'in_progress';
          else if (rawStatus === 'deleted') planStatus = 'skipped';
          else planStatus = 'pending';
          this.transitionPlanStep(stepId, planStatus, now);
        }
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
        newTask.isGoalGate = this.isGoalGateTask(newTask);
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
    this.planFileContent = null;
    this.planFilePath = null;
    this.planStepTokens = 0;
    this.planStepToolCalls = 0;

    // If this is a new plan (not a revision), initialize fresh
    if (!this.planState || !this.planState.active) {
      this.planRevisionCount = 0;
    } else {
      this.planRevisionCount++;
    }

    // Initialize plan state
    this.planState = {
      active: true,
      steps: [],
      enteredAt: now,
      source: this.provider.id === 'opencode' ? 'opencode' : 'claude-code',
      prompt: this.lastUserPromptForPlan,
      revision: this.planRevisionCount > 0 ? this.planRevisionCount : undefined,
    };

    log(`Plan mode entered at ${now.toISOString()} (${this.provider.id}), revision: ${this.planRevisionCount}`);
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

      // Prefer plan file content (from Write tool) → accumulated assistant text → disk read fallback
      const source = this.planFileContent
        || (this.planAssistantTexts.length > 0 ? this.planAssistantTexts.join('\n') : null)
        || this.readPlanFileFromDisk();
      this.planFileContent = null;
      this.planFilePath = null;

      // Parse into steps (if no steps yet from proposed_plan)
      if (this.planState.steps.length === 0 && source) {
        const parsed = parsePlanMarkdown(source);
        if (parsed.steps.length > 0) {
          this.planState.steps = parsed.steps;
          if (parsed.title) {
            this.planState.title = parsed.title;
          }
        }
        // Store the raw markdown for rich rendering
        this.planState.rawMarkdown = source;
      }

      // Compute plan-level metrics
      if (this.planState.enteredAt) {
        this.planState.totalDurationMs = now.getTime() - this.planState.enteredAt.getTime();
      }
      this.updatePlanCompletionRate();
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

    this.updatePlanCompletionRate();
  }

  /**
   * Updates the completion rate on the current plan state.
   */
  private updatePlanCompletionRate(): void {
    if (!this.planState || this.planState.steps.length === 0) return;
    const completed = this.planState.steps.filter(s => s.status === 'completed').length;
    this.planState.completionRate = completed / this.planState.steps.length;
  }

  /**
   * Transitions a plan step to a new status with timing metadata.
   *
   * Called by task status changes (TaskUpdate) that map to plan steps,
   * or inferred from sequential plan execution.
   */
  private transitionPlanStep(stepId: string, newStatus: PlanStep['status'], now: Date, output?: string, errorMessage?: string): void {
    if (!this.planState) return;
    const step = this.planState.steps.find(s => s.id === stepId);
    if (!step) return;

    if (newStatus === 'in_progress' && step.status === 'pending') {
      step.startedAt = now.toISOString();
    }

    if ((newStatus === 'completed' || newStatus === 'failed') && step.status === 'in_progress') {
      step.completedAt = now.toISOString();
      if (step.startedAt) {
        step.durationMs = now.getTime() - new Date(step.startedAt).getTime();
      }
      if (output) {
        step.output = output.length > 200 ? output.slice(0, 200) + '...' : output;
      }
      if (errorMessage) {
        step.errorMessage = errorMessage.length > 200 ? errorMessage.slice(0, 200) + '...' : errorMessage;
      }
    }

    step.status = newStatus;
    this.updatePlanCompletionRate();
  }

  /**
   * Finalizes plan state when a session ends.
   *
   * Marks in_progress steps as failed and pending steps as skipped
   * if the session ends with an incomplete plan.
   */
  finalizePlanOnSessionEnd(lastErrorMessage?: string): void {
    if (!this.planState) return;

    const now = new Date();
    for (const step of this.planState.steps) {
      if (step.status === 'in_progress') {
        step.status = 'failed';
        step.completedAt = now.toISOString();
        if (step.startedAt) {
          step.durationMs = now.getTime() - new Date(step.startedAt).getTime();
        }
        if (lastErrorMessage) {
          step.errorMessage = lastErrorMessage.length > 200 ? lastErrorMessage.slice(0, 200) + '...' : lastErrorMessage;
        }
      } else if (step.status === 'pending') {
        step.status = 'skipped';
      }
    }

    // Compute final plan duration
    if (this.planState.enteredAt) {
      this.planState.totalDurationMs = now.getTime() - this.planState.enteredAt.getTime();
    }
    this.updatePlanCompletionRate();
  }

  /**
   * Extracts user text content from a user event.
   */
  private extractUserText(event: ClaudeSessionEvent): string | undefined {
    const content = event.message?.content;
    if (!content) return undefined;

    if (typeof content === 'string') return content.trim() || undefined;

    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
          texts.push(block.text as string);
        }
      }
      const combined = texts.join('\n').trim();
      return combined || undefined;
    }
    return undefined;
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
              // Fire event so the board refreshes immediately (suppressed during replay)
              if (!this._isReplaying) {
                this._onToolCall.fire({ name: 'Task', input: {}, timestamp: new Date(timestamp) });
              }
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
              // Truncation detection is handled by the shared aggregator
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
          if (!this._isReplaying) {
            this._onTimelineEvent.fire(this.timeline[0]);
          }

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

    // Check if this task qualifies as a goal gate
    task.isGoalGate = this.isGoalGateTask(task);

    this.taskState.tasks.set(taskId, task);
    log(`Created TrackedTask: ${taskId} - "${task.subject}"${task.isGoalGate ? ' [GOAL GATE]' : ''}`);
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
   * Delegates to the shared aggregator.
   */
  getCompactionEvents(): CompactionEvent[] {
    return this.aggregator.getCompactionEvents();
  }

  /**
   * Gets context token attribution breakdown.
   * Delegates to the shared aggregator.
   */
  getContextAttribution(): ContextAttribution {
    return this.aggregator.getContextAttribution();
  }

  /**
   * Reads a plan file from disk as a fallback when Edit tool was used instead of Write.
   */
  private readPlanFileFromDisk(): string | null {
    if (!this.planFilePath) return null;
    try {
      return fs.readFileSync(this.planFilePath, 'utf-8');
    } catch {
      return null;
    }
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
    this.planFileContent = null;
    this.planFilePath = null;
    this.planStepTokens = 0;
    this.planStepToolCalls = 0;
    this.planRevisionCount = 0;
    this.lastUserPromptForPlan = undefined;
  }
}
