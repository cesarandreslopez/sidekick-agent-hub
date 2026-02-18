/**
 * @fileoverview Tree data provider for displaying files touched during Claude Code sessions.
 *
 * This provider shows a flat list of files that have been read, written, or edited
 * by Claude Code during the current session. It extracts file paths from tool calls
 * (Read, Write, Edit, MultiEdit) and displays them as clickable tree items.
 *
 * Features:
 * - Extracts file paths from Read/Write/Edit/MultiEdit/Bash tool calls
 * - Deduplicates files (each file appears once)
 * - Displays operation type (read vs write/edit)
 * - Shows line change statistics (+additions / -deletions) for modified files
 * - Click to open file in editor
 * - Real-time updates from SessionMonitor events
 *
 * @module providers/TempFilesTreeProvider
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { ToolCall } from '../types/claudeSession';
import { scanSubagentDir } from '../services/SubagentFileScanner';
import { log } from '../services/Logger';
import { calculateLineChanges } from '../utils/lineChangeCalculator';

/**
 * Represents a file touched during the Claude Code session.
 */
export interface TempFileItem {
  /** Display label (filename extracted from path) */
  label: string;

  /** Full file path */
  path: string;

  /** When the file was touched */
  timestamp: Date;

  /** Type of operation performed on the file */
  operation: 'read' | 'write' | 'edit';

  /** Number of lines added to this file */
  additions: number;

  /** Number of lines deleted from this file */
  deletions: number;
}

/**
 * TreeDataProvider for displaying files touched during Claude Code sessions.
 *
 * Shows a flat list of files sorted by most recent first. Each file can be
 * clicked to open in the editor.
 *
 * @example
 * ```typescript
 * const provider = new TempFilesTreeProvider(sessionMonitor);
 * vscode.window.registerTreeDataProvider('sidekick.tempFiles', provider);
 * ```
 */
export class TempFilesTreeProvider implements vscode.TreeDataProvider<TempFileItem>, vscode.Disposable {
  /** Event emitter for tree data changes */
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TempFileItem | undefined | null | void>();

  /** Event that fires when tree data changes */
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Files touched during the session */
  private tempFiles: TempFileItem[] = [];

  /** Set of seen file paths for deduplication */
  private seenFiles: Set<string> = new Set();

  /** Disposables for cleanup */
  private disposables: vscode.Disposable[] = [];

  /** Session directory (contains session .jsonl file) */
  private sessionDir: string | null = null;

  /** Session ID (used to find subagents directory) */
  private sessionId: string | null = null;

  /** Set of scanned agent files to avoid re-processing */
  private scannedAgentFiles: Set<string> = new Set();

  /**
   * Creates a new TempFilesTreeProvider.
   *
   * @param sessionMonitor - SessionMonitor instance for tool call events
   */
  constructor(private readonly sessionMonitor: SessionMonitor) {
    // Subscribe to tool call events
    this.disposables.push(
      this.sessionMonitor.onToolCall((call) => this.handleToolCall(call))
    );

    // Subscribe to session start to clear state and set session directory
    this.disposables.push(
      this.sessionMonitor.onSessionStart((sessionPath: string) => {
        this.clear();
        this.sessionDir = path.dirname(sessionPath);
        this.sessionId = this.sessionMonitor.getProvider().getSessionId(sessionPath);
        this.scannedAgentFiles.clear();
        this.refresh();
      })
    );

    // Initialize from existing session data if available
    if (this.sessionMonitor.isActive()) {
      const sessionPath = this.sessionMonitor.getSessionPath();
      if (sessionPath) {
        this.sessionDir = path.dirname(sessionPath);
        this.sessionId = this.sessionMonitor.getProvider().getSessionId(sessionPath);
      }
      const stats = this.sessionMonitor.getStats();
      for (const call of stats.toolCalls) {
        this.handleToolCall(call);
      }
      // Scan for subagent files
      this.scanSubagentFiles();
    }

    // Periodically scan for new subagent files (every 2 seconds, only when session is active)
    const scanInterval = setInterval(() => {
      if (this.sessionMonitor.isActive()) {
        this.scanSubagentFiles();
      }
    }, 2000);
    this.disposables.push({ dispose: () => clearInterval(scanInterval) });

    log('TempFilesTreeProvider initialized');
  }

  /**
   * Handles tool call events to extract file paths.
   *
   * @param call - Tool call from SessionMonitor
   */
  private handleToolCall(call: ToolCall): void {
    const toolName = call.name;

    // Only process file-related tools
    if (!['Read', 'Write', 'Edit', 'MultiEdit', 'Bash'].includes(toolName)) {
      return;
    }

    const timestamp = call.timestamp;

    // Handle Bash commands that touch files
    if (toolName === 'Bash') {
      const command = call.input.command as string | undefined;
      if (command) {
        const filePaths = this.extractFilePathsFromBash(command);
        for (const filePath of filePaths) {
          this.addFile(filePath, 'write', timestamp, 0, 0);
        }
      }
      return;
    }

    // Handle MultiEdit which has an edits array
    if (toolName === 'MultiEdit' && call.input.edits) {
      const edits = call.input.edits as Array<{ file_path?: string; path?: string; old_string?: string; new_string?: string }>;
      // Group edits by file path and calculate line changes per file
      const fileChanges = new Map<string, { additions: number; deletions: number }>();

      for (const edit of edits) {
        const filePath = edit.file_path || edit.path;
        if (filePath && typeof filePath === 'string') {
          const changes = calculateLineChanges('Edit', {
            old_string: edit.old_string || '',
            new_string: edit.new_string || ''
          });

          const existing = fileChanges.get(filePath) || { additions: 0, deletions: 0 };
          existing.additions += changes.additions;
          existing.deletions += changes.deletions;
          fileChanges.set(filePath, existing);
        }
      }

      for (const [filePath, changes] of fileChanges) {
        this.addFile(filePath, 'edit', timestamp, changes.additions, changes.deletions);
      }
      return;
    }

    // Handle Read/Write/Edit which have file_path or path
    const filePath = (call.input.file_path || call.input.path) as string | undefined;
    if (!filePath || typeof filePath !== 'string') {
      return;
    }

    // Calculate line changes for Write/Edit operations
    const lineChanges = calculateLineChanges(toolName, call.input);

    // Determine operation type
    let operation: 'read' | 'write' | 'edit';
    switch (toolName) {
      case 'Read':
        operation = 'read';
        break;
      case 'Write':
        operation = 'write';
        break;
      case 'Edit':
      case 'MultiEdit':
        operation = 'edit';
        break;
      default:
        return;
    }

    this.addFile(filePath, operation, timestamp, lineChanges.additions, lineChanges.deletions);
  }

  /**
   * Extracts file paths from bash commands that create or modify files.
   *
   * Handles common patterns:
   * - touch file1 file2 ...
   * - echo/cat/printf ... > file or >> file
   * - cp/mv src dest
   * - mkdir [-p] dir
   * - rm file (for tracking deletions)
   *
   * @param command - The bash command string
   * @returns Array of extracted file paths
   */
  private extractFilePathsFromBash(command: string): string[] {
    const filePaths: string[] = [];

    // touch command: touch file1 file2 ...
    const touchMatch = command.match(/^\s*touch\s+(.+)$/);
    if (touchMatch) {
      const args = this.parseBashArgs(touchMatch[1]);
      // Filter out flags (starting with -)
      const files = args.filter(arg => !arg.startsWith('-'));
      filePaths.push(...files);
    }

    // Output redirection: ... > file or ... >> file
    const redirectMatch = command.match(/>{1,2}\s*([^\s|&;]+)/g);
    if (redirectMatch) {
      for (const match of redirectMatch) {
        const file = match.replace(/^>{1,2}\s*/, '').trim();
        if (file && !file.startsWith('/dev/')) {
          filePaths.push(file);
        }
      }
    }

    // cp command: cp [-flags] src dest
    const cpMatch = command.match(/^\s*cp\s+(?:-[a-zA-Z]+\s+)*(.+)$/);
    if (cpMatch) {
      const args = this.parseBashArgs(cpMatch[1]).filter(arg => !arg.startsWith('-'));
      // Last argument is the destination
      if (args.length >= 2) {
        filePaths.push(args[args.length - 1]);
      }
    }

    // mv command: mv [-flags] src dest
    const mvMatch = command.match(/^\s*mv\s+(?:-[a-zA-Z]+\s+)*(.+)$/);
    if (mvMatch) {
      const args = this.parseBashArgs(mvMatch[1]).filter(arg => !arg.startsWith('-'));
      // Last argument is the destination
      if (args.length >= 2) {
        filePaths.push(args[args.length - 1]);
      }
    }

    // mkdir command: mkdir [-p] dir1 dir2 ...
    const mkdirMatch = command.match(/^\s*mkdir\s+(.+)$/);
    if (mkdirMatch) {
      const args = this.parseBashArgs(mkdirMatch[1]).filter(arg => !arg.startsWith('-'));
      filePaths.push(...args);
    }

    // rm command: rm [-rf] file1 file2 ...
    const rmMatch = command.match(/^\s*rm\s+(.+)$/);
    if (rmMatch) {
      const args = this.parseBashArgs(rmMatch[1]).filter(arg => !arg.startsWith('-'));
      filePaths.push(...args);
    }

    return filePaths;
  }

  /**
   * Parses bash arguments, handling quoted strings.
   *
   * @param argsString - String containing bash arguments
   * @returns Array of parsed arguments
   */
  private parseBashArgs(argsString: string): string[] {
    const args: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    for (const char of argsString) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }

      if (char === '\\' && !inSingleQuote) {
        escaped = true;
        continue;
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }

      current += char;
    }

    if (current) {
      args.push(current);
    }

    return args;
  }

  /**
   * Adds a file to the temp files list or updates existing entry.
   *
   * If the file has already been seen, accumulates line change statistics
   * and updates the timestamp and operation type.
   *
   * @param filePath - Full file path
   * @param operation - Type of operation
   * @param timestamp - When the file was touched
   * @param additions - Number of lines added (default 0)
   * @param deletions - Number of lines deleted (default 0)
   */
  private addFile(
    filePath: string,
    operation: 'read' | 'write' | 'edit',
    timestamp: Date,
    additions: number = 0,
    deletions: number = 0
  ): void {
    // Check if file already exists
    if (this.seenFiles.has(filePath)) {
      // Find and update existing item
      const existingItem = this.tempFiles.find(item => item.path === filePath);
      if (existingItem) {
        // Accumulate line changes
        existingItem.additions += additions;
        existingItem.deletions += deletions;
        // Update timestamp to most recent touch
        existingItem.timestamp = timestamp;
        // Upgrade operation if needed (read -> edit/write)
        if (operation !== 'read') {
          existingItem.operation = operation;
        }
        this.refresh();
      }
      return;
    }

    // Add to tracking
    this.seenFiles.add(filePath);

    // Create temp file item
    const item: TempFileItem = {
      label: path.basename(filePath),
      path: filePath,
      timestamp,
      operation,
      additions,
      deletions
    };

    this.tempFiles.push(item);
    this.refresh();
  }

  /**
   * Clears all tracked files.
   */
  private clear(): void {
    this.tempFiles = [];
    this.seenFiles.clear();
    this.scannedAgentFiles.clear();
    this.sessionId = null;
    log('TempFilesTreeProvider cleared');
  }

  /**
   * Scans subagent JSONL files for tool calls using the shared scanner.
   * Called periodically to pick up subagent file operations.
   */
  private scanSubagentFiles(): void {
    if (!this.sessionDir || !this.sessionId) {
      return;
    }

    // OpenCode does not expose Claude-style subagent JSONL directories.
    if (this.sessionMonitor.getProvider().id !== 'claude-code') {
      return;
    }

    // Use the shared SubagentFileScanner
    const subagentStats = scanSubagentDir(this.sessionDir, this.sessionId);

    // Track which agents we've already processed
    let hasNewData = false;

    for (const agent of subagentStats) {
      // Skip if we've already scanned this agent's file
      const agentFile = `agent-${agent.agentId}.jsonl`;
      if (this.scannedAgentFiles.has(agentFile)) {
        continue;
      }

      // Process tool calls from this agent
      for (const call of agent.toolCalls) {
        this.handleToolCall(call);
      }

      this.scannedAgentFiles.add(agentFile);
      hasNewData = true;
    }

    if (hasNewData) {
      this.refresh();
    }
  }

  /**
   * Gets a TreeItem representation for a TempFileItem.
   *
   * @param element - The TempFileItem to represent
   * @returns TreeItem for display
   */
  getTreeItem(element: TempFileItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);

    // Set command to open file on click
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(element.path)]
    };

    // Set icon based on operation
    item.iconPath = new vscode.ThemeIcon(
      element.operation === 'read' ? 'file' : 'edit'
    );

    // Set tooltip with full path, operation, and line changes
    const formattedTime = element.timestamp.toLocaleTimeString();
    const hasChanges = element.additions > 0 || element.deletions > 0;
    const changeInfo = hasChanges ? `\n+${element.additions} / -${element.deletions} lines` : '';
    item.tooltip = `${element.path}\n${element.operation} at ${formattedTime}${changeInfo}`;

    // Set description with line changes (for write/edit) and relative timestamp
    const relativeTime = this.formatRelativeTime(element.timestamp);
    if (hasChanges) {
      item.description = `+${element.additions} / -${element.deletions} • ${relativeTime}`;
    } else {
      item.description = relativeTime;
    }

    // Set resourceUri to enable file icon theme
    item.resourceUri = vscode.Uri.file(element.path);

    // Set context value for potential context menu actions
    item.contextValue = 'tempFile';

    return item;
  }

  /**
   * Gets children for a given element.
   *
   * @param element - Parent element (undefined for root)
   * @returns Array of TempFileItems (flat structure)
   */
  getChildren(element?: TempFileItem): TempFileItem[] {
    // Flat structure - no children for file items
    if (element) {
      return [];
    }

    // Return files sorted by timestamp descending (most recent first)
    return [...this.tempFiles].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Formats a relative time string (e.g., "2m ago").
   *
   * @param timestamp - The timestamp to format
   * @returns Relative time string
   */
  private formatRelativeTime(timestamp: Date): string {
    const now = Date.now();
    const diff = now - timestamp.getTime();

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) {
      return `${seconds}s ago`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  /**
   * Fires the tree data changed event to refresh the view.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    log('TempFilesTreeProvider disposed');
  }
}
