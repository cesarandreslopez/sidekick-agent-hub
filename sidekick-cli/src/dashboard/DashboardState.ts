/**
 * Live event aggregator for the TUI dashboard.
 * Processes FollowEvent stream and maintains all derived metrics.
 */

import type { FollowEvent } from 'sidekick-shared';
import { PlanExtractor } from 'sidekick-shared';
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
}

// ── Constants ──

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'opencode': 'OpenCode',
  'codex': 'Codex CLI',
};

const TIMELINE_RING_SIZE = 200;
const BURN_RATE_POINTS = 30;
const BURN_RATE_SAMPLE_MS = 10_000;
const BURN_RATE_WINDOW_MS = 5 * 60_000;

// ── State class ──

export class DashboardState {
  // Token totals
  private _tokens: TokenStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  // Context tracking — full context = input + cache_read + cache_write
  private _lastContextSize = 0;
  private _currentModel: string | undefined;

  // Burn rate: sliding window of (timestamp, tokenDelta) samples
  private _burnSamples: Array<{ time: number; tokens: number }> = [];
  private _burnRatePoints: number[] = [];
  private _lastBurnSampleTime = 0;
  private _tokensSinceLastSample = 0;

  // Tool stats
  private _toolMap = new Map<string, ToolStats>();
  private _pendingTools = new Map<string, string>(); // toolUseId → toolName

  // Model stats
  private _modelMap = new Map<string, ModelStats>();

  // Timeline ring buffer
  private _timeline: FollowEvent[] = [];

  // Tasks (extracted from raw tool events)
  private _taskMap = new Map<string, TaskItem>();
  // Pending TaskCreate calls awaiting result (tool_use_id → TaskCreate input)
  private _pendingTaskCreates = new Map<string, { subject: string; activeForm?: string; subagentType?: string; isGoalGate?: boolean }>();

  // File touches
  private _fileMap = new Map<string, FileTouch>();

  // Subagent lifecycle
  private _subagents: SubagentInfo[] = [];
  private _pendingSubagents = new Map<string, number>(); // tool_use_id → index in _subagents

  // Provider (from first event)
  private _providerId: string | undefined;
  private _providerName: string | undefined;

  // URL touches
  private _urlMap = new Map<string, UrlTouch>();

  // Directory searches
  private _dirMap = new Map<string, DirSearch>();

  // Command executions
  private _cmdMap = new Map<string, CommandExec>();

  // TODOs extracted from summaries
  private _todos: string[] = [];
  private _todoSeen = new Set<string>();

  // Plan state (shared extractor handles all providers)
  private _planExtractor = new PlanExtractor();
  private _plan: PlanInfo | null = null;

  // Context attribution
  private _contextAttribution: ContextAttribution = {
    systemPrompt: 0, userMessages: 0, assistantResponses: 0,
    toolInputs: 0, toolOutputs: 0, thinking: 0, other: 0,
  };

  // Quota
  private _quota: QuotaState | null = null;

  // Update availability
  private _updateInfo: UpdateInfo | null = null;

  // Compaction tracking
  private _compactionCount = 0;
  private _compactionEvents: CompactionEvent[] = [];
  private _previousContextSize = 0; // for drop detection
  private _pendingSummaryCompaction = false; // true after explicit summary, suppresses drop detection

  // Counters
  private _eventCount = 0;
  private _sessionStartTime: string | undefined;
  private _sessionId: string | undefined;

  /** Reset all accumulated metrics to prepare for a new session. */
  reset(): void {
    this._tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    this._lastContextSize = 0;
    this._currentModel = undefined;
    this._burnSamples = [];
    this._burnRatePoints = [];
    this._lastBurnSampleTime = 0;
    this._tokensSinceLastSample = 0;
    this._toolMap.clear();
    this._pendingTools.clear();
    this._modelMap.clear();
    this._timeline = [];
    this._taskMap.clear();
    this._pendingTaskCreates.clear();
    this._fileMap.clear();
    this._subagents = [];
    this._pendingSubagents.clear();
    this._providerId = undefined;
    this._providerName = undefined;
    this._urlMap.clear();
    this._dirMap.clear();
    this._cmdMap.clear();
    this._todos = [];
    this._todoSeen.clear();
    this._planExtractor.reset();
    this._plan = null;
    this._contextAttribution = {
      systemPrompt: 0, userMessages: 0, assistantResponses: 0,
      toolInputs: 0, toolOutputs: 0, thinking: 0, other: 0,
    };
    this._quota = null;
    this._updateInfo = null;
    this._compactionCount = 0;
    this._compactionEvents = [];
    this._previousContextSize = 0;
    this._pendingSummaryCompaction = false;
    this._eventCount = 0;
    this._sessionStartTime = undefined;
    this._sessionId = undefined;
  }

  /** Set the session ID for plan persistence. */
  setSessionId(id: string): void {
    this._sessionId = id;
  }

  /** Process a single FollowEvent and update all metrics. */
  processEvent(event: FollowEvent): void {
    this._eventCount++;

    if (!this._sessionStartTime) {
      this._sessionStartTime = event.timestamp;
    }

    // Extract provider from first event
    if (!this._providerId && event.providerId) {
      this._providerId = event.providerId;
      this._providerName = PROVIDER_DISPLAY_NAMES[event.providerId] || event.providerId;
    }

    // Update model
    if (event.model) {
      this._currentModel = event.model;
    }

    // Token accumulation
    if (event.tokens) {
      this._tokens.input += event.tokens.input;
      this._tokens.output += event.tokens.output;
      this._tokensSinceLastSample += event.tokens.input + event.tokens.output;

      // Context window usage = all input-side tokens (billed + cached)
      // With prompt caching, tokens.input is only the uncached portion;
      // the full context is input + cache_read + cache_write.
      let contextSize = event.tokens.input;
      if (event.cacheTokens) {
        contextSize += event.cacheTokens.read + event.cacheTokens.write;
      }

      // Detect compaction via >20% context size drop (matches VS Code extension heuristic).
      // If we already saw a summary event, update that compaction with real after-size
      // instead of creating a duplicate.
      if (this._previousContextSize > 0 && contextSize < this._previousContextSize * 0.8) {
        if (this._pendingSummaryCompaction && this._compactionEvents.length > 0) {
          // Update the existing compaction with actual after-size
          const last = this._compactionEvents[this._compactionEvents.length - 1];
          last.contextAfter = contextSize;
          last.tokensReclaimed = last.contextBefore - contextSize;
          // Update the synthetic timeline entry too
          this.updateLastCompactionTimeline(last);
        } else {
          // No summary event preceded this — detect compaction purely from the drop
          this.recordCompaction(event.timestamp, this._previousContextSize, contextSize);
        }
        this._pendingSummaryCompaction = false;
      }

      this._previousContextSize = contextSize;
      this._lastContextSize = contextSize;
    }
    if (event.cacheTokens) {
      this._tokens.cacheRead += event.cacheTokens.read;
      this._tokens.cacheWrite += event.cacheTokens.write;
    }
    if (event.cost) {
      this._tokens.cost += event.cost;
    }

    // Burn rate sampling
    this.updateBurnRate(event.timestamp);

    // Tool stats
    if (event.type === 'tool_use' && event.toolName) {
      this.recordToolUse(event);
    } else if (event.type === 'tool_result') {
      this.recordToolResult(event);
    }

    // Model stats
    if (event.type === 'assistant' && event.model && event.tokens) {
      this.recordModelUsage(event);
    }

    // Explicit compaction event (summary type)
    if (event.type === 'summary') {
      this.recordCompaction(event.timestamp, this._previousContextSize, 0);
      this._pendingSummaryCompaction = true;
    }

    // Extract task state from raw tool events
    this.extractTaskState(event);

    // Extract file touches
    this.extractFileTouch(event);

    // Extract subagent spawns
    this.extractSubagent(event);

    // Extract URLs from WebFetch/WebSearch
    this.extractUrl(event);

    // Extract directories from Grep/Glob
    this.extractDirectory(event);

    // Extract commands from Bash
    this.extractCommand(event);

    // Extract TODOs from summaries
    this.extractTodo(event);

    // Extract plan from UpdatePlan
    this.extractPlan(event);

    // Context attribution
    this.updateContextAttribution(event);

    // Extract Codex rate limits as quota
    if (event.rateLimits) {
      this.extractCodexQuota(event);
    }

    // Timeline (ring buffer)
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
    this.detectParallelSubagents();
    return {
      tokens: { ...this._tokens },
      context: this.computeContextGauge(),
      burnRate: [...this._burnRatePoints],
      toolStats: Array.from(this._toolMap.values()).sort((a, b) => b.calls - a.calls),
      modelStats: Array.from(this._modelMap.values()).sort((a, b) => b.calls - a.calls),
      timeline: [...this._timeline],
      tasks: Array.from(this._taskMap.values()),
      fileTouches: Array.from(this._fileMap.values()).sort((a, b) =>
        (b.reads + b.writes + b.edits) - (a.reads + a.writes + a.edits)
      ),
      subagents: [...this._subagents],
      compactionCount: this._compactionCount,
      compactionEvents: [...this._compactionEvents],
      quota: this._quota,
      eventCount: this._eventCount,
      sessionStartTime: this._sessionStartTime,
      currentModel: this._currentModel,
      providerId: this._providerId,
      providerName: this._providerName,
      urls: Array.from(this._urlMap.values()).sort((a, b) => b.count - a.count),
      directories: Array.from(this._dirMap.values()).sort((a, b) => b.count - a.count),
      commands: Array.from(this._cmdMap.values()).sort((a, b) => b.count - a.count),
      todos: [...this._todos],
      plan: this._plan,
      contextAttribution: { ...this._contextAttribution },
      updateInfo: this._updateInfo,
      sessionId: this._sessionId,
    };
  }

  // ── Private helpers ──

  /** Mark agents whose lifetimes overlap as parallel. */
  private detectParallelSubagents(): void {
    // Reset all flags first
    for (const a of this._subagents) a.isParallel = false;

    for (let i = 0; i < this._subagents.length; i++) {
      const a = this._subagents[i];
      const aStart = new Date(a.spawnTime).getTime();
      const aEnd = a.completionTime ? new Date(a.completionTime).getTime() : Date.now();
      if (isNaN(aStart)) continue;

      for (let j = i + 1; j < this._subagents.length; j++) {
        const b = this._subagents[j];
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

  private recordCompaction(timestamp: string, before: number, after: number): void {
    // Avoid double-counting: if we just recorded a compaction for this timestamp, skip
    const last = this._compactionEvents[this._compactionEvents.length - 1];
    if (last && last.timestamp === timestamp) return;

    this._compactionCount++;
    this._compactionEvents.push({
      timestamp,
      contextBefore: before,
      contextAfter: after,
      tokensReclaimed: before > after ? before - after : 0,
    });

    // Inject a synthetic timeline event so compaction is visible in the log
    this._timeline.push({
      providerId: 'claude-code',
      type: 'summary',
      timestamp,
      summary: before > 0 && after > 0
        ? `Context compacted: ${fmtTokens(before)} → ${fmtTokens(after)} (${fmtTokens(before - after)} reclaimed)`
        : 'Context compacted',
    });
    if (this._timeline.length > TIMELINE_RING_SIZE) {
      this._timeline.shift();
    }
  }

  private updateLastCompactionTimeline(ce: CompactionEvent): void {
    // Find the synthetic compaction entry in the timeline and update its summary
    for (let i = this._timeline.length - 1; i >= 0; i--) {
      const entry = this._timeline[i];
      if (entry.type === 'summary' && entry.summary.startsWith('Context compacted')) {
        entry.summary = ce.contextBefore > 0 && ce.contextAfter > 0
          ? `Context compacted: ${fmtTokens(ce.contextBefore)} → ${fmtTokens(ce.contextAfter)} (${fmtTokens(ce.tokensReclaimed)} reclaimed)`
          : 'Context compacted';
        break;
      }
    }
  }

  private computeContextGauge(): ContextGauge {
    const limit = getContextWindowSize(this._currentModel);
    const used = this._lastContextSize;
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return { used, limit, percent };
  }

  private updateBurnRate(timestamp: string): void {
    const now = new Date(timestamp).getTime();
    if (isNaN(now)) return;

    if (this._lastBurnSampleTime === 0) {
      this._lastBurnSampleTime = now;
      return;
    }

    const elapsed = now - this._lastBurnSampleTime;
    if (elapsed >= BURN_RATE_SAMPLE_MS) {
      // Tokens per minute for this sample
      const tokPerMin = elapsed > 0 ? Math.round((this._tokensSinceLastSample / elapsed) * 60_000) : 0;
      this._burnSamples.push({ time: now, tokens: tokPerMin });
      this._tokensSinceLastSample = 0;
      this._lastBurnSampleTime = now;

      // Trim to window
      const cutoff = now - BURN_RATE_WINDOW_MS;
      this._burnSamples = this._burnSamples.filter(s => s.time >= cutoff);

      // Build points array
      this._burnRatePoints = this._burnSamples.map(s => s.tokens);
      while (this._burnRatePoints.length > BURN_RATE_POINTS) {
        this._burnRatePoints.shift();
      }
    }
  }

  private recordToolUse(event: FollowEvent): void {
    const name = event.toolName!;
    const stats = this._toolMap.get(name) || { name, calls: 0, pending: 0 };
    stats.calls++;
    stats.pending++;
    stats.lastCallTime = event.timestamp;
    this._toolMap.set(name, stats);

    // Track pending by tool_use block ID if available
    const raw = event.raw as Record<string, unknown> | undefined;
    if (raw?.id) {
      this._pendingTools.set(raw.id as string, name);
    }
  }

  private recordToolResult(event: FollowEvent): void {
    // Try to match by tool_use_id in raw.
    // The JSONL normalizer emits tool_result events where raw IS the tool_result block:
    // { type: 'tool_result', tool_use_id: 'toolu_xxx', content: '...' }
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw) return;

    let matchedName: string | undefined;
    const toolUseId = raw.tool_use_id as string | undefined;
    if (toolUseId) {
      matchedName = this._pendingTools.get(toolUseId);
      if (matchedName) {
        this._pendingTools.delete(toolUseId);
      }
    }

    if (matchedName) {
      const stats = this._toolMap.get(matchedName);
      if (stats && stats.pending > 0) {
        stats.pending--;
      }
    }
  }

  private recordModelUsage(event: FollowEvent): void {
    const model = event.model!;
    const stats = this._modelMap.get(model) || { model, calls: 0, tokens: 0, cost: 0 };
    stats.calls++;
    if (event.tokens) {
      stats.tokens += event.tokens.input + event.tokens.output;
    }
    if (event.cost) {
      stats.cost += event.cost;
    }
    this._modelMap.set(model, stats);
  }

  private extractTaskState(event: FollowEvent): void {
    if (event.type === 'tool_use' && event.toolName) {
      this.handleTaskToolUse(event);
    } else if (event.type === 'tool_result') {
      this.handleTaskToolResult(event);
    }

    // Count tool calls for active tasks — only for non-task-management tool_use events
    if (event.type === 'tool_use' && event.toolName &&
        !['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].includes(event.toolName)) {
      const activeTasks = Array.from(this._taskMap.values()).filter(t => t.status === 'in_progress');
      for (const task of activeTasks) {
        task.toolCallCount++;
      }
    }
  }

  private handleTaskToolUse(event: FollowEvent): void {
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw?.input) return;
    const input = raw.input as Record<string, unknown>;

    if (event.toolName === 'TaskCreate') {
      // Store pending create — the real task ID comes from the tool result
      const toolUseId = raw.id as string;
      if (toolUseId) {
        this._pendingTaskCreates.set(toolUseId, {
          subject: (input.subject as string) || 'Untitled',
          activeForm: input.activeForm as string | undefined,
          subagentType: input.subagentType as string | undefined,
          isGoalGate: input.isGoalGate as boolean | undefined,
        });
      }
    } else if (event.toolName === 'TaskUpdate') {
      const taskId = input.taskId as string;
      if (!taskId) return;

      const existing = this._taskMap.get(taskId);
      if (existing) {
        if (input.status) {
          const newStatus = input.status as string;
          if (newStatus === 'deleted') {
            this._taskMap.delete(taskId);
            return;
          }
          existing.status = newStatus as TaskItem['status'];
        }
        if (input.subject) existing.subject = input.subject as string;
        if (input.activeForm) existing.activeForm = input.activeForm as string;
        if (input.addBlockedBy && Array.isArray(input.addBlockedBy)) {
          existing.blockedBy.push(...(input.addBlockedBy as string[]));
        }
        if (input.addBlocks && Array.isArray(input.addBlocks)) {
          existing.blocks.push(...(input.addBlocks as string[]));
        }
      } else {
        // TaskUpdate for unknown task — create placeholder
        const status = (input.status as string) || 'pending';
        if (status === 'deleted') return;
        this._taskMap.set(taskId, {
          taskId,
          subject: (input.subject as string) || `Task ${taskId}`,
          status: status as TaskItem['status'],
          blockedBy: [],
          blocks: [],
          toolCallCount: 0,
          activeForm: input.activeForm as string | undefined,
        });
      }
    }
  }

  private handleTaskToolResult(event: FollowEvent): void {
    if (this._pendingTaskCreates.size === 0) return;

    // Each tool_result FollowEvent has raw = the tool_result content block
    // { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'Task #1 created...' }
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw || raw.type !== 'tool_result') return;

    const toolUseId = raw.tool_use_id as string;
    if (!toolUseId) return;

    const pending = this._pendingTaskCreates.get(toolUseId);
    if (!pending) return;

    this._pendingTaskCreates.delete(toolUseId);

    // Extract task ID from result content (e.g., "Task #1 created")
    const taskId = extractTaskIdFromResult(raw.content);
    if (taskId) {
      this._taskMap.set(taskId, {
        taskId,
        subject: pending.subject,
        status: 'pending',
        blockedBy: [],
        blocks: [],
        subagentType: pending.subagentType,
        isGoalGate: pending.isGoalGate,
        toolCallCount: 0,
        activeForm: pending.activeForm,
      });
    }
  }

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

  private extractSubagent(event: FollowEvent): void {
    if (event.type === 'tool_use' && event.toolName === 'Task') {
      const raw = event.raw as Record<string, unknown> | undefined;
      if (!raw?.input) return;
      const input = raw.input as Record<string, unknown>;
      const toolUseId = (raw.id as string) || '';
      const info: SubagentInfo = {
        id: toolUseId,
        description: (input.description as string) || 'Unknown task',
        subagentType: (input.subagent_type as string) || (input.subagentType as string) || 'general',
        spawnTime: event.timestamp,
        status: 'running',
      };
      const idx = this._subagents.length;
      this._subagents.push(info);
      if (toolUseId) {
        this._pendingSubagents.set(toolUseId, idx);
      }
    } else if (event.type === 'tool_result') {
      // Complete a pending subagent
      const raw = event.raw as Record<string, unknown> | undefined;
      if (!raw) return;
      const toolUseId = raw.tool_use_id as string | undefined;
      if (!toolUseId) return;
      const idx = this._pendingSubagents.get(toolUseId);
      if (idx === undefined) return;
      this._pendingSubagents.delete(toolUseId);
      const agent = this._subagents[idx];
      agent.status = 'completed';
      agent.completionTime = event.timestamp;
      const start = new Date(agent.spawnTime).getTime();
      const end = new Date(event.timestamp).getTime();
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        agent.durationMs = end - start;
      }
    }
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

  private extractPlan(event: FollowEvent): void {
    const updated = this._planExtractor.processEvent(event);
    if (updated) {
      const extracted = this._planExtractor.plan;
      if (extracted) {
        this._plan = {
          title: extracted.title,
          steps: extracted.steps.map(s => ({
            id: s.id,
            description: s.description,
            status: s.status,
            phase: s.phase,
            complexity: s.complexity,
          })),
          source: extracted.source,
          rawMarkdown: extracted.rawMarkdown,
        };
      }
    }
  }

  private updateContextAttribution(event: FollowEvent): void {
    const raw = event.raw as Record<string, unknown> | undefined;
    const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

    if (event.type === 'user') {
      // Parse content blocks from raw message
      const message = raw?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result') {
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
            this._contextAttribution.toolOutputs += estimateTokens(text);
          } else if (b.type === 'text') {
            const text = (b.text as string) || '';
            if (text.includes('<system-reminder>') || text.includes('CLAUDE.md')) {
              this._contextAttribution.systemPrompt += estimateTokens(text);
            } else {
              this._contextAttribution.userMessages += estimateTokens(text);
            }
          }
        }
      } else if (typeof content === 'string') {
        if (content.includes('<system-reminder>') || content.includes('CLAUDE.md')) {
          this._contextAttribution.systemPrompt += estimateTokens(content);
        } else {
          this._contextAttribution.userMessages += estimateTokens(content);
        }
      } else if (event.summary) {
        this._contextAttribution.userMessages += estimateTokens(event.summary);
      }
    } else if (event.type === 'assistant') {
      const message = raw?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'thinking') {
            this._contextAttribution.thinking += estimateTokens((b.thinking as string) || '');
          } else if (b.type === 'tool_use') {
            const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input || '');
            this._contextAttribution.toolInputs += estimateTokens(input);
          } else if (b.type === 'text') {
            this._contextAttribution.assistantResponses += estimateTokens((b.text as string) || '');
          }
        }
      } else if (event.summary) {
        this._contextAttribution.assistantResponses += estimateTokens(event.summary);
      }
    } else if (event.type === 'tool_use') {
      // Try raw input first for accurate token count (summary truncated to 80 chars)
      const rawInput = (raw?.input != null) ? JSON.stringify(raw.input) : null;
      const text = rawInput || event.summary || '';
      if (text) this._contextAttribution.toolInputs += estimateTokens(text);
    } else if (event.type === 'tool_result') {
      // Try raw content first (summary truncated to 120 chars)
      const rawContent = raw?.content;
      const text = (typeof rawContent === 'string') ? rawContent
        : rawContent ? JSON.stringify(rawContent)
        : event.summary || '';
      if (text) this._contextAttribution.toolOutputs += estimateTokens(text);
    } else if (event.type === 'summary') {
      if (event.summary) {
        this._contextAttribution.other += estimateTokens(event.summary);
      }
    }
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

/**
 * Extract task ID from TaskCreate result content.
 * Matches "Task #N" or JSON taskId patterns (same logic as VS Code extension).
 */
function extractTaskIdFromResult(content: unknown): string | null {
  const str = typeof content === 'string' ? content : JSON.stringify(content || '');
  const taskMatch = str.match(/Task #(\d+)/i);
  if (taskMatch) return taskMatch[1];
  const jsonMatch = str.match(/"taskId"\s*:\s*"?(\d+)"?/i);
  if (jsonMatch) return jsonMatch[1];
  return null;
}
