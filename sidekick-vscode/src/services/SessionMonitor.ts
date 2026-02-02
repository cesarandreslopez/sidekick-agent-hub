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
import path from 'path';
import { findActiveSession, findAllSessions, getSessionDirectory, discoverSessionDirectory, findSessionsInDirectory } from './SessionPathResolver';
import { JsonlParser, extractTokenUsage } from './JsonlParser';
import { scanSubagentDir } from './SubagentFileScanner';
import { ClaudeSessionEvent, TokenUsage, ToolCall, SessionStats, ToolAnalytics, TimelineEvent, PendingToolCall, SubagentStats } from '../types/claudeSession';
import { log, logError } from './Logger';

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

export class SessionMonitor implements vscode.Disposable {
  /** File watcher for session directory */
  private watcher: fs.FSWatcher | undefined;

  /** Current workspace path being monitored */
  private workspacePath: string | null = null;

  /** JSONL parser for processing events */
  private parser: JsonlParser;

  /** Path to current session file */
  private sessionPath: string | null = null;

  /** Custom session directory (overrides workspace-based discovery) */
  private customSessionDir: string | null = null;

  /** Workspace state for persistence */
  private readonly workspaceState: vscode.Memento | undefined;

  /** File read position for incremental reads */
  private filePosition: number = 0;

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

  // Event emitters for external consumers
  private readonly _onTokenUsage = new vscode.EventEmitter<TokenUsage>();
  private readonly _onToolCall = new vscode.EventEmitter<ToolCall>();
  private readonly _onSessionStart = new vscode.EventEmitter<string>();
  private readonly _onSessionEnd = new vscode.EventEmitter<void>();
  private readonly _onToolAnalytics = new vscode.EventEmitter<ToolAnalytics>();
  private readonly _onTimelineEvent = new vscode.EventEmitter<TimelineEvent>();
  private readonly _onDiscoveryModeChange = new vscode.EventEmitter<boolean>();

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

  /**
   * Creates a new SessionMonitor.
   *
   * Initializes the parser and empty statistics. Call start() to begin monitoring.
   *
   * @param workspaceState - Optional workspace state for persisting custom session path
   */
  constructor(workspaceState?: vscode.Memento) {
    this.workspaceState = workspaceState;
    // Load saved custom path on construction
    this.customSessionDir = workspaceState?.get<string>(CUSTOM_SESSION_PATH_KEY) || null;
    // Initialize empty statistics
    this.stats = {
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
      recentUsageEvents: [],
      sessionStartTime: null
    };

    // Create parser with event callback
    this.parser = new JsonlParser({
      onEvent: (event) => this.handleEvent(event),
      onError: (error, line) => {
        logError('JSONL parse error', error);
        log(`Malformed line: ${line.substring(0, 100)}...`);
      }
    });
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
    const sessionDir = getSessionDirectory(workspacePath);
    log(`Session monitoring starting for workspace: ${workspacePath}`);
    log(`Looking for sessions in: ${sessionDir}`);

    // Find active session
    this.sessionPath = findActiveSession(workspacePath);

    // Always set up directory watching, even without an active session
    await this.setupDirectoryWatcher();

    if (!this.sessionPath) {
      log('No active Claude Code session detected, entering discovery mode');
      log(`Expected session directory: ${sessionDir}`);
      log(`Tip: Check if ~/.claude/projects/ contains a directory matching your workspace path`);
      this.isWaitingForSession = true;
      this._onDiscoveryModeChange.fire(true);
      this.startDiscoveryPolling();
      return false;
    }

    log(`Found Claude Code session: ${this.sessionPath}`);

    try {
      this.isWaitingForSession = false;
      this.sessionId = path.basename(this.sessionPath, '.jsonl');

      // Read existing content
      await this.readInitialContent();

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
   * Sets up the directory watcher for the session directory.
   * Creates the watcher even if no session exists yet.
   */
  private async setupDirectoryWatcher(): Promise<void> {
    // Need either customSessionDir or workspacePath
    if (!this.customSessionDir && !this.workspacePath) {
      return;
    }

    // Close existing watcher if any
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }

    // Use custom directory if set, otherwise discover from workspace
    let sessionDir: string;
    if (this.customSessionDir) {
      sessionDir = this.customSessionDir;
    } else {
      sessionDir = discoverSessionDirectory(this.workspacePath!) || getSessionDirectory(this.workspacePath!);
    }

    // Create directory if it doesn't exist (Claude Code will create it anyway)
    try {
      if (!fs.existsSync(sessionDir)) {
        log(`Session directory doesn't exist yet: ${sessionDir}`);
        // Still set up polling - directory will be created when Claude Code starts
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
          // React to any .jsonl file in the workspace session directory
          if (filename?.endsWith('.jsonl')) {
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
      sessionDir = discoverSessionDirectory(this.workspacePath!) || getSessionDirectory(this.workspacePath!);
    }

    if (!fs.existsSync(sessionDir)) {
      return; // Still waiting for Claude Code to create directory
    }

    // Re-setup watcher if we don't have one (directory just appeared)
    if (!this.watcher) {
      this.setupDirectoryWatcher();
    }

    // Look for active session using appropriate discovery method
    let newSessionPath: string | null = null;
    if (this.customSessionDir) {
      // For custom directory, use direct directory scan
      const sessions = findSessionsInDirectory(this.customSessionDir);
      newSessionPath = sessions.length > 0 ? sessions[0] : null;
    } else {
      // For workspace-based, use standard discovery
      newSessionPath = findActiveSession(this.workspacePath!);
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
    this.sessionId = path.basename(sessionPath, '.jsonl');
    this.isWaitingForSession = false;
    this.fastDiscoveryStartTime = null;
    this.stopDiscoveryPolling();

    // Notify if we were in discovery mode
    if (wasWaiting) {
      this._onDiscoveryModeChange.fire(false);
    }

    // Reset state for new session
    this.filePosition = 0;
    this.parser.reset();
    this.pendingToolCalls.clear();
    this.toolAnalyticsMap.clear();
    this.timeline = [];
    this.errorDetails.clear();
    this.currentContextSize = 0;
    this.recentUsageEvents = [];
    this.sessionStartTime = null;
    this._subagentStats = [];

    // Reset statistics
    this.stats = {
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
      recentUsageEvents: [],
      sessionStartTime: null
    };

    // Re-setup watcher to track the new session file
    await this.setupDirectoryWatcher();

    // Read content from session
    try {
      await this.readInitialContent();
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

    const newSessionPath = findActiveSession(this.workspacePath);

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
   * Checks if actively monitoring a session.
   *
   * @returns True if monitoring is active
   */
  isActive(): boolean {
    return this.sessionPath !== null && this.watcher !== undefined;
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
      recentUsageEvents: [...this.recentUsageEvents],
      sessionStartTime: this.sessionStartTime
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
    this._subagentStats = scanSubagentDir(sessionDir, this.sessionId);
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
  }> {
    // Use custom directory if set, otherwise workspace path
    if (!this.customSessionDir && !this.workspacePath) {
      return [];
    }

    try {
      // Get sessions from appropriate directory
      let sessions: string[];
      if (this.customSessionDir) {
        sessions = findSessionsInDirectory(this.customSessionDir);
      } else {
        sessions = findAllSessions(this.workspacePath!);
      }

      return sessions.map(sessionPath => {
        const stats = fs.statSync(sessionPath);
        return {
          path: sessionPath,
          filename: path.basename(sessionPath, '.jsonl'),
          modifiedTime: stats.mtime,
          isCurrent: sessionPath === this.sessionPath
        };
      });
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
    if (!fs.existsSync(sessionPath)) {
      logError(`Cannot switch to session: file not found: ${sessionPath}`);
      return false;
    }

    log(`Manually switching to session: ${sessionPath}`);

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
    if (!fs.existsSync(sessionDirectory)) {
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
    const sessions = findSessionsInDirectory(sessionDirectory);
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
  }> {
    try {
      const sessions = findSessionsInDirectory(sessionDir);
      return sessions.map(sessionPath => {
        const stats = fs.statSync(sessionPath);
        return {
          path: sessionPath,
          filename: path.basename(sessionPath, '.jsonl'),
          modifiedTime: stats.mtime,
          isCurrent: sessionPath === this.sessionPath
        };
      });
    } catch (error) {
      logError('Error getting sessions from directory', error);
      return [];
    }
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

    // Close file watcher
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }

    // Dispose event emitters
    this._onTokenUsage.dispose();
    this._onToolCall.dispose();
    this._onSessionStart.dispose();
    this._onSessionEnd.dispose();
    this._onToolAnalytics.dispose();
    this._onTimelineEvent.dispose();
    this._onDiscoveryModeChange.dispose();

    // Reset state
    this.sessionPath = null;
    this.sessionId = null;
    this.workspacePath = null;
    this.filePosition = 0;
    this.parser.reset();
    this.pendingToolCalls.clear();
    this.toolAnalyticsMap.clear();
    this.timeline = [];
    this.errorDetails.clear();
    this.currentContextSize = 0;
    this.recentUsageEvents = [];
    this.sessionStartTime = null;
    this._subagentStats = [];
    this.isWaitingForSession = false;
    this.fastDiscoveryStartTime = null;

    log('SessionMonitor disposed');
  }

  /**
   * Reads initial content from session file.
   *
   * Parses the entire file to establish initial state, then sets
   * file position for incremental reads.
   */
  private async readInitialContent(): Promise<void> {
    if (!this.sessionPath) {
      return;
    }

    try {
      const content = await fs.promises.readFile(this.sessionPath, 'utf-8');
      const lineCount = content.split('\n').filter(l => l.trim()).length;
      log(`Reading initial content: ${content.length} chars, ~${lineCount} lines`);
      this.parser.processChunk(content);
      this.parser.flush();
      // Use byte length, not character length - fs.readSync uses byte offsets
      this.filePosition = Buffer.byteLength(content, 'utf-8');
      log(`Initial content parsed: ${this.filePosition} bytes, stats: input=${this.stats.totalInputTokens}, output=${this.stats.totalOutputTokens}`);
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
    if (!this.sessionPath) {
      return;
    }

    try {
      // Check if file still exists
      if (!fs.existsSync(this.sessionPath)) {
        log('Session file deleted, entering fast discovery mode...');
        this._onSessionEnd.fire();
        this.sessionPath = null;
        // Enter fast discovery mode to quickly find new session
        this.enterFastDiscoveryMode();
        return;
      }

      // Get current file size
      const stats = fs.statSync(this.sessionPath);
      const currentSize = stats.size;

      // Handle file truncation (file was rewritten/smaller than before)
      if (currentSize < this.filePosition) {
        log(`Session file truncated (${this.filePosition} -> ${currentSize}), re-reading from start`);
        this.filePosition = 0;
        this.parser.reset();
        // Reset stats for fresh read
        this.stats.totalInputTokens = 0;
        this.stats.totalOutputTokens = 0;
        this.stats.totalCacheWriteTokens = 0;
        this.stats.totalCacheReadTokens = 0;
        this.stats.messageCount = 0;
        this.currentContextSize = 0;
        this.recentUsageEvents = [];
        this.sessionStartTime = null;
      }

      // Check if file has grown
      if (currentSize <= this.filePosition) {
        return; // No new content
      }

      // Read new content from last position
      const fd = fs.openSync(this.sessionPath, 'r');
      const bufferSize = currentSize - this.filePosition;
      const buffer = Buffer.alloc(bufferSize);

      fs.readSync(fd, buffer, 0, bufferSize, this.filePosition);
      fs.closeSync(fd);

      const chunk = buffer.toString('utf-8');
      this.parser.processChunk(chunk);

      // Update file position
      this.filePosition = currentSize;

    } catch (error) {
      logError('Error reading session file changes', error);
      // Don't throw - continue monitoring
    }
  }

  /** Debounce timer for new session checks */
  private newSessionCheckTimer: NodeJS.Timeout | null = null;

  /** Debounce delay for new session detection (ms) */
  private readonly NEW_SESSION_CHECK_DEBOUNCE_MS = 500;

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
        const sessions = findSessionsInDirectory(this.customSessionDir);
        newSessionPath = sessions.length > 0 ? sessions[0] : null;
      } else {
        newSessionPath = findActiveSession(this.workspacePath!);
      }
      log(`performNewSessionCheck: session lookup returned: ${newSessionPath}`);

      // If there's a different active session, switch to it
      if (newSessionPath && newSessionPath !== this.sessionPath) {
        log(`Detected new session: ${newSessionPath}, switching from ${this.sessionPath}`);
        this.switchToNewSession(newSessionPath);
      } else if (!newSessionPath && this.sessionPath) {
        // Current session gone and no new session found
        log('performNewSessionCheck: current session ended, entering fast discovery mode');
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
    this.isWaitingForSession = true;
    this.fastDiscoveryStartTime = Date.now();
    this._onDiscoveryModeChange.fire(true);
    this.startDiscoveryPolling();
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
    // Update message count
    this.stats.messageCount++;
    this.stats.lastUpdated = new Date();

    // Track session start time (first event)
    if (!this.sessionStartTime && event.timestamp) {
      this.sessionStartTime = new Date(event.timestamp);
    }

    // Extract and emit token usage
    const usage = extractTokenUsage(event);
    if (usage) {
      log(`Token usage extracted - input: ${usage.inputTokens}, output: ${usage.outputTokens}, cacheWrite: ${usage.cacheWriteTokens}, cacheRead: ${usage.cacheReadTokens}`);
      // Update statistics
      this.stats.totalInputTokens += usage.inputTokens;
      this.stats.totalOutputTokens += usage.outputTokens;
      this.stats.totalCacheWriteTokens += usage.cacheWriteTokens;
      this.stats.totalCacheReadTokens += usage.cacheReadTokens;

      // Update per-model usage
      const modelStats = this.stats.modelUsage.get(usage.model) || { calls: 0, tokens: 0 };
      modelStats.calls++;
      modelStats.tokens += usage.inputTokens + usage.outputTokens;
      this.stats.modelUsage.set(usage.model, modelStats);

      // Update current context window size
      // Context = input tokens + cache write + cache read (total tokens in context)
      this.currentContextSize = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;

      // Track for burn rate calculation (include cache writes as they count toward quota)
      const totalTokensForBurn = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
      this.recentUsageEvents.push({
        timestamp: usage.timestamp,
        tokens: totalTokensForBurn
      });
      this.pruneOldUsageEvents();

      // Emit event
      this._onTokenUsage.fire(usage);
    }

    // Extract tool_use from assistant message content blocks
    if (event.type === 'assistant' && event.message?.content) {
      this.extractToolUsesFromContent(event.message.content, event.timestamp);
    }

    // Extract tool_result from user message content blocks
    if (event.type === 'user' && event.message?.content) {
      this.extractToolResultsFromContent(event.message.content, event.timestamp);
    }

    // Add to timeline
    this.addTimelineEvent(event);
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
          return {
            type: 'user_prompt',
            timestamp: event.timestamp,
            description: promptText,
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
          metadata: { isError: event.result?.is_error, toolName }
        };
      }

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
      const textBlock = content.find((c: any) => c.type === 'text' && c.text);
      text = textBlock?.text || '';
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
        if (block && typeof block === 'object' && (block as any).type === 'text' && (block as any).text) {
          textParts.push((block as any).text);
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
      if (block && typeof block === 'object' && (block as any).type === 'tool_use') {
        const toolUse = block as { type: string; id: string; name: string; input: Record<string, unknown> };

        // Store pending call for duration calculation
        this.pendingToolCalls.set(toolUse.id, {
          toolUseId: toolUse.id,
          name: toolUse.name,
          startTime: new Date(timestamp)
        });

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

        // Emit tool call event
        this._onToolCall.fire({
          name: toolUse.name,
          input: toolUse.input,
          timestamp: new Date(timestamp)
        });
        this.stats.toolCalls.push({
          name: toolUse.name,
          input: toolUse.input,
          timestamp: new Date(timestamp)
        });
      }
    }
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
      if (block && typeof block === 'object' && (block as any).type === 'tool_result') {
        const toolResult = block as { type: string; tool_use_id: string; content?: unknown; is_error?: boolean };

        const pending = this.pendingToolCalls.get(toolResult.tool_use_id);
        if (pending) {
          // Calculate duration
          const endTime = new Date(timestamp);
          const duration = endTime.getTime() - pending.startTime.getTime();

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
}
