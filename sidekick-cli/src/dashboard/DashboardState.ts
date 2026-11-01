/**
 * Live event aggregator for the TUI dashboard.
 * Delegates core aggregation (tokens, models, tools, tasks, subagents, plan,
 * context attribution, compaction, burn rate) to the shared EventAggregator,
 * and maintains CLI-specific extractions (files, URLs, directories, commands,
 * TODOs) inline.
 */

import * as fs from 'fs';
import type {
  AggregatedCostProvenance,
  BillingBlock,
  FollowEvent,
  SessionTokenTotals,
  SessionWatcher,
  SubagentDisplayStateName,
  SubagentEvidence,
  SubagentOutcome,
  SubagentStats,
} from 'sidekick-shared';
import {
  EventAggregator,
  combineSessionTokenTotals,
  resolveSubagentDisplayState,
  subagentDisplayLabel,
  summarizeTokens,
} from 'sidekick-shared';
import {
  saveSnapshot,
  loadSnapshot,
  isSnapshotValid,
  deleteSnapshot,
  captureJsonlCheckpoint,
} from 'sidekick-shared';
import type { SessionSnapshot } from 'sidekick-shared';
import { quotaFromCodexRateLimits } from 'sidekick-shared';
import { mergeModelUsage } from '../modelUsage';
import { getContextWindowSize } from './modelContext';
import type { QuotaState } from './QuotaService';
import type { ProviderStatusState } from './ProviderStatusService';
import type { UpdateInfo } from './UpdateCheckService';

// ── Public metric types ──

export interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning tokens reported by the provider (display only). */
  reasoning: number;
  /** Every billed token, cache included — `summarizeTokens().total` for the main thread. */
  total: number;
  /** Session cost in USD (`AggregatedTokens.costUsd`): the priced part only. */
  cost: number;
  /** How `cost` was produced; `unpriced` means nothing could be priced (render "—"). */
  costProvenance?: AggregatedCostProvenance;
  /** Usage events that could not be priced; non-zero beside a cost means it is partial. */
  unpricedCalls?: number;
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
  /**
   * `false` when no pricing was known for this model (cost is 0, UI should
   * render "—"). Omit for legacy records; undefined means "priced".
   */
  priced?: boolean;
  /**
   * Set when this row merges spellings of one model (see `mergeModelUsage`)
   * and only some of them were priced: `cost` covers the priced ones.
   */
  partiallyPriced?: boolean;
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
  /**
   * Subagent items: how the agent reads when that is not plain running or
   * completed ("finished (no report)", "ended", "stopped", "killed", "failed").
   */
  agentState?: string;
}

export interface FileTouch {
  path: string;
  reads: number;
  writes: number;
  edits: number;
}

export interface SubagentInfo {
  id: string; // tool_use_id from spawn event
  description: string;
  subagentType: string;
  spawnTime: string; // ISO timestamp
  completionTime?: string; // set when tool_result arrives
  status: 'running' | 'completed';
  durationMs?: number; // computed on completion
  isParallel?: boolean; // true if time overlaps another agent
  /** How the agent ended (`failed`, `killed`, `stopped`, `completed`), once settled. */
  outcome?: SubagentOutcome;
  /** Launched in the background. */
  background?: boolean;
  /** Claude Code agent id, or the Codex child thread id, once known. */
  agentId?: string;
  /**
   * How the agent reads now (`resolveSubagentDisplayState`): `running`,
   * `finished-unreported`, `ended`, or its outcome. Recomputed on every build;
   * when absent, `status` and `outcome` stand in.
   */
  displayState?: SubagentDisplayStateName;
}

type SubagentStateFields = Pick<SubagentInfo, 'displayState' | 'status' | 'outcome'>;

/** An agent's display state, from `status` / `outcome` when it carries none. */
export function subagentDisplayStateOf(agent: SubagentStateFields): SubagentDisplayStateName {
  return (
    agent.displayState ?? (agent.status === 'running' ? 'running' : (agent.outcome ?? 'completed'))
  );
}

/** Whether an agent reads as still working (its display state is `running`). */
export function isSubagentRunning(agent: SubagentStateFields): boolean {
  return subagentDisplayStateOf(agent) === 'running';
}

/**
 * Counts of agents by how they read: `running`, `done` (completed), and the
 * other states with their labels (`finished (no report)`, `ended`, `stopped`,
 * `killed`, `failed`), in that order.
 */
export function summarizeSubagentStates(agents: readonly SubagentStateFields[]): {
  running: number;
  done: number;
  other: Array<{ label: string; count: number }>;
} {
  const counts = new Map<SubagentDisplayStateName, number>();
  for (const agent of agents) {
    const state = subagentDisplayStateOf(agent);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const order: SubagentDisplayStateName[] = [
    'finished-unreported',
    'ended',
    'stopped',
    'killed',
    'failed',
  ];
  return {
    running: counts.get('running') ?? 0,
    done: counts.get('completed') ?? 0,
    other: order
      .filter((state) => (counts.get(state) ?? 0) > 0)
      .map((state) => ({ label: subagentDisplayLabel(state), count: counts.get(state)! })),
  };
}

/**
 * A short state label for an agent whose display state is neither running
 * nor a plain completion, e.g. `finished (no report)`, `stopped`; else `null`.
 */
export function subagentStateLabel(agent: SubagentStateFields): string | null {
  const state = subagentDisplayStateOf(agent);
  return state === 'running' || state === 'completed' ? null : subagentDisplayLabel(state);
}

/** @deprecated Use SubagentInfo instead */
export type SubagentSpawn = SubagentInfo;

export interface CompactionEvent {
  timestamp: string;
  contextBefore: number;
  contextAfter: number;
  tokensReclaimed: number;
  source: 'reported' | 'heuristic';
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
  startedAt?: string;
  completedAt?: string;
  costUsd?: number;
}

export interface PlanInfo {
  title: string;
  steps: PlanStep[];
  source?: 'claude-code' | 'opencode' | 'codex';
  completionRate?: number;
  totalDurationMs?: number;
  rawMarkdown?: string;
  active?: boolean;
  enteredAt?: string;
  exitedAt?: string;
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
  /**
   * Main thread plus the session's subagents (their transcripts are scanned on
   * the static-data refresh cadence, not per event).
   */
  sessionTokens: SessionTokenTotals;
  context: ContextGauge;
  burnRate: number[];
  toolStats: ToolStats[];
  modelStats: ModelStats[];
  timeline: FollowEvent[];
  /** Monotonic count of real and synthetic timeline appends. */
  timelineAppendCount: number;
  tasks: TaskItem[];
  fileTouches: FileTouch[];
  subagents: SubagentInfo[];
  compactionCount: number;
  compactionEvents: CompactionEvent[];
  quota: QuotaState | null;
  /** Active five-hour billing block computed from session logs (local estimate). */
  billingBlock: BillingBlock | null;
  providerStatus: ProviderStatusState | null;
  openaiStatus: ProviderStatusState | null;
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
  opencode: 'OpenCode',
  codex: 'Codex CLI',
};

const TIMELINE_RING_SIZE = 200;

/**
 * Revision of the CLI part of a session snapshot; older snapshots replay.
 * 4: file-backed snapshots record a `sourceCheckpoint` (restore verifies the
 * file is the same, append-only one) and the watcher's `readerState`, and the
 * aggregator's subagent state changed.
 * 5: subagent lifecycles track Codex spawns and record what settled a
 * background agent (aggregator schema 7).
 */
const CLI_CHECKPOINT_REVISION = 5;

/**
 * Shows an agent's task item as the agent reads: still "Running …" only while
 * it runs; an agent that finished without a report or ended moves to done,
 * labelled; a settled agent keeps its status with its outcome labelled.
 */
function applyAgentTaskState(item: TaskItem, agent: SubagentInfo): void {
  const label = subagentStateLabel(agent);
  if (label) item.agentState = label;
  if (isSubagentRunning(agent)) return;
  item.activeForm = undefined;
  if (item.status === 'in_progress') item.status = 'completed';
}

/** Size of the session file, or 0 when there is none (DB-backed sessions). */
function sourceFileSize(sourcePath: string | undefined): number {
  if (!sourcePath) return 0;
  try {
    return fs.statSync(sourcePath).size;
  } catch {
    return 0;
  }
}

// ── State class ──

export class DashboardState {
  // Shared aggregator — handles tokens, models, tools, tasks, subagents,
  // plan, context attribution, compaction, burn rate
  private _aggregator = new EventAggregator({
    readPlanFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
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

  // Active billing block (external state from the usage collector)
  private _billingBlock: BillingBlock | null = null;
  private _subagentStats: SubagentStats[] = [];

  // Provider status (external state from status.claude.com / status.openai.com)
  private _providerStatus: ProviderStatusState | null = null;
  private _openaiStatus: ProviderStatusState | null = null;

  // Update availability (external state)
  private _updateInfo: UpdateInfo | null = null;

  // Session ID (for plan persistence)
  private _sessionId: string | undefined;

  // Only complete history can be reused by a later replay. Live-only runs must
  // leave any existing complete checkpoint untouched.
  private _checkpointProviderId: string | undefined;
  /** The watcher restarted the file; the batch replaying it has not completed yet. */
  private _resetReplayPending = false;

  /**
   * Monotonic mutation counter. `getMetrics()` returns the same object while
   * it is unchanged, so React memoisation keyed on the metrics identity works.
   */
  private _version = 0;
  private _metricsCache: { version: number; metrics: DashboardMetrics } | null = null;

  // Track previous compaction count to detect new compactions for timeline injection
  private _lastKnownCompactionCount = 0;
  private _timelineAppendCount = 0;

  // CLI-specific: per-task tool call counts (aggregator doesn't track this)
  private _taskToolCallCounts = new Map<string, number>();

  // Task management tools that don't count towards task tool call counts
  private static readonly TASK_MGMT_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'];

  /** Number of mutations applied so far; changes whenever `getMetrics()` identity changes. */
  get version(): number {
    return this._version;
  }

  private touch(): void {
    this._version++;
  }

  /** Reset all accumulated metrics to prepare for a new session. */
  reset(): void {
    this.resetSessionEvents();
    this._providerName = undefined;
    this._quota = null;
    this._providerStatus = null;
    this._openaiStatus = null;
    this._updateInfo = null;
    this._sessionId = undefined;
  }

  /**
   * Forget everything built from the current session's events, keeping the
   * session, provider, and quota: its file is being replayed from the start.
   */
  resetSessionEvents(): void {
    this.touch();
    this._aggregator.reset();
    this._timeline = [];
    this._timelineAppendCount = 0;
    this._fileMap.clear();
    this._urlMap.clear();
    this._dirMap.clear();
    this._cmdMap.clear();
    this._todos = [];
    this._todoSeen.clear();
    this._checkpointProviderId = undefined;
    this._resetReplayPending = false;
    this._lastKnownCompactionCount = 0;
    this._taskToolCallCounts.clear();
    this._subagentStats = [];
  }

  /**
   * The watcher started the session file over (it was truncated, rewritten,
   * or replaced): forget what the old content built, and treat the events
   * that follow as a full replay. Checkpoints stay off until that replay's
   * batch completes (see `completeResetReplay`).
   */
  beginResetReplay(): void {
    this.resetSessionEvents();
    this._resetReplayPending = true;
  }

  /**
   * Call when a watcher batch completes. After `beginResetReplay()` the
   * state again holds the session's whole history, so checkpoints are
   * re-enabled for `providerId` and this returns true: the caller should
   * persist now, replacing the snapshot taken from the old content.
   */
  completeResetReplay(providerId: string): boolean {
    if (!this._resetReplayPending) return false;
    this._resetReplayPending = false;
    this.markHistoryReplayed(providerId);
    return true;
  }

  /** Set the session ID for plan persistence. */
  setSessionId(id: string): void {
    this.touch();
    if (id !== this._sessionId) this._checkpointProviderId = undefined;
    this._sessionId = id;
  }

  /** Enable checkpoints after a successful full replay for this session. */
  markHistoryReplayed(providerId: string): void {
    // SQLite timestamps cannot restore row-version deduplication state. Until
    // that cursor is persistent, OpenCode must replay from the beginning.
    this._checkpointProviderId =
      this._sessionId && providerId !== 'opencode' ? providerId : undefined;
  }

  /**
   * Attempts to restore state from a snapshot sidecar file.
   * Returns the reader position, or null if no valid snapshot.
   * `sourcePath` is the session file: a file-backed snapshot is used only
   * while its recorded checkpoint still matches that file's identity and
   * content (see `isSnapshotValid`).
   *
   * With `watcher` (not yet started), the watcher is also sought to that
   * position and given the snapshot's `readerState`; if it rejects that
   * state, the watcher is sought back to 0 and the snapshot is treated as
   * invalid (deleted, null returned). Without `watcher` the caller seeks and
   * the reader state is not restored.
   */
  tryRestoreFromSnapshot(
    sessionId: string,
    providerId: string,
    sourcePath: string,
    watcher?: Pick<SessionWatcher, 'seekTo' | 'restoreResumeState'>,
  ): number | null {
    this.touch();
    this._checkpointProviderId = undefined;
    if (providerId === 'opencode') return null;
    // A watcher that cannot seek would replay everything on top of the snapshot.
    if (watcher && !watcher.seekTo) return null;
    const snapshot = loadSnapshot(sessionId);
    if (!snapshot) return null;
    if (
      snapshot.providerId !== providerId ||
      snapshot.consumer?.checkpointRevision !== CLI_CHECKPOINT_REVISION ||
      snapshot.consumer.consumerType !== 'cli'
    ) {
      deleteSnapshot(sessionId);
      return null;
    }
    if (!isSnapshotValid(snapshot, sourceFileSize(sourcePath), sourcePath)) {
      deleteSnapshot(sessionId);
      return null;
    }

    // Restore aggregator state
    if (!this._aggregator.restore(snapshot.aggregator)) {
      deleteSnapshot(sessionId);
      return null;
    }

    // The watcher's parse state at that position (for Claude, which
    // split-line responses it already counted). Rejected state: replay.
    if (watcher?.seekTo) {
      watcher.seekTo(snapshot.readerPosition);
      if (watcher.restoreResumeState?.(snapshot.readerState) === false) {
        watcher.seekTo(0);
        this._aggregator.reset();
        deleteSnapshot(sessionId);
        return null;
      }
    }

    // Restore CLI-specific state
    const c = snapshot.consumer;
    if (Array.isArray(c.timeline)) {
      this._timeline = c.timeline as FollowEvent[];
      this._timelineAppendCount = this._timeline.length;
      // Re-enrich events restored from older snapshots.
      // Old snapshots may contain TimelineEvent objects (with `description` and
      // `metadata.toolName`) mixed with proper FollowEvents (`summary`, `toolName`).
      for (const ev of this._timeline) {
        // Normalize old type names
        if (ev.type === ('tool_call' as string)) ev.type = 'tool_use';
        if (ev.type === ('assistant_response' as string)) ev.type = 'assistant';

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
            ev.summary = ev.toolInput ? `${ev.toolName} ${ev.toolInput}` : ev.toolName;
          } else {
            const fallbacks: Record<string, string> = {
              user: '(user message)',
              assistant: '(assistant)',
              tool_result: '(tool result)',
              summary: 'Context compacted',
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
    this._checkpointProviderId = providerId;
    return snapshot.readerPosition;
  }

  /**
   * Persists the current state as a snapshot sidecar file. `sourcePath` is
   * the session file the reader position refers to; when it exists, the
   * snapshot records its size and a checkpoint of its identity and content
   * at `readerPosition`. `readerState` is the watcher's `getResumeState()`
   * taken together with `readerPosition`.
   */
  persistSnapshot(
    readerPosition: number,
    sourcePath: string | undefined,
    readerState?: unknown,
  ): void {
    if (!this._sessionId || !this._checkpointProviderId) return;

    const sourceSize = sourceFileSize(sourcePath);
    // Null for a missing file or a position that is not resume-safe; restore then replays.
    const sourceCheckpoint = sourcePath ? captureJsonlCheckpoint(sourcePath, readerPosition) : null;
    const aggregator = this._aggregator.serialize();
    const snapshot: SessionSnapshot = {
      version: aggregator.version,
      sessionId: this._sessionId,
      providerId: this._checkpointProviderId,
      readerPosition,
      sourceSize,
      ...(sourceCheckpoint ? { sourceCheckpoint } : {}),
      ...(readerState !== undefined ? { readerState } : {}),
      createdAt: new Date().toISOString(),
      aggregator,
      consumer: {
        consumerType: 'cli',
        checkpointRevision: CLI_CHECKPOINT_REVISION,
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
    this.touch();
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
    if (
      event.type === 'tool_use' &&
      event.toolName &&
      !DashboardState.TASK_MGMT_TOOLS.includes(event.toolName)
    ) {
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
          summary:
            ce.contextBefore > 0 && ce.contextAfter > 0
              ? `Context compacted: ${fmtTokens(ce.contextBefore)} \u2192 ${fmtTokens(ce.contextAfter)} (${fmtTokens(ce.tokensReclaimed)} reclaimed)`
              : 'Context compacted',
        });
        this._timelineAppendCount++;
        if (this._timeline.length > TIMELINE_RING_SIZE) {
          this._timeline.shift();
        }
      }
      this._lastKnownCompactionCount = currentCompactionCount;
    }

    // Timeline ring buffer (FollowEvent for display)
    this._timeline.push(event);
    this._timelineAppendCount++;
    if (this._timeline.length > TIMELINE_RING_SIZE) {
      this._timeline.shift();
    }
  }

  /** Update quota from external source (OAuth API polling). */
  setQuota(quota: QuotaState): void {
    this.touch();
    this._quota = quota;
  }

  /** Update the followed session's subagent stats (from `scanSessionSubagents`). */
  setSubagentStats(stats: SubagentStats[]): void {
    this.touch();
    this._subagentStats = stats;
  }

  /**
   * Applies evidence from a subagent's metadata (Claude Code's `finished` /
   * `stoppedByUser` meta flags) to its lifecycle; see
   * `EventAggregator.applySubagentEvidence`.
   *
   * @returns Whether a lifecycle changed
   */
  applySubagentEvidence(evidence: SubagentEvidence, timestamp: string): boolean {
    const changed = this._aggregator.applySubagentEvidence(evidence, timestamp);
    if (changed) this.touch();
    return changed;
  }

  /** Update the active billing block computed from session logs. */
  setBillingBlock(block: BillingBlock | null): void {
    this.touch();
    this._billingBlock = block;
  }

  /** Update Claude provider status from status.claude.com polling. */
  setProviderStatus(status: ProviderStatusState): void {
    this.touch();
    this._providerStatus = status;
  }

  /** Update OpenAI provider status from status.openai.com polling. */
  setOpenAIStatus(status: ProviderStatusState): void {
    this.touch();
    this._openaiStatus = status;
  }

  /** Set update availability info from UpdateCheckService. */
  setUpdateInfo(info: UpdateInfo): void {
    this.touch();
    this._updateInfo = info;
  }

  /**
   * Get the current snapshot of all metrics. The same object is returned until
   * the next mutation, so callers can compare by identity.
   */
  getMetrics(): DashboardMetrics {
    if (this._metricsCache && this._metricsCache.version === this._version) {
      return this._metricsCache.metrics;
    }
    const metrics = this.buildMetrics();
    this._metricsCache = { version: this._version, metrics };
    return metrics;
  }

  private buildMetrics(): DashboardMetrics {
    const m = this._aggregator.getMetrics();

    // Map subagents from aggregator's SubagentLifecycle to CLI's SubagentInfo,
    // reading each against its transcript stats (scanned every 15 s).
    const statsByAgent = new Map<string, SubagentStats>();
    const statsBySpawn = new Map<string, SubagentStats>();
    for (const stats of this._subagentStats) {
      statsByAgent.set(stats.agentId, stats);
      if (stats.spawnToolUseId) statsBySpawn.set(stats.spawnToolUseId, stats);
    }
    const now = Date.now();
    const subagents: SubagentInfo[] = m.subagents.map((s) => {
      const stats = statsBySpawn.get(s.id) ?? (s.agentId ? statsByAgent.get(s.agentId) : undefined);
      const displayState = resolveSubagentDisplayState(
        s,
        stats ? { endedCleanly: stats.endedCleanly, lastActivityAt: stats.endTime } : null,
        { now, parentLastActivity: m.lastEventTime },
      ).state;
      return {
        id: s.id,
        description: s.description,
        subagentType: s.subagentType,
        spawnTime: s.spawnTime,
        completionTime: s.completionTime,
        status: s.status,
        durationMs: s.durationMs,
        isParallel: false,
        ...(s.outcome ? { outcome: s.outcome } : {}),
        ...(s.background ? { background: true } : {}),
        ...(s.agentId ? { agentId: s.agentId } : {}),
        displayState,
      };
    });
    this.detectParallelSubagents(subagents);
    const subagentById = new Map(subagents.map((s) => [s.id, s]));

    // Map tool stats from aggregator's ToolAnalytics to CLI's ToolStats
    const toolStats: ToolStats[] = m.toolStats.map((t) => ({
      name: t.name,
      calls: t.successCount + t.failureCount + t.pendingCount,
      pending: t.pendingCount,
      lastCallTime: undefined,
    }));

    // Map model stats from aggregator's ModelUsageStats to CLI's ModelStats,
    // one row per canonical model. Aggregator's `priced` flag flows through so
    // the UI renders "—" for models without a known pricing entry.
    const modelStats: ModelStats[] = mergeModelUsage(m.modelStats);

    // Map tasks from aggregator's TrackedTask to CLI's TaskItem
    const taskMap = new Map<string, TaskItem>();
    for (const t of m.taskState.tasks.values()) {
      const item: TaskItem = {
        taskId: t.taskId,
        subject: t.subject,
        status: t.status as TaskItem['status'],
        blockedBy: t.blockedBy,
        blocks: t.blocks,
        subagentType: t.subagentType,
        isGoalGate: t.isGoalGate,
        toolCallCount: this._taskToolCallCounts.get(t.taskId) || 0,
        activeForm: t.activeForm,
      };
      // An agent's card reads as the agent does: one that stopped in all but
      // name is no longer "Running …".
      const agent = t.isSubagent && t.toolUseId ? subagentById.get(t.toolUseId) : undefined;
      if (agent) applyAgentTaskState(item, agent);
      taskMap.set(t.taskId, item);
    }

    // Include subagent spawns as tasks (matches VS Code SessionMonitor behavior)
    for (const s of subagents) {
      if (!taskMap.has(s.id)) {
        const item: TaskItem = {
          taskId: s.id,
          subject: s.description || `${s.subagentType} agent`,
          status: s.status === 'completed' ? 'completed' : 'in_progress',
          blockedBy: [],
          blocks: [],
          subagentType: s.subagentType,
          toolCallCount: 0,
          activeForm: s.status === 'running' ? `Running ${s.subagentType}` : undefined,
        };
        applyAgentTaskState(item, s);
        taskMap.set(s.id, item);
      }
    }

    // Include plan steps as synthetic tasks (matches VS Code SessionMonitor behavior)
    if (m.plan) {
      for (const step of m.plan.steps) {
        const planTaskId = `plan-${step.id}`;
        if (!taskMap.has(planTaskId)) {
          const stepStatus =
            step.status === 'completed'
              ? 'completed'
              : step.status === 'in_progress'
                ? 'in_progress'
                : 'pending';
          taskMap.set(planTaskId, {
            taskId: planTaskId,
            subject: step.description,
            status: stepStatus,
            blockedBy: [],
            blocks: [],
            toolCallCount: 0,
            activeForm:
              step.status === 'in_progress' ? `Working on ${step.description}` : undefined,
          });
        }
      }
    }

    const tasks = Array.from(taskMap.values());

    // Map compaction events (Date timestamps to string)
    const compactionEvents: CompactionEvent[] = m.compactionEvents.map((ce) => ({
      timestamp: ce.timestamp instanceof Date ? ce.timestamp.toISOString() : String(ce.timestamp),
      contextBefore: ce.contextBefore,
      contextAfter: ce.contextAfter,
      tokensReclaimed: ce.tokensReclaimed,
      source: ce.source,
    }));

    // Convert plan from aggregator's PlanState to CLI's PlanInfo
    const plan = this.convertPlan(m.plan);

    return {
      tokens: {
        input: m.tokens.inputTokens,
        output: m.tokens.outputTokens,
        cacheRead: m.tokens.cacheReadTokens,
        cacheWrite: m.tokens.cacheWriteTokens,
        reasoning: m.tokens.reasoningTokens,
        total: summarizeTokens(m.tokens).total,
        cost: m.tokens.costUsd,
        costProvenance: m.tokens.costProvenance,
        unpricedCalls: m.tokens.unpricedCalls,
      },
      sessionTokens: combineSessionTokenTotals(m.tokens, this._subagentStats),
      context: this.computeContextGauge(m.currentContextSize, m.currentModel),
      burnRate: m.burnRate.points,
      toolStats,
      modelStats,
      timeline: [...this._timeline],
      timelineAppendCount: this._timelineAppendCount,
      tasks,
      fileTouches: Array.from(this._fileMap.values()).sort(
        (a, b) => b.reads + b.writes + b.edits - (a.reads + a.writes + a.edits),
      ),
      subagents,
      compactionCount: m.compactionCount,
      compactionEvents,
      quota: this._quota,
      billingBlock: this._billingBlock,
      providerStatus: this._providerStatus,
      openaiStatus: this._openaiStatus,
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
      steps: planState.steps.map((s) => ({
        id: s.id,
        description: s.description,
        status: s.status,
        phase: s.phase,
        complexity: s.complexity,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        durationMs: s.durationMs,
        tokensUsed: s.tokensUsed,
        toolCalls: s.toolCalls,
        errorMessage: s.errorMessage,
        costUsd: s.costUsd,
      })),
      source: planState.source,
      completionRate: planState.completionRate,
      totalDurationMs: planState.totalDurationMs,
      rawMarkdown: planState.rawMarkdown,
      active: planState.active,
      enteredAt: planState.enteredAt?.toISOString(),
      exitedAt: planState.exitedAt?.toISOString(),
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
  private static readonly COMMAND_PATTERN =
    /^(git|npm|npx|yarn|pnpm|node|python|pip|docker|make|cargo|go|rustc|tsc|eslint|prettier|vitest|jest|pytest)/i;
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
    const dirPath = input.path as string;
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
    this._quota =
      quotaFromCodexRateLimits({
        primary: rl.primary
          ? {
              used_percent: rl.primary.usedPercent,
              window_minutes: rl.primary.windowMinutes,
              resets_at: rl.primary.resetsAt,
            }
          : undefined,
        secondary: rl.secondary
          ? {
              used_percent: rl.secondary.usedPercent,
              window_minutes: rl.secondary.windowMinutes,
              resets_at: rl.secondary.resetsAt,
            }
          : undefined,
      }) ?? this._quota;
  }
}

// ── Module-level helpers ──

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
