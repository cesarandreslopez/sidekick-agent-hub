/**
 * @fileoverview Tree data provider for displaying subagent activity.
 *
 * This module provides a TreeDataProvider implementation that shows
 * running and completed subagents spawned during Claude Code sessions.
 * It integrates with SessionMonitor to detect subagent activity from
 * timeline events and displays them in the Session Monitor activity bar.
 *
 * Key features:
 * - Hierarchical display of nested subagents (parent → children)
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
import { scanSubagentTraces } from 'sidekick-shared/dist/parsers/subagentTraceParser';
import type { SubagentTrace } from 'sidekick-shared/dist/parsers/subagentTraceParser';

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

  /** Child subagents (for hierarchical display) */
  children: SubagentItem[];
}

/**
 * Tree data provider for subagent activity during Claude Code sessions.
 *
 * Monitors timeline events for subagent spawning indicators and tracks
 * their lifecycle. Uses the shared trace parser to build hierarchical
 * parent-child trees when scan data is available.
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

  /** Map of agent ID to SubagentItem (includes all agents, flat index) */
  private subagents: Map<string, SubagentItem> = new Map();

  /** Top-level agents for getChildren(undefined) */
  private topLevelAgents: SubagentItem[] = [];

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
        this.topLevelAgents = [];
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
      // Re-scan with trace parser to pick up hierarchy
      this.scanForAgentFiles();
      return;
    }

    // Only detect subagents from tool_call events
    if (event.type !== 'tool_call') {
      return;
    }

    // Detect Task tool calls — the new rich formatters produce "Task: [Explore] description"
    const isTaskTool = event.metadata?.toolName === 'Task';
    const description = event.description.toLowerCase();
    const isSubagentKeyword = description.includes('subagent') ||
        description.includes('sidechain') ||
        description.includes('spawned');

    if (!isTaskTool && !isSubagentKeyword) {
      return;
    }

    // Generate sequential worker ID
    const agentId = `worker-${this.subagents.size + 1}`;

    // Extract agent type — prefer from rich formatted description (e.g., "Task: [Explore] search auth")
    let agentType = this.detectAgentType(event.description);
    let agentDescription: string | undefined;

    // Parse rich Task tool summary format: "Task: [Type] description"
    const taskMatch = event.description.match(/Task:\s*\[(\w+)\]\s*(.*)/);
    if (taskMatch) {
      const rawType = taskMatch[1];
      agentType = this.classifyAgentType(rawType);
      agentDescription = taskMatch[2] || undefined;
    }

    // Create subagent item (always starts as running)
    const item: SubagentItem = {
      id: agentId,
      label: `${agentId} (${agentType})`,
      type: 'running',
      agentType,
      transcriptPath: undefined,
      timestamp: new Date(event.timestamp),
      description: agentDescription,
      children: [],
    };

    this.subagents.set(agentId, item);
    this.topLevelAgents.push(item);
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
   * Converts a SubagentTrace tree into a SubagentItem tree.
   */
  private traceToItem(trace: SubagentTrace): SubagentItem {
    const agentType = this.classifyAgentType(trace.agentType);
    const label = `${trace.agentId.substring(0, 8)} (${agentType})`;
    const children = trace.children.map(c => this.traceToItem(c));

    const item: SubagentItem = {
      id: trace.agentId,
      label,
      type: trace.stats.endTime ? 'completed' : 'running',
      agentType,
      transcriptPath: this.findTranscriptPath(trace.agentId),
      timestamp: trace.stats.startTime || new Date(),
      inputTokens: trace.stats.inputTokens,
      outputTokens: trace.stats.outputTokens,
      durationMs: trace.stats.durationMs,
      description: trace.description,
      children,
    };

    // Register in flat map for lookup
    this.subagents.set(trace.agentId, item);
    return item;
  }

  /**
   * Scans the session directory for existing agent transcript files.
   *
   * First tries the trace parser for hierarchical results, then
   * falls back to flat file scanning for backward compatibility.
   */
  private scanForAgentFiles(): void {
    if (!this.sessionDir) {
      return;
    }

    // Try hierarchical scan via trace parser
    const sessionId = this.sessionMonitor.getSessionId();
    if (sessionId) {
      try {
        const traces = scanSubagentTraces(this.sessionDir, sessionId);
        if (traces.length > 0) {
          this.applyTraceResults(traces);
          return;
        }
      } catch {
        // Fall through to flat scan
      }
    }

    // Fallback: flat file scan (original behavior)
    this.flatScanForAgentFiles();
  }

  /**
   * Applies trace parser results, preserving any live-tracked running agents.
   */
  private applyTraceResults(traces: SubagentTrace[]): void {
    // Save running agents (from timeline events) to merge back
    const runningAgents: SubagentItem[] = [];
    for (const item of this.subagents.values()) {
      if (item.type === 'running') {
        runningAgents.push(item);
      }
    }

    // Build tree from traces
    this.subagents.clear();
    this.topLevelAgents = traces.map(t => this.traceToItem(t));

    // Re-add running agents that weren't found in trace results
    for (const running of runningAgents) {
      if (!this.subagents.has(running.id)) {
        this.subagents.set(running.id, running);
        this.topLevelAgents.push(running);
      }
    }

    this.detectParallelExecution();
    this.refresh();
  }

  /**
   * Flat scan fallback — original behavior for backward compatibility.
   */
  private flatScanForAgentFiles(): void {
    if (!this.sessionDir) return;

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
          const existing = this.subagents.get(agentId);
          if (existing) {
            // Already tracked — still enrich with stats if available
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
            description: stats?.description,
            children: [],
          };

          this.subagents.set(agentId, item);
          this.topLevelAgents.push(item);
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
    const collapsible = element.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const treeItem = new vscode.TreeItem(element.label, collapsible);

    // Set icon based on status
    if (element.type === 'running') {
      treeItem.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (element.children.length > 0) {
      treeItem.iconPath = new vscode.ThemeIcon('symbol-class');
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
      if (element.children.length > 0) {
        descParts.push(`${element.children.length} child${element.children.length > 1 ? 'ren' : ''}`);
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
      if (element.children.length > 0) tooltipParts.push(`${element.children.length} child agent(s)`);
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
   * Returns top-level subagents for root, child subagents for parents.
   *
   * @param element - Parent element (undefined for root)
   * @returns Array of child items
   */
  getChildren(element?: SubagentItem): SubagentItem[] {
    if (element) {
      return element.children;
    }

    // Return top-level subagents sorted by timestamp (most recent first)
    return [...this.topLevelAgents]
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
