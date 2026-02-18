/**
 * @fileoverview Tree data provider for displaying subagent activity.
 *
 * This module provides a TreeDataProvider implementation that shows
 * running and completed subagents spawned during Claude Code sessions.
 * It integrates with SessionMonitor to detect subagent activity from
 * timeline events and displays them in the Session Monitor activity bar.
 *
 * Key features:
 * - Detects subagents from timeline event descriptions
 * - Shows running (spinner) vs completed (check) status
 * - Displays agent type (Explore, Plan, Task, Unknown)
 * - Click-to-open transcript files when available
 * - Scans session directory for existing agent files
 *
 * @module providers/SubagentTreeProvider
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SessionMonitor } from '../services/SessionMonitor';
import { TimelineEvent, SubagentStats } from '../types/claudeSession';

/**
 * Type for subagent classification based on description keywords.
 */
type AgentType = 'Explore' | 'Plan' | 'Task' | 'Unknown';

/**
 * Represents a subagent item in the tree view.
 */
interface SubagentItem {
  /** Unique agent identifier extracted from description */
  id: string;

  /** Display name (e.g., "worker-1 (Explore)") */
  label: string;

  /** Running or completed status */
  type: 'running' | 'completed';

  /** Agent type based on description keywords */
  agentType: AgentType;

  /** Path to agent transcript file if available */
  transcriptPath: string | undefined;

  /** When the agent was first detected */
  timestamp: Date;

  /** Total input tokens consumed */
  inputTokens?: number;

  /** Total output tokens consumed */
  outputTokens?: number;

  /** Duration in milliseconds */
  durationMs?: number;

  /** Short description */
  description?: string;

  /** Whether this agent ran in parallel with another */
  isParallel?: boolean;
}

/**
 * Tree data provider for subagent activity during Claude Code sessions.
 *
 * Monitors timeline events for subagent spawning indicators and tracks
 * their lifecycle. Provides click-to-open functionality for transcript files.
 *
 * @example
 * ```typescript
 * const sessionMonitor = new SessionMonitor();
 * const subagentProvider = new SubagentTreeProvider(sessionMonitor);
 *
 * // Register as tree data provider
 * vscode.window.registerTreeDataProvider('sidekick.subagents', subagentProvider);
 *
 * // Provider automatically updates when timeline events fire
 * ```
 */
export class SubagentTreeProvider implements vscode.TreeDataProvider<SubagentItem>, vscode.Disposable {
  /** View type identifier for registration */
  static readonly viewType = 'sidekick.subagents';

  /** Event emitter for tree data changes */
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SubagentItem | undefined>();

  /** Event fired when tree data changes */
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Map of agent ID to SubagentItem */
  private subagents: Map<string, SubagentItem> = new Map();

  /** Directory containing session/agent files */
  private sessionDir: string | null = null;

  /** Subscriptions to dispose */
  private disposables: vscode.Disposable[] = [];

  /**
   * Creates a new SubagentTreeProvider.
   *
   * Subscribes to SessionMonitor events to detect session starts
   * and timeline events indicating subagent activity.
   *
   * @param sessionMonitor - The session monitor to subscribe to
   */
  constructor(private readonly sessionMonitor: SessionMonitor) {
    // Subscribe to session start to initialize session directory
    this.disposables.push(
      sessionMonitor.onSessionStart((sessionPath: string) => {
        this.sessionDir = path.dirname(sessionPath);
        this.subagents.clear();
        this.scanForAgentFiles();
        this.refresh();
      })
    );

    // Subscribe to timeline events for subagent detection
    this.disposables.push(
      sessionMonitor.onTimelineEvent((event: TimelineEvent) => {
        this.handleTimelineEvent(event);
      })
    );

    // Initialize from current session if available
    const currentSessionPath = sessionMonitor.getSessionPath();
    if (currentSessionPath) {
      this.sessionDir = path.dirname(currentSessionPath);
      this.scanForAgentFiles();
    }
  }

  /**
   * Handles a timeline event to detect subagent activity.
   *
   * Checks event descriptions for subagent-related keywords and
   * extracts agent information when found.
   *
   * @param event - Timeline event from SessionMonitor
   */
  private handleTimelineEvent(event: TimelineEvent): void {
    // Handle Task tool_result events to mark subagents as completed
    if (event.type === 'tool_result' && event.metadata?.toolName === 'Task') {
      this.markOldestRunningAsCompleted();
      return;
    }

    const description = event.description.toLowerCase();

    // Check for subagent-related keywords (only for tool_call events)
    if (event.type !== 'tool_call') {
      return;
    }

    if (!description.includes('subagent') &&
        !description.includes('sidechain') &&
        !description.includes('spawned')) {
      return;
    }

    // Generate sequential worker ID (don't try to extract from description)
    const agentId = `worker-${this.subagents.size + 1}`;

    // Detect agent type from description
    const agentType = this.detectAgentType(event.description);

    // Create subagent item (always starts as running)
    const item: SubagentItem = {
      id: agentId,
      label: `${agentId} (${agentType})`,
      type: 'running',
      agentType,
      transcriptPath: undefined,
      timestamp: new Date(event.timestamp)
    };

    this.subagents.set(agentId, item);
    this.refresh();
  }

  /**
   * Marks the oldest running subagent as completed.
   * Called when a Task tool_result event is received.
   */
  private markOldestRunningAsCompleted(): void {
    // Find oldest running subagent (by timestamp)
    let oldestRunning: SubagentItem | undefined;
    for (const item of this.subagents.values()) {
      if (item.type === 'running') {
        if (!oldestRunning || item.timestamp < oldestRunning.timestamp) {
          oldestRunning = item;
        }
      }
    }

    if (oldestRunning) {
      oldestRunning.type = 'completed';
      // Try to find transcript now that it's completed
      oldestRunning.transcriptPath = this.findTranscriptPath(oldestRunning.id);
      this.refresh();
    }
  }

  /**
   * Detects agent type from description keywords.
   *
   * @param description - Event description to analyze
   * @returns Agent type classification
   */
  private detectAgentType(description: string): AgentType {
    const lower = description.toLowerCase();

    if (lower.includes('explore') || lower.includes('research') || lower.includes('investigate')) {
      return 'Explore';
    }

    if (lower.includes('plan') || lower.includes('architect') || lower.includes('design')) {
      return 'Plan';
    }

    if (lower.includes('task') || lower.includes('execute') || lower.includes('implement') || lower.includes('build')) {
      return 'Task';
    }

    return 'Unknown';
  }

  /**
   * Finds the transcript file path for an agent.
   *
   * @param agentId - Agent identifier
   * @returns Path to transcript if exists, undefined otherwise
   */
  private findTranscriptPath(agentId: string): string | undefined {
    if (!this.sessionDir) {
      return undefined;
    }

    const transcriptPath = path.join(this.sessionDir, `agent-${agentId}.jsonl`);
    return fs.existsSync(transcriptPath) ? transcriptPath : undefined;
  }

  /**
   * Scans the session directory for existing agent transcript files.
   *
   * Discovers completed agents that may have been created before
   * monitoring started or without detectable timeline events.
   */
  private scanForAgentFiles(): void {
    if (!this.sessionDir) {
      return;
    }

    // Enrich with SubagentStats from monitor (has token metrics)
    const agentStats = this.sessionMonitor.getSubagentStats();
    const statsMap = new Map<string, SubagentStats>();
    for (const s of agentStats) {
      statsMap.set(s.agentId, s);
    }

    try {
      const files = fs.readdirSync(this.sessionDir);
      const agentFilePattern = /^agent-(.*)\.jsonl$/;

      for (const file of files) {
        const match = file.match(agentFilePattern);
        if (match) {
          const agentId = match[1];

          // Skip if already tracked
          if (this.subagents.has(agentId)) {
            // But still enrich with stats if available
            const existing = this.subagents.get(agentId)!;
            const stats = statsMap.get(agentId);
            if (stats) {
              this.enrichFromStats(existing, stats);
            }
            continue;
          }

          // Add discovered agent
          const transcriptPath = path.join(this.sessionDir, file);
          const stats = statsMap.get(agentId);
          const agentType = this.classifyAgentType(stats?.agentType);
          const item: SubagentItem = {
            id: agentId,
            label: `${agentId.substring(0, 8)} (${agentType})`,
            type: 'completed',
            agentType,
            transcriptPath,
            timestamp: stats?.startTime || new Date(),
            inputTokens: stats?.inputTokens,
            outputTokens: stats?.outputTokens,
            durationMs: stats?.durationMs,
            description: stats?.description
          };

          this.subagents.set(agentId, item);
        }
      }

      // Detect parallel execution (agents with overlapping time ranges)
      this.detectParallelExecution();

      this.refresh();
    } catch {
      // Directory read failed - ignore, will update on events
    }
  }

  /**
   * Enriches an existing SubagentItem with data from SubagentStats.
   */
  private enrichFromStats(item: SubagentItem, stats: SubagentStats): void {
    item.inputTokens = stats.inputTokens;
    item.outputTokens = stats.outputTokens;
    item.durationMs = stats.durationMs;
    if (stats.description && !item.description) {
      item.description = stats.description;
    }
    if (stats.agentType) {
      item.agentType = this.classifyAgentType(stats.agentType);
      // If classification returned Unknown but we have a description, try keyword detection
      if (item.agentType === 'Unknown' && stats.description) {
        const detected = this.detectAgentType(stats.description);
        if (detected !== 'Unknown') {
          item.agentType = detected;
        }
      }
      item.label = `${item.id.substring(0, 8)} (${item.agentType})`;
    }
  }

  /**
   * Classifies a raw agent type string into our AgentType enum.
   */
  private classifyAgentType(raw?: string): AgentType {
    if (!raw) return 'Unknown';
    const lower = raw.toLowerCase();
    if (lower.includes('explore') || lower === 'explore') return 'Explore';
    if (lower.includes('plan') || lower === 'plan') return 'Plan';
    if (lower.includes('task') || lower.includes('bash') || lower.includes('general')) return 'Task';
    return 'Unknown';
  }

  /**
   * Detects agents that ran in parallel (overlapping time ranges within 100ms).
   */
  private detectParallelExecution(): void {
    const agents = Array.from(this.subagents.values())
      .filter(a => a.timestamp && a.durationMs);

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const aStart = a.timestamp.getTime();
      const aEnd = aStart + (a.durationMs || 0);

      for (let j = i + 1; j < agents.length; j++) {
        const b = agents[j];
        const bStart = b.timestamp.getTime();
        const bEnd = bStart + (b.durationMs || 0);

        // Check for overlap (with 100ms tolerance)
        if (aStart < bEnd + 100 && bStart < aEnd + 100) {
          a.isParallel = true;
          b.isParallel = true;
        }
      }
    }
  }

  /**
   * Gets tree item representation for display.
   *
   * @param element - Subagent item to convert
   * @returns VS Code TreeItem for display
   */
  getTreeItem(element: SubagentItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);

    // Set icon based on status
    if (element.type === 'running') {
      treeItem.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (element.isParallel) {
      treeItem.iconPath = new vscode.ThemeIcon('layers');
    } else {
      treeItem.iconPath = new vscode.ThemeIcon('check');
    }

    // Build description with metrics, falling back to status text
    if (element.type === 'running') {
      treeItem.description = 'Running...';
    } else {
      const descParts: string[] = [];
      if (element.inputTokens || element.outputTokens) {
        const totalK = Math.round(((element.inputTokens || 0) + (element.outputTokens || 0)) / 1000);
        descParts.push(`${totalK}K tok`);
      }
      if (element.durationMs) {
        const secs = Math.round(element.durationMs / 1000);
        descParts.push(secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`);
      }
      if (element.isParallel) {
        descParts.push('parallel');
      }
      treeItem.description = descParts.length > 0 ? descParts.join(' | ') : 'Completed';
    }

    // Set click-to-open command if transcript exists
    if (element.transcriptPath && fs.existsSync(element.transcriptPath)) {
      treeItem.command = {
        command: 'vscode.open',
        title: 'Open Transcript',
        arguments: [vscode.Uri.file(element.transcriptPath)]
      };
      const tooltipParts = [element.transcriptPath];
      if (element.description) tooltipParts.unshift(element.description);
      if (element.isParallel) tooltipParts.push('Ran in parallel with other agents');
      treeItem.tooltip = tooltipParts.join('\n');
    } else {
      treeItem.tooltip = element.description || 'Transcript not yet available';
    }

    treeItem.contextValue = element.type === 'running' ? 'runningSubagent' : 'completedSubagent';

    return treeItem;
  }

  /**
   * Gets children for a tree element.
   *
   * Returns all subagents for root, empty for children (flat structure).
   *
   * @param element - Parent element (undefined for root)
   * @returns Array of child items
   */
  getChildren(element?: SubagentItem): SubagentItem[] {
    // Flat structure - no children for items
    if (element) {
      return [];
    }

    // Return all subagents sorted by timestamp (most recent first)
    return Array.from(this.subagents.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Triggers a refresh of the tree view.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Disposes resources.
   */
  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
