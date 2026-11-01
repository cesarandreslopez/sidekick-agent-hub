/**
 * @fileoverview Tree data provider for displaying subagent activity.
 *
 * Shows the subagents spawned during a session, one row per spawn. Rows come
 * from the session's subagent lifecycles (the shared EventAggregator tracks
 * every `Agent` / `Task` call and keeps a background agent running until its
 * task notification arrives), joined with the transcripts Claude Code writes
 * under `<sessionDir>/<sessionId>/subagents/` on the spawning tool_use id or
 * the agent id.
 *
 * Key features:
 * - Hierarchical display of nested subagents (parent → children)
 * - Shows running (spinner) vs completed (check) status
 * - Displays agent type (Explore, Plan, Task, Unknown)
 * - Click-to-open transcript files
 * - Token and duration stats from the transcripts, parallel-run detection
 *
 * @module providers/SubagentTreeProvider
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { TimelineEvent, SubagentStats } from '../types/claudeSession';
import {
  formatTokenCount,
  isSubagentSpawnTool,
  scanSubagentTraces,
  type SubagentLifecycle,
  type SubagentTrace,
} from 'sidekick-shared';

/**
 * Type for subagent classification based on description keywords.
 */
type AgentType = 'Explore' | 'Plan' | 'Task' | 'Unknown';

/**
 * Represents a subagent item in the tree view.
 */
interface SubagentItem {
  /** Row key: the spawning tool_use id when known, else the agent id */
  id: string;

  /** Claude Code agent id (the `agent-<id>.jsonl` name), once known */
  agentId?: string;

  /** Display name (e.g., "a1b2c3d4 (Explore)") */
  label: string;

  /** Running or completed status */
  type: 'running' | 'completed';

  /** How the agent ended (`failed`, `killed`, `stopped`, …), when known */
  outcome?: SubagentLifecycle['outcome'];

  /** Agent type based on description keywords */
  agentType: AgentType;

  /** Path to agent transcript file if available */
  transcriptPath: string | undefined;

  /** When the agent was spawned (or its transcript started) */
  timestamp: Date;

  /** Total input tokens consumed */
  inputTokens?: number;

  /** Total output tokens consumed */
  outputTokens?: number;

  /** Every billed token, cache included (`SubagentStats.totalTokens`) */
  totalTokens?: number;

  /** Duration in milliseconds */
  durationMs?: number;

  /** Short description */
  description?: string;

  /** Whether this agent ran in parallel with another */
  isParallel?: boolean;

  /** Child subagents (for hierarchical display) */
  children: SubagentItem[];
}

/** Options for {@link SubagentTreeProvider}. */
export interface SubagentTreeProviderOptions {
  /** Minimum gap between transcript rescans; requests in between coalesce. Default 1000 ms. */
  minRescanIntervalMs?: number;
}

const DEFAULT_MIN_RESCAN_INTERVAL_MS = 1_000;
const LABEL_DESCRIPTION_MAX = 40;
const SUBAGENT_KEYWORDS = /subagent|sidechain|spawned/i;
const AGENT_FILE = /^agent-.+\.(?:jsonl|meta\.json)$/;
const ENDED_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

/**
 * Tree data provider for subagent activity during Claude Code sessions.
 *
 * Rebuilds its rows from the monitor's subagent lifecycles whenever a spawn,
 * a spawn's result, or a background agent's notification arrives, and
 * enriches them with the shared trace parser's transcript data.
 *
 * @example
 * ```typescript
 * const sessionMonitor = new SessionMonitor();
 * const subagentProvider = new SubagentTreeProvider(sessionMonitor);
 *
 * // Register as tree data provider
 * vscode.window.registerTreeDataProvider('sidekick.subagents', subagentProvider);
 * ```
 */
export class SubagentTreeProvider
  implements vscode.TreeDataProvider<SubagentItem>, vscode.Disposable
{
  /** View type identifier for registration */
  static readonly viewType = 'sidekick.subagents';

  /** Event emitter for tree data changes */
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SubagentItem | undefined>();

  /** Event fired when tree data changes */
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Map of row id to SubagentItem (includes all agents, flat index) */
  private subagents: Map<string, SubagentItem> = new Map();

  /** Top-level agents for getChildren(undefined) */
  private topLevelAgents: SubagentItem[] = [];

  /** Directory containing session/agent files */
  private sessionDir: string | null = null;

  /** Subscriptions to dispose */
  private disposables: vscode.Disposable[] = [];

  /** Top-level transcript traces from the last scan */
  private traces: SubagentTrace[] = [];

  /** Names, sizes, and mtimes of the transcript files behind `traces` */
  private traceSignature: string | null = null;

  private lastTraceScanAt = 0;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly minRescanIntervalMs: number;

  /**
   * Creates a new SubagentTreeProvider.
   *
   * Subscribes to SessionMonitor events to detect session starts
   * and timeline events indicating subagent activity.
   *
   * @param sessionMonitor - The session monitor to subscribe to
   */
  constructor(
    private readonly sessionMonitor: SessionMonitor,
    options: SubagentTreeProviderOptions = {},
  ) {
    this.minRescanIntervalMs = Math.max(
      0,
      options.minRescanIntervalMs ?? DEFAULT_MIN_RESCAN_INTERVAL_MS,
    );

    // A new session: start over from its lifecycles and transcripts
    this.disposables.push(
      sessionMonitor.onSessionStart((sessionPath: string) => {
        this.sessionDir = path.dirname(sessionPath);
        this.resetTraces();
        this.rescanTraces();
        this.rebuild();
      }),
    );

    // Subscribe to timeline events for subagent detection
    this.disposables.push(
      sessionMonitor.onTimelineEvent((event: TimelineEvent) => {
        this.handleTimelineEvent(event);
      }),
    );

    // Initialize from current session if available
    const currentSessionPath = sessionMonitor.getSessionPath();
    if (currentSessionPath) {
      this.sessionDir = path.dirname(currentSessionPath);
      this.rescanTraces();
      this.rebuild();
    }
  }

  /**
   * A spawn (`Agent` / `Task` call) adds a row; its result or a background
   * agent's notification changes one, and means transcripts have grown, so
   * those also rescan the transcripts.
   *
   * @param event - Timeline event from SessionMonitor
   */
  private handleTimelineEvent(event: TimelineEvent): void {
    const spawnTool = isSubagentSpawnTool(event.metadata?.toolName);

    if (event.type === 'tool_call') {
      if (spawnTool || SUBAGENT_KEYWORDS.test(event.description)) this.rebuild();
      return;
    }

    if ((event.type === 'tool_result' || event.type === 'error') && spawnTool) {
      this.requestTraceRescan();
      this.rebuild();
    }
  }

  /** Rescans now when the last scan is old enough, else once the interval has passed. */
  private requestTraceRescan(): void {
    const wait = this.lastTraceScanAt + this.minRescanIntervalMs - Date.now();
    if (wait <= 0) {
      this.rescanTraces();
      return;
    }
    if (this.rescanTimer) return;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      if (this.rescanTraces()) this.rebuild();
    }, wait);
  }

  private resetTraces(): void {
    this.traces = [];
    this.traceSignature = null;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = undefined;
  }

  /**
   * Re-reads the session's subagent transcripts when their files changed.
   *
   * @returns Whether the traces changed
   */
  private rescanTraces(): boolean {
    this.lastTraceScanAt = Date.now();
    const sessionId = this.sessionMonitor.getSessionId();
    if (!this.sessionDir || !sessionId) {
      const changed = this.traces.length > 0;
      this.traces = [];
      this.traceSignature = null;
      return changed;
    }

    const subagentsDir = path.join(this.sessionDir, sessionId, 'subagents');
    const signature = directorySignature(subagentsDir);
    if (signature === this.traceSignature) return false;
    this.traceSignature = signature;
    try {
      this.traces = signature ? scanSubagentTraces(this.sessionDir, sessionId) : [];
    } catch {
      this.traces = [];
    }
    return true;
  }

  /**
   * Rebuilds the rows: one per spawn, transcript data joined in, nested
   * agents under their parents. Spawns with no transcript yet get a row from
   * their lifecycle alone.
   */
  private rebuild(): void {
    const lifecycles = this.sessionMonitor.getAggregatedMetrics().subagents ?? [];
    const { byTrace, unmatched } = this.matchLifecycles(lifecycles);

    this.subagents.clear();
    const rows = this.traces.map((trace) => this.traceToItem(trace, byTrace));
    for (const lifecycle of unmatched) {
      const item = this.lifecycleToItem(lifecycle);
      this.subagents.set(item.id, item);
      rows.push(item);
    }
    // Older Claude Code kept transcripts flat in the session directory.
    if (this.traces.length === 0) this.addFlatLayoutAgents(rows);
    this.topLevelAgents = rows;

    this.detectParallelExecution();
    this.refresh();
  }

  /**
   * Pairs each lifecycle with its transcript trace: by the spawning tool_use
   * id, then by agent id, then (transcripts without spawn metadata) by an
   * unambiguous description.
   */
  private matchLifecycles(lifecycles: readonly SubagentLifecycle[]): {
    byTrace: Map<SubagentTrace, SubagentLifecycle>;
    unmatched: SubagentLifecycle[];
  } {
    const bySpawn = new Map<string, SubagentTrace>();
    const byAgent = new Map<string, SubagentTrace>();
    for (const trace of flattenTraces(this.traces)) {
      if (trace.spawnToolUseId) bySpawn.set(trace.spawnToolUseId, trace);
      byAgent.set(trace.agentId, trace);
    }

    const byTrace = new Map<SubagentTrace, SubagentLifecycle>();
    let unmatched: SubagentLifecycle[] = [];
    for (const lifecycle of lifecycles) {
      const trace =
        bySpawn.get(lifecycle.id) ??
        (lifecycle.agentId ? byAgent.get(lifecycle.agentId) : undefined);
      if (trace && !byTrace.has(trace)) byTrace.set(trace, lifecycle);
      else unmatched.push(lifecycle);
    }

    const spare = this.traces.filter((trace) => !byTrace.has(trace) && !trace.spawnToolUseId);
    if (spare.length > 0) {
      unmatched = unmatched.filter((lifecycle) => {
        const candidates = spare.filter(
          (trace) => !byTrace.has(trace) && trace.description === lifecycle.description,
        );
        if (candidates.length !== 1) return true;
        byTrace.set(candidates[0], lifecycle);
        return false;
      });
    }
    return { byTrace, unmatched };
  }

  /**
   * Converts a SubagentTrace tree into a SubagentItem tree.
   */
  private traceToItem(
    trace: SubagentTrace,
    lifecycles: Map<SubagentTrace, SubagentLifecycle>,
  ): SubagentItem {
    const lifecycle = lifecycles.get(trace);
    const description = trace.description ?? lifecycle?.description;
    const agentType = this.resolveAgentType(
      trace.agentType ?? lifecycle?.subagentType,
      description,
    );

    const item: SubagentItem = {
      id: lifecycle?.id || trace.spawnToolUseId || trace.agentId,
      agentId: trace.agentId,
      label: `${trace.agentId.substring(0, 8)} (${agentType})`,
      // The lifecycle knows; without one, Claude Code's meta flags or the
      // transcript's last turn tell.
      type: lifecycle ? lifecycle.status : traceLooksFinished(trace) ? 'completed' : 'running',
      outcome: lifecycle?.outcome ?? (trace.stoppedByUser ? 'stopped' : undefined),
      agentType,
      transcriptPath: trace.filePath ?? this.findTranscriptPath(trace.agentId),
      timestamp: parseDate(lifecycle?.spawnTime) ?? trace.stats.startTime ?? new Date(),
      inputTokens: trace.stats.inputTokens,
      outputTokens: trace.stats.outputTokens,
      totalTokens: trace.stats.totalTokens,
      durationMs: lifecycle?.durationMs ?? trace.stats.durationMs,
      description,
      children: trace.children.map((child) => this.traceToItem(child, lifecycles)),
    };

    // Register in flat map for lookup
    this.subagents.set(item.id, item);
    return item;
  }

  /** A spawn whose transcript has not been found (yet). */
  private lifecycleToItem(lifecycle: SubagentLifecycle): SubagentItem {
    const agentType = this.resolveAgentType(lifecycle.subagentType, lifecycle.description);
    const label = lifecycle.agentId
      ? `${lifecycle.agentId.substring(0, 8)} (${agentType})`
      : `${truncate(lifecycle.description, LABEL_DESCRIPTION_MAX)} (${agentType})`;
    return {
      id: lifecycle.id || lifecycle.agentId || `spawn-${lifecycle.spawnTime}`,
      agentId: lifecycle.agentId,
      label,
      type: lifecycle.status,
      outcome: lifecycle.outcome,
      agentType,
      transcriptPath: lifecycle.agentId ? this.findTranscriptPath(lifecycle.agentId) : undefined,
      timestamp: parseDate(lifecycle.spawnTime) ?? new Date(),
      durationMs: lifecycle.durationMs,
      description: lifecycle.description,
      children: [],
    };
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

    if (
      lower.includes('task') ||
      lower.includes('execute') ||
      lower.includes('implement') ||
      lower.includes('build')
    ) {
      return 'Task';
    }

    return 'Unknown';
  }

  /** Classifies a raw agent type, falling back to description keywords. */
  private resolveAgentType(raw: string | undefined, description: string | undefined): AgentType {
    const classified = this.classifyAgentType(raw);
    if (classified !== 'Unknown' || !description) return classified;
    return this.detectAgentType(description);
  }

  /**
   * Finds the transcript file path for an agent: the current
   * `<sessionDir>/<sessionId>/subagents/` layout, then the older flat one.
   *
   * @param agentId - Agent identifier
   * @returns Path to transcript if exists, undefined otherwise
   */
  private findTranscriptPath(agentId: string): string | undefined {
    if (!this.sessionDir) {
      return undefined;
    }

    const sessionId = this.sessionMonitor.getSessionId();
    const candidates = [
      ...(sessionId
        ? [path.join(this.sessionDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)]
        : []),
      path.join(this.sessionDir, `agent-${agentId}.jsonl`),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  /**
   * Flat-layout fallback: older Claude Code wrote `agent-<id>.jsonl` next to
   * the session file. Enriches matching rows and adds the rest as completed.
   */
  private addFlatLayoutAgents(rows: SubagentItem[]): void {
    if (!this.sessionDir) return;

    let files: string[];
    try {
      files = fs.readdirSync(this.sessionDir);
    } catch {
      return; // Directory read failed - ignore, will update on events
    }
    const agentFilePattern = /^agent-(.*)\.jsonl$/;
    const flatFiles = files.filter((file) => agentFilePattern.test(file));
    if (flatFiles.length === 0) return;

    // Enrich with SubagentStats from monitor (has token metrics)
    const statsMap = new Map<string, SubagentStats>();
    for (const s of this.sessionMonitor.getSubagentStats()) {
      statsMap.set(s.agentId, s);
    }

    for (const file of flatFiles) {
      const agentId = file.match(agentFilePattern)?.[1];
      if (!agentId) continue;
      const transcriptPath = path.join(this.sessionDir, file);
      const stats = statsMap.get(agentId);

      const existing = rows.find((row) => row.agentId === agentId);
      if (existing) {
        existing.transcriptPath ??= transcriptPath;
        if (stats) this.enrichFromStats(existing, stats);
        continue;
      }

      const agentType = this.resolveAgentType(stats?.agentType, stats?.description);
      const item: SubagentItem = {
        id: agentId,
        agentId,
        label: `${agentId.substring(0, 8)} (${agentType})`,
        type: 'completed',
        agentType,
        transcriptPath,
        timestamp: stats?.startTime || new Date(),
        inputTokens: stats?.inputTokens,
        outputTokens: stats?.outputTokens,
        totalTokens: stats?.totalTokens,
        durationMs: stats?.durationMs,
        description: stats?.description,
        children: [],
      };

      this.subagents.set(agentId, item);
      rows.push(item);
    }
  }

  /**
   * Enriches an existing SubagentItem with data from SubagentStats.
   */
  private enrichFromStats(item: SubagentItem, stats: SubagentStats): void {
    item.inputTokens = stats.inputTokens;
    item.outputTokens = stats.outputTokens;
    item.totalTokens = stats.totalTokens;
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
      item.label = `${(item.agentId ?? item.id).substring(0, 8)} (${item.agentType})`;
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
    if (lower.includes('task') || lower.includes('bash') || lower.includes('general'))
      return 'Task';
    return 'Unknown';
  }

  /**
   * Detects agents that ran in parallel (overlapping time ranges within 100ms).
   */
  private detectParallelExecution(): void {
    const agents = Array.from(this.subagents.values()).filter((a) => a.timestamp && a.durationMs);

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
    const collapsible =
      element.children.length > 0
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
      if (element.outcome && element.outcome !== 'completed') descParts.push(element.outcome);
      // Cache-inclusive total, the same figure as the session's token totals.
      const tokens =
        element.totalTokens ?? (element.inputTokens || 0) + (element.outputTokens || 0);
      if (tokens > 0) {
        descParts.push(`${formatTokenCount(tokens, { suffixCase: 'upper' })} tok`);
      }
      if (element.durationMs) {
        const secs = Math.round(element.durationMs / 1000);
        descParts.push(secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`);
      }
      if (element.isParallel) {
        descParts.push('parallel');
      }
      if (element.children.length > 0) {
        descParts.push(
          `${element.children.length} child${element.children.length > 1 ? 'ren' : ''}`,
        );
      }
      treeItem.description = descParts.length > 0 ? descParts.join(' | ') : 'Completed';
    }

    // Set click-to-open command if transcript exists
    if (element.transcriptPath && fs.existsSync(element.transcriptPath)) {
      treeItem.command = {
        command: 'vscode.open',
        title: 'Open Transcript',
        arguments: [vscode.Uri.file(element.transcriptPath)],
      };
      const tooltipParts = [element.transcriptPath];
      if (element.description) tooltipParts.unshift(element.description);
      if (element.isParallel) tooltipParts.push('Ran in parallel with other agents');
      if (element.children.length > 0)
        tooltipParts.push(`${element.children.length} child agent(s)`);
      treeItem.tooltip = tooltipParts.join('\n');
    } else {
      treeItem.tooltip = element.description || 'Transcript not yet available';
    }

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
    return [...this.topLevelAgents].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
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
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = undefined;
    this._onDidChangeTreeData.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}

/** Every trace in a forest, parents before their children. */
function flattenTraces(traces: readonly SubagentTrace[]): SubagentTrace[] {
  return traces.flatMap((trace) => [trace, ...flattenTraces(trace.children)]);
}

/**
 * Names, sizes, and mtimes of a subagents directory's transcript and meta
 * files; empty when there are none, so unchanged files skip a rescan.
 */
function directorySignature(dir: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => AGENT_FILE.test(name));
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const name of names.sort()) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      // Removed between listing and stat
    }
  }
  return parts.length > 0 ? `${dir}\n${parts.join('\n')}` : '';
}

/**
 * Without a lifecycle: done when Claude Code says so (meta `finished` or
 * `stoppedByUser`) or the transcript's last turn ended without a tool call.
 */
function traceLooksFinished(trace: SubagentTrace): boolean {
  if (trace.finished || trace.stoppedByUser) return true;
  for (let i = trace.events.length - 1; i >= 0; i--) {
    const event = trace.events[i].event;
    if (event.type !== 'assistant' && event.type !== 'user') continue;
    if (event.type !== 'assistant') return false;
    const content = event.message?.content;
    const callsTool =
      Array.isArray(content) &&
      content.some(
        (block: unknown) =>
          !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use',
      );
    return !callsTool && ENDED_STOP_REASONS.has(event.message?.stop_reason ?? '');
  }
  return false;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.substring(0, max - 1)}…` : clean;
}
