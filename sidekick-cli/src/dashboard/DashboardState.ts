/**
 * Live event aggregator for the TUI dashboard.
 * Delegates core aggregation (tokens, models, tools, tasks, subagents, plan,
 * context attribution, compaction, burn rate) to the shared EventAggregator,
 * and maintains CLI-specific extractions (files, URLs, directories, commands,
 * TODOs) inline.
 */

import * as fs from 'fs';
import type { FollowEvent } from 'sidekick-shared';
import { EventAggregator } from 'sidekick-shared';
import { saveSnapshot, loadSnapshot, isSnapshotValid, deleteSnapshot } from 'sidekick-shared';
import type { SessionSnapshot } from 'sidekick-shared';
import { getContextWindowSize } from './modelContext';
import type { QuotaState } from './QuotaService';
import type { UpdateInfo } from './UpdateCheckService';

// ── Public metric types ──

export interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ToolStats {
  name: string;
  calls: number;
  pending: number;
  lastCallTime?: string;
}

export interface ModelStats {
  model: string;
  calls: number;
  tokens: number;
  cost: number;
}

export interface ContextGauge {
  used: number;
  limit: number;
  percent: number;
}

export interface TaskItem {
  taskId: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy: string[];
  blocks: string[];
  subagentType?: string;
  isGoalGate?: boolean;
  toolCallCount: number;
  activeForm?: string;
  sessionOrigin?: string;
  createdAt?: string;
}

export interface FileTouch {
  path: string;
  reads: number;
  writes: number;
  edits: number;
}

export interface SubagentInfo {
  id: string;                // tool_use_id from spawn event
  description: string;
  subagentType: string;
  spawnTime: string;         // ISO timestamp
  completionTime?: string;   // set when tool_result arrives
  status: 'running' | 'completed';
  durationMs?: number;       // computed on completion
  isParallel?: boolean;      // true if time overlaps another agent
}

/** @deprecated Use SubagentInfo instead */
export type SubagentSpawn = SubagentInfo;

export interface CompactionEvent {
  timestamp: string;
  contextBefore: number;
  contextAfter: number;
  tokensReclaimed: number;
}

export interface UrlTouch {
  url: string;
  count: number;
}

export interface DirSearch {
  path: string;
  count: number;
  patterns: string[];
}

export interface CommandExec {
  name: string;
  count: number;
  examples: string[];
}

export interface PlanStep {
  id: string;
  description: string;
  status: string;
  phase?: string;
  complexity?: 'low' | 'medium' | 'high';
  durationMs?: number;
  tokensUsed?: number;
  toolCalls?: number;
  errorMessage?: string;
}

export interface PlanInfo {
  title: string;
  steps: PlanStep[];
  source?: 'claude-code' | 'opencode' | 'codex';
  completionRate?: number;
  totalDurationMs?: number;
  rawMarkdown?: string;
}

export interface ContextAttribution {
  systemPrompt: number;
  userMessages: number;
  assistantResponses: number;
  toolInputs: number;
  toolOutputs: number;
  thinking: number;
  other: number;
}

export interface DashboardMetrics {
  tokens: TokenStats;
  context: ContextGauge;
  burnRate: number[];
  toolStats: ToolStats[];
  modelStats: ModelStats[];
  timeline: FollowEvent[];
  tasks: TaskItem[];
  fileTouches: FileTouch[];
  subagents: SubagentInfo[];
  compactionCount: number;
  compactionEvents: CompactionEvent[];
  quota: QuotaState | null;
  eventCount: number;
  sessionStartTime?: string;
  currentModel?: string;
  providerId?: string;
  providerName?: string;
  urls: UrlTouch[];
  directories: DirSearch[];
  commands: CommandExec[];
  todos: string[];
  plan: PlanInfo | null;
  contextAttribution: ContextAttribution;
  updateInfo: UpdateInfo | null;
  sessionId?: string;
  permissionMode?: string | null;
  contextTimeline: Array<{ timestamp: string; inputTokens: number; turnIndex: number }>;
  /** Top tool names by usage frequency (from FrequencyTracker). */
  toolFrequency: Array<{ name: string; count: number }>;
  /** Top words from event summaries (from FrequencyTracker). */
  wordFrequency: Array<{ name: string; count: number }>;
  /** Detected event patterns from summary clustering (from PatternExtractor). */
  patterns: Array<{ template: string; count: number; examples: string[] }>;
  /** Rolling activity heatmap buckets (from HeatmapTracker). */
  heatmapBuckets: Array<{ timestamp: string; count: number }>;
}

// ── Constants ──

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'opencode': 'OpenCode',
  'codex': 'Codex CLI',
};

const TIMELINE_RING_SIZE = 200;

// ── State class ──

export class DashboardState {
  // Shared aggregator — handles tokens, models, tools, tasks, subagents,
  // plan, context attribution, compaction, burn rate
  private _aggregator = new EventAggregator({
    readPlanFile: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
  });

  // Timeline ring buffer (FollowEvent[] for CLI display — different from aggregator's TimelineEvent[])
  private _timeline: FollowEvent[] = [];

  // CLI-specific: file touches
  private _fileMap = new Map<string, FileTouch>();

  // CLI-specific: URL touches
  private _urlMap = new Map<string, UrlTouch>();

  // CLI-specific: directory searches
  private _dirMap = new Map<string, DirSearch>();

  // CLI-specific: command executions
  private _cmdMap = new Map<string, CommandExec>();

  // CLI-specific: TODOs extracted from summaries
  private _todos: string[] = [];
  private _todoSeen = new Set<string>();

  // Provider display name (aggregator tracks providerId, we add display name)
  private _providerName: string | undefined;

  // Quota (external state from OAuth API or Codex rate limits)
  private _quota: QuotaState | null = null;

  // Update availability (external state)
  private _updateInfo: UpdateInfo | null = null;

  // Session ID (for plan persistence)
  private _sessionId: string | undefined;

  // Track previous compaction count to detect new compactions for timeline injection
  private _lastKnownCompactionCount = 0;

  // CLI-specific: per-task tool call counts (aggregator doesn't track this)
  private _taskToolCallCounts = new Map<string, number>();

  // Task management tools that don't count towards task tool call counts
  private static readonly TASK_MGMT_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'];

  /** Reset all accumulated metrics to prepare for a new session. */
  reset(): void {
    this._aggregator.reset();
    this._timeline = [];
    this._fileMap.clear();
    this._urlMap.clear();
    this._dirMap.clear();
    this._cmdMap.clear();
    this._todos = [];
    this._todoSeen.clear();
    this._providerName = undefined;
    this._quota = null;
    this._updateInfo = null;
    this._sessionId = undefined;
    this._lastKnownCompactionCount = 0;
    this._taskToolCallCounts.clear();
  }

  /** Set the session ID for plan persistence. */
  setSessionId(id: string): void {
    this._sessionId = id;
  }

  /**
   * Attempts to restore state from a snapshot sidecar file.
   * Returns the reader position to seek to, or null if no valid snapshot.
   */
  tryRestoreFromSnapshot(sessionId: string, providerId: string, sourceSize: number): number | null {
    const snapshot = loadSnapshot(sessionId);
    if (!snapshot) return null;
    if (snapshot.providerId !== providerId) {
      deleteSnapshot(sessionId);
      return null;
    }
    if (!isSnapshotValid(snapshot, sourceSize)) {
      deleteSnapshot(sessionId);
      return null;
    }

    // Restore aggregator state
    this._aggregator.restore(snapshot.aggregator);

    // Restore CLI-specific state
    const c = snapshot.consumer;
    if (Array.isArray(c.timeline)) {
      this._timeline = c.timeline as FollowEvent[];
      // Re-enrich events restored from older snapshots.
      // Old snapshots may contain TimelineEvent objects (with `description` and
      // `metadata.toolName`) mixed with proper FollowEvents (`summary`, `toolName`).
      for (const ev of this._timeline) {
        // Normalize old type names
        if (ev.type === 'tool_call' as string) ev.type = 'tool_use';
        if (ev.type === 'assistant_response' as string) ev.type = 'assistant';

        // Migrate TimelineEvent fields → FollowEvent fields
        const anyEv = ev as unknown as Record<string, unknown>;
        if (!ev.summary && typeof anyEv.description === 'string') {
          ev.summary = anyEv.description as string;
        }
        if (!ev.toolName && anyEv.metadata) {
          const meta = anyEv.metadata as Record<string, unknown>;
          if (typeof meta.toolName === 'string') {
            ev.toolName = meta.toolName;
          }
        }

        // Backfill still-empty summaries
        if (!ev.summary) {
          if (ev.toolName) {
            ev.summary = ev.toolInput
              ? `${ev.toolName} ${ev.toolInput}`
              : ev.toolName;
          } else {
            const fallbacks: Record<string, string> = {
              user: '(user message)', assistant: '(assistant)',
              tool_result: '(tool result)', summary: 'Context compacted',
              system: '(system)',
            };
            ev.summary = fallbacks[ev.type] || ev.type;
          }
        }
      }
    }
    if (Array.isArray(c.fileMap)) {
      this._fileMap = new Map(c.fileMap as Array<[string, FileTouch]>);
    }
    if (Array.isArray(c.urlMap)) {
      this._urlMap = new Map(c.urlMap as Array<[string, UrlTouch]>);
    }
    if (Array.isArray(c.dirMap)) {
      this._dirMap = new Map(c.dirMap as Array<[string, DirSearch]>);
    }
    if (Array.isArray(c.cmdMap)) {
      this._cmdMap = new Map(c.cmdMap as Array<[string, CommandExec]>);
    }
    if (Array.isArray(c.todos)) {
      this._todos = c.todos as string[];
      this._todoSeen = new Set(this._todos);
    }
    if (typeof c.providerName === 'string') {
      this._providerName = c.providerName;
    }
    if (typeof c.lastKnownCompactionCount === 'number') {
      this._lastKnownCompactionCount = c.lastKnownCompactionCount;
    }
    if (Array.isArray(c.taskToolCallCounts)) {
      this._taskToolCallCounts = new Map(c.taskToolCallCounts as Array<[string, number]>);
    }

    this._sessionId = sessionId;
    return snapshot.readerPosition;
  }

  /**
   * Persists the current state as a snapshot sidecar file.
   */
  persistSnapshot(readerPosition: number, sourceSize: number): void {
    if (!this._sessionId) return;

    const snapshot: SessionSnapshot = {
      version: 1,
      sessionId: this._sessionId,
      providerId: this._aggregator.getMetrics().providerId || 'claude-code',
      readerPosition,
      sourceSize,
      createdAt: new Date().toISOString(),
      aggregator: this._aggregator.serialize(),
      consumer: {
        timeline: this._timeline,
        fileMap: Array.from(this._fileMap.entries()),
        urlMap: Array.from(this._urlMap.entries()),
        dirMap: Array.from(this._dirMap.entries()),
        cmdMap: Array.from(this._cmdMap.entries()),
        todos: this._todos,
        providerName: this._providerName,
        lastKnownCompactionCount: this._lastKnownCompactionCount,
        taskToolCallCounts: Array.from(this._taskToolCallCounts.entries()),
      },
    };

    saveSnapshot(snapshot);
  }

  /** Process a single FollowEvent and update all metrics. */
  processEvent(event: FollowEvent): void {
    // Delegate shared aggregation first
    this._aggregator.processFollowEvent(event);

    // Extract provider display name from first event
    if (!this._providerName && event.providerId) {
      this._providerName = PROVIDER_DISPLAY_NAMES[event.providerId] || event.providerId;
    }

    // Extract Codex rate limits as quota
    if (event.rateLimits) {
      this.extractCodexQuota(event);
    }

    // Count non-task-management tool_use events against in-progress tasks
    if (event.type === 'tool_use' && event.toolName &&
        !DashboardState.TASK_MGMT_TOOLS.includes(event.toolName)) {
      const taskState = this._aggregator.getTaskState();
      for (const [taskId, task] of taskState.tasks) {
        if (task.status === 'in_progress') {
          this._taskToolCallCounts.set(taskId, (this._taskToolCallCounts.get(taskId) || 0) + 1);
        }
      }
    }

    // CLI-specific extractions
    this.extractFileTouch(event);
    this.extractUrl(event);
    this.extractDirectory(event);
    this.extractCommand(event);
    this.extractTodo(event);

    // Inject synthetic compaction entries into FollowEvent timeline.
    // The aggregator detects compaction events. Check if new ones appeared.
    const currentCompactionCount = this._aggregator.getCompactionEvents().length;
    if (currentCompactionCount > this._lastKnownCompactionCount) {
      // Inject synthetic timeline entries for each new compaction
      for (let i = this._lastKnownCompactionCount; i < currentCompactionCount; i++) {
        const ce = this._aggregator.getCompactionEvents()[i];
        const ts = ce.timestamp instanceof Date ? ce.timestamp.toISOString() : String(ce.timestamp);
        this._timeline.push({
          providerId: 'claude-code',
          type: 'summary',
          timestamp: ts,
          summary: ce.contextBefore > 0 && ce.contextAfter > 0
            ? `Context compacted: ${fmtTokens(ce.contextBefore)} \u2192 ${fmtTokens(ce.contextAfter)} (${fmtTokens(ce.tokensReclaimed)} reclaimed)`
            : 'Context compacted',
        });
        if (this._timeline.length > TIMELINE_RING_SIZE) {
          this._timeline.shift();
        }
      }
      this._lastKnownCompactionCount = currentCompactionCount;
    }

    // Timeline ring buffer (FollowEvent for display)
    this._timeline.push(event);
    if (this._timeline.length > TIMELINE_RING_SIZE) {
      this._timeline.shift();
    }
  }

  /** Update quota from external source (OAuth API polling). */
  setQuota(quota: QuotaState): void {
    this._quota = quota;
  }

  /** Set update availability info from UpdateCheckService. */
  setUpdateInfo(info: UpdateInfo): void {
    this._updateInfo = info;
  }

  /** Get the current snapshot of all metrics. */
  getMetrics(): DashboardMetrics {
    const m = this._aggregator.getMetrics();

    // Map subagents from aggregator's SubagentLifecycle to CLI's SubagentInfo
    const subagents: SubagentInfo[] = m.subagents.map(s => ({
      id: s.id,
      description: s.description,
      subagentType: s.subagentType,
      spawnTime: s.spawnTime,
      completionTime: s.completionTime,
      status: s.status,
      durationMs: s.durationMs,
      isParallel: false,
    }));
    this.detectParallelSubagents(subagents);

    // Map tool stats from aggregator's ToolAnalytics to CLI's ToolStats
    const toolStats: ToolStats[] = m.toolStats.map(t => ({
      name: t.name,
      calls: t.successCount + t.failureCount + t.pendingCount,
      pending: t.pendingCount,
      lastCallTime: undefined,
    }));

    // Map model stats from aggregator's ModelUsageStats to CLI's ModelStats
    const modelStats: ModelStats[] = m.modelStats.map(ms => ({
      model: ms.model,
      calls: ms.calls,
      tokens: ms.tokens,
      cost: ms.cost,
    }));

    // Map tasks from aggregator's TrackedTask to CLI's TaskItem
    const taskMap = new Map<string, TaskItem>();
    for (const t of m.taskState.tasks.values()) {
      taskMap.set(t.taskId, {
        taskId: t.taskId,
        subject: t.subject,
        status: t.status as TaskItem['status'],
        blockedBy: t.blockedBy,
        blocks: t.blocks,
        subagentType: t.subagentType,
        isGoalGate: t.isGoalGate,
        toolCallCount: this._taskToolCallCounts.get(t.taskId) || 0,
        activeForm: t.activeForm,
      });
    }

    // Include subagent spawns as tasks (matches VS Code SessionMonitor behavior)
    for (const s of m.subagents) {
      if (!taskMap.has(s.id)) {
        taskMap.set(s.id, {
          taskId: s.id,
          subject: s.description || `${s.subagentType} agent`,
          status: s.status === 'completed' ? 'completed' : 'in_progress',
          blockedBy: [],
          blocks: [],
          subagentType: s.subagentType,
          toolCallCount: 0,
          activeForm: s.status === 'running' ? `Running ${s.subagentType}` : undefined,
        });
      }
    }

    // Include plan steps as synthetic tasks (matches VS Code SessionMonitor behavior)
    if (m.plan) {
      for (const step of m.plan.steps) {
        const planTaskId = `plan-${step.id}`;
        if (!taskMap.has(planTaskId)) {
          const stepStatus = step.status === 'completed' ? 'completed'
            : step.status === 'in_progress' ? 'in_progress'
            : 'pending';
          taskMap.set(planTaskId, {
            taskId: planTaskId,
            subject: step.description,
            status: stepStatus,
            blockedBy: [],
            blocks: [],
            toolCallCount: 0,
            activeForm: step.status === 'in_progress' ? `Working on ${step.description}` : undefined,
          });
        }
      }
    }

    const tasks = Array.from(taskMap.values());

    // Map compaction events (Date timestamps to string)
    const compactionEvents: CompactionEvent[] = m.compactionEvents.map(ce => ({
      timestamp: ce.timestamp instanceof Date ? ce.timestamp.toISOString() : String(ce.timestamp),
      contextBefore: ce.contextBefore,
      contextAfter: ce.contextAfter,
      tokensReclaimed: ce.tokensReclaimed,
    }));

    // Convert plan from aggregator's PlanState to CLI's PlanInfo
    const plan = this.convertPlan(m.plan);

    return {
      tokens: {
        input: m.tokens.inputTokens,
        output: m.tokens.outputTokens,
        cacheRead: m.tokens.cacheReadTokens,
        cacheWrite: m.tokens.cacheWriteTokens,
        cost: m.tokens.reportedCost,
      },
      context: this.computeContextGauge(m.currentContextSize, m.currentModel),
      burnRate: m.burnRate.points,
      toolStats,
      modelStats,
      timeline: [...this._timeline],
      tasks,
      fileTouches: Array.from(this._fileMap.values()).sort((a, b) =>
        (b.reads + b.writes + b.edits) - (a.reads + a.writes + a.edits)
      ),
      subagents,
      compactionCount: m.compactionCount,
      compactionEvents,
      quota: this._quota,
      eventCount: m.eventCount,
      sessionStartTime: m.sessionStartTime ?? undefined,
      currentModel: m.currentModel ?? undefined,
      providerId: m.providerId ?? undefined,
      providerName: this._providerName,
      urls: Array.from(this._urlMap.values()).sort((a, b) => b.count - a.count),
      directories: Array.from(this._dirMap.values()).sort((a, b) => b.count - a.count),
      commands: Array.from(this._cmdMap.values()).sort((a, b) => b.count - a.count),
      todos: [...this._todos],
      plan,
      contextAttribution: { ...m.contextAttribution },
      updateInfo: this._updateInfo,
      sessionId: this._sessionId,
      permissionMode: m.permissionMode ?? null,
      contextTimeline: m.contextTimeline ?? [],
      toolFrequency: m.toolFrequency ?? [],
      wordFrequency: m.wordFrequency ?? [],
      patterns: m.patterns ?? [],
      heatmapBuckets: m.heatmapBuckets ?? [],
    };
  }

  // ── Private helpers ──

  /** Mark agents whose lifetimes overlap as parallel. */
  private detectParallelSubagents(subagents: SubagentInfo[]): void {
    for (let i = 0; i < subagents.length; i++) {
      const a = subagents[i];
      const aStart = new Date(a.spawnTime).getTime();
      const aEnd = a.completionTime ? new Date(a.completionTime).getTime() : Date.now();
      if (isNaN(aStart)) continue;

      for (let j = i + 1; j < subagents.length; j++) {
        const b = subagents[j];
        const bStart = new Date(b.spawnTime).getTime();
        const bEnd = b.completionTime ? new Date(b.completionTime).getTime() : Date.now();
        if (isNaN(bStart)) continue;

        // Overlap: aStart < bEnd && bStart < aEnd
        if (aStart < bEnd && bStart < aEnd) {
          a.isParallel = true;
          b.isParallel = true;
        }
      }
    }
  }

  private computeContextGauge(contextSize: number, currentModel: string | null): ContextGauge {
    const limit = getContextWindowSize(currentModel ?? undefined);
    const used = contextSize;
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return { used, limit, percent };
  }

  /** Convert aggregator PlanState to CLI PlanInfo. */
  private convertPlan(planState: ReturnType<EventAggregator['getPlan']>): PlanInfo | null {
    if (!planState) return null;
    return {
      title: planState.title ?? 'Plan',
      steps: planState.steps.map(s => ({
        id: s.id,
        description: s.description,
        status: s.status,
        phase: s.phase,
        complexity: s.complexity,
      })),
      source: planState.source,
      completionRate: planState.completionRate,
      totalDurationMs: planState.totalDurationMs,
      rawMarkdown: planState.rawMarkdown,
    };
  }

  // ── CLI-specific extraction helpers ──

  private extractFileTouch(event: FollowEvent): void {
    if (event.type !== 'tool_use' || !event.toolName) return;
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw?.input) return;
    const input = raw.input as Record<string, unknown>;
    const filePath = (input.file_path as string) || (input.path as string);
    if (!filePath) return;

    const toolName = event.toolName;
    if (!['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(toolName)) return;

    const touch = this._fileMap.get(filePath) || { path: filePath, reads: 0, writes: 0, edits: 0 };
    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
      touch.reads++;
    } else if (toolName === 'Write') {
      touch.writes++;
    } else if (toolName === 'Edit') {
      touch.edits++;
    }
    this._fileMap.set(filePath, touch);
  }

  private static readonly URL_TOOLS = ['WebFetch', 'WebSearch'];
  private static readonly SEARCH_TOOLS = ['Grep', 'Glob'];
  private static readonly COMMAND_PATTERN = /^(git|npm|npx|yarn|pnpm|node|python|pip|docker|make|cargo|go|rustc|tsc|eslint|prettier|vitest|jest|pytest)/i;
  private static readonly TODO_PATTERN = /TODO:?\s*(.+?)(?:\n|$)/gi;

  private extractUrl(event: FollowEvent): void {
    if (event.type !== 'tool_use' || !event.toolName) return;
    if (!DashboardState.URL_TOOLS.includes(event.toolName)) return;
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw?.input) return;
    const input = raw.input as Record<string, unknown>;
    const url = (input.url as string) || (input.query as string);
    if (!url) return;
    const existing = this._urlMap.get(url) || { url, count: 0 };
    existing.count++;
    this._urlMap.set(url, existing);
  }

  private extractDirectory(event: FollowEvent): void {
    if (event.type !== 'tool_use' || !event.toolName) return;
    if (!DashboardState.SEARCH_TOOLS.includes(event.toolName)) return;
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw?.input) return;
    const input = raw.input as Record<string, unknown>;
    const dirPath = (input.path as string);
    if (!dirPath) return;
    const existing = this._dirMap.get(dirPath) || { path: dirPath, count: 0, patterns: [] };
    existing.count++;
    const pattern = input.pattern as string;
    if (pattern && !existing.patterns.includes(pattern)) {
      existing.patterns.push(pattern);
    }
    this._dirMap.set(dirPath, existing);
  }

  private extractCommand(event: FollowEvent): void {
    if (event.type !== 'tool_use' || event.toolName !== 'Bash') return;
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw?.input) return;
    const input = raw.input as Record<string, unknown>;
    const cmd = input.command as string;
    if (!cmd) return;
    const match = cmd.match(DashboardState.COMMAND_PATTERN);
    if (!match) return;
    const cmdName = match[1].toLowerCase();
    const existing = this._cmdMap.get(cmdName) || { name: cmdName, count: 0, examples: [] };
    existing.count++;
    const shortCmd = cmd.split('\n')[0].substring(0, 60);
    if (!existing.examples.includes(shortCmd) && existing.examples.length < 5) {
      existing.examples.push(shortCmd);
    }
    this._cmdMap.set(cmdName, existing);
  }

  private extractTodo(event: FollowEvent): void {
    const text = this.extractFullTextFromEvent(event) || event.summary;
    if (!text) return;
    const matches = text.matchAll(DashboardState.TODO_PATTERN);
    for (const match of matches) {
      const todo = match[1].trim();
      if (todo && !this._todoSeen.has(todo.toLowerCase())) {
        this._todos.push(todo);
        this._todoSeen.add(todo.toLowerCase());
      }
    }
  }

  /** Extract full text content from event.raw message content blocks. */
  private extractFullTextFromEvent(event: FollowEvent): string | null {
    const raw = event.raw as Record<string, unknown> | undefined;
    const message = raw?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        }
      }
      if (texts.length > 0) return texts.join('\n');
    }
    return null;
  }

  private extractCodexQuota(event: FollowEvent): void {
    const rl = event.rateLimits;
    if (!rl?.primary && !rl?.secondary) return;
    this._quota = {
      fiveHour: rl.primary
        ? { utilization: rl.primary.usedPercent, resetsAt: new Date(rl.primary.resetsAt * 1000).toISOString() }
        : { utilization: 0, resetsAt: '' },
      sevenDay: rl.secondary
        ? { utilization: rl.secondary.usedPercent, resetsAt: new Date(rl.secondary.resetsAt * 1000).toISOString() }
        : { utilization: 0, resetsAt: '' },
      available: true,
    };
  }
}

// ── Module-level helpers ──

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
