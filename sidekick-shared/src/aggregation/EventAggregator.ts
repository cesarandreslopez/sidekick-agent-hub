/**
 * Shared event aggregation engine.
 *
 * Pure computation class (no I/O, no framework dependencies) that processes
 * SessionEvent and FollowEvent objects to accumulate session metrics.
 * Both the VS Code SessionMonitor and CLI DashboardState delegate to this.
 *
 * @module aggregation/EventAggregator
 */

import type {
  SessionEvent,
  MessageUsage,
  ToolAnalytics,
  TimelineEvent,
  PendingToolCall,
  TrackedTask,
  TaskState,
  PlanState,
  CompactionEvent,
  TruncationEvent,
  ContextAttribution,
  PendingUserRequest,
  ResponseLatency,
  LatencyStats,
} from '../types/sessionEvent';
import type { FollowEvent } from '../watchers/types';
import { TRUNCATION_PATTERNS } from '../parsers/jsonl';
import { PlanExtractor } from '../parsers/planExtractor';
import { toFollowEvents } from '../watchers/eventBridge';
import type {
  EventAggregatorOptions,
  AggregatedTokens,
  ModelUsageStats,
  BurnRateInfo,
  SubagentLifecycle,
  AggregatedMetrics,
} from './types';

// ── Defaults ──

const DEFAULT_TIMELINE_CAP = 200;
const DEFAULT_LATENCY_CAP = 100;
const DEFAULT_BURN_WINDOW_MS = 5 * 60_000;
const DEFAULT_BURN_SAMPLE_MS = 10_000;
const COMPACTION_DROP_THRESHOLD = 0.8; // >20% drop

/** Schema version for serialized snapshots. */
const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * JSON-serializable snapshot of EventAggregator state.
 * Used by session snapshot sidecar files for fast resume.
 */
export interface SerializedAggregatorState {
  version: number;
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number; reportedCost: number };
  modelUsage: Array<[string, { calls: number; tokens: number; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; cost: number }]>;
  contextSize: number;
  previousContextSize: number;
  compactionEvents: CompactionEvent[];
  truncationEvents: TruncationEvent[];
  toolAnalytics: Array<[string, ToolAnalytics]>;
  contextAttribution: ContextAttribution;
  burnSamples: BurnSample[];
  lastBurnSampleTime: number;
  tokensSinceLastSample: number;
  latencyRecords: ResponseLatency[];
  tasks: Array<[string, TrackedTask]>;
  activeTaskId: string | null;
  subagents: SubagentLifecycle[];
  timeline: TimelineEvent[];
  messageCount: number;
  eventCount: number;
  sessionStartTime: string | null;
  lastEventTime: string | null;
  currentModel: string | null;
}

// ── Internal per-model accumulator ──

interface ModelAccumulator {
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cost: number;
}

// ── Pending task create input ──

interface PendingTaskCreateInput {
  subject: string;
  description?: string;
  activeForm?: string;
  subagentType?: string;
  isGoalGate?: boolean;
}

// ── Burn rate sample ──

interface BurnSample {
  time: number;
  tokens: number;
}

// ── EventAggregator ──

export class EventAggregator {
  // Options
  private readonly timelineCap: number;
  private readonly latencyCap: number;
  private readonly burnWindowMs: number;
  private readonly burnSampleMs: number;
  private readonly computeContextSize:
    | ((usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; reasoningTokens?: number }) => number)
    | null;
  private readonly providerId: string | null;

  // Token totals
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheWriteTokens = 0;
  private cacheReadTokens = 0;
  private reportedCost = 0;

  // Per-model usage
  private modelUsage = new Map<string, ModelAccumulator>();

  // Context size tracking
  private currentContextSize = 0;
  private previousContextSize = 0;

  // Compaction
  private compactionEvents: CompactionEvent[] = [];

  // Truncation
  private truncationEvents: TruncationEvent[] = [];

  // Tool analytics
  private toolAnalytics = new Map<string, ToolAnalytics>();
  private pendingToolCalls = new Map<string, PendingToolCall>();

  // Burn rate
  private burnSamples: BurnSample[] = [];
  private lastBurnSampleTime = 0;
  private tokensSinceLastSample = 0;

  // Task state
  private tasks = new Map<string, TrackedTask>();
  private pendingTaskCreates = new Map<string, PendingTaskCreateInput>();
  private activeTaskId: string | null = null;

  // Subagent lifecycle
  private subagents: SubagentLifecycle[] = [];
  private pendingSubagents = new Map<string, number>(); // toolUseId -> index

  // Plan state
  private planExtractor!: PlanExtractor;

  // Context attribution
  private contextAttribution: ContextAttribution = {
    systemPrompt: 0,
    userMessages: 0,
    assistantResponses: 0,
    toolInputs: 0,
    toolOutputs: 0,
    thinking: 0,
    other: 0,
  };

  // Timeline
  private timeline: TimelineEvent[] = [];

  // Latency tracking
  private pendingUserRequest: PendingUserRequest | null = null;
  private latencyRecords: ResponseLatency[] = [];

  // Counters
  private messageCount = 0;
  private eventCount = 0;
  private sessionStartTime: string | null = null;
  private lastEventTime: string | null = null;
  private currentModel: string | null = null;
  private _providerId: string | null = null;

  constructor(options?: EventAggregatorOptions) {
    this.timelineCap = options?.timelineCap ?? DEFAULT_TIMELINE_CAP;
    this.latencyCap = options?.latencyCap ?? DEFAULT_LATENCY_CAP;
    this.burnWindowMs = options?.burnWindowMs ?? DEFAULT_BURN_WINDOW_MS;
    this.burnSampleMs = options?.burnSampleMs ?? DEFAULT_BURN_SAMPLE_MS;
    this.computeContextSize = options?.computeContextSize ?? null;
    this.providerId = options?.providerId ?? null;
    this._providerId = this.providerId;
    this.planExtractor = new PlanExtractor(options?.readPlanFile);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // processEvent — main entry for SessionEvent
  // ═══════════════════════════════════════════════════════════════════════

  processEvent(event: SessionEvent): void {
    // 1. Increment counters, capture timestamps
    this.eventCount++;
    if (!this.sessionStartTime) {
      this.sessionStartTime = event.timestamp;
    }
    this.lastEventTime = event.timestamp;

    // Guard: some event types (e.g. 'summary') have no message field in the raw JSONL
    if (!event.message) {
      return;
    }

    // 2. Track model
    if (event.message.model) {
      this.currentModel = event.message.model;
    }

    // 3. Skip synthetic token-count events for messageCount
    const msgId = event.message.id ?? '';
    if (!msgId.startsWith('token-count-')) {
      this.messageCount++;
    }

    // 4. Latency tracking
    this.processLatency(event);

    // 5. Token accumulation
    if (event.message.usage) {
      this.accumulateUsage(event.message.usage, event.timestamp, event.message.model);
    }

    // 6. Tool extraction from content blocks
    this.extractToolsFromContent(event);

    // 7. Task state
    this.extractTaskStateFromEvent(event);

    // 8. Subagent tracking
    this.extractSubagentFromEvent(event);

    // 9. Plan extraction — convert SessionEvent to a FollowEvent shape for PlanExtractor
    this.extractPlanFromSessionEvent(event);

    // 10. Context attribution
    this.attributeContextFromEvent(event);

    // 11. Timeline
    this.addTimelineFromSessionEvent(event);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // processFollowEvent — adapter for CLI FollowEvent format
  // ═══════════════════════════════════════════════════════════════════════

  processFollowEvent(event: FollowEvent): void {
    // 1. Increment counters, capture timestamps
    this.eventCount++;
    if (!this.sessionStartTime) {
      this.sessionStartTime = event.timestamp;
    }
    this.lastEventTime = event.timestamp;

    // Provider
    if (!this._providerId && event.providerId) {
      this._providerId = event.providerId;
    }

    // 2. Model tracking
    if (event.model) {
      this.currentModel = event.model;
    }

    // 3. Token accumulation from FollowEvent fields
    if (event.tokens) {
      const inputTok = event.tokens.input;
      const outputTok = event.tokens.output;
      const cacheRead = event.cacheTokens?.read ?? 0;
      const cacheWrite = event.cacheTokens?.write ?? 0;

      this.inputTokens += inputTok;
      this.outputTokens += outputTok;
      this.cacheReadTokens += cacheRead;
      this.cacheWriteTokens += cacheWrite;

      // Tokens since last burn sample
      this.tokensSinceLastSample += inputTok + outputTok;

      // Context size
      let contextSize: number;
      if (this.computeContextSize) {
        contextSize = this.computeContextSize({
          inputTokens: inputTok,
          outputTokens: outputTok,
          cacheWriteTokens: cacheWrite,
          cacheReadTokens: cacheRead,
        });
      } else {
        contextSize = inputTok + cacheWrite + cacheRead;
      }

      // Compaction detection
      if (this.previousContextSize > 0 && contextSize < this.previousContextSize * COMPACTION_DROP_THRESHOLD) {
        this.compactionEvents.push({
          timestamp: new Date(event.timestamp),
          contextBefore: this.previousContextSize,
          contextAfter: contextSize,
          tokensReclaimed: this.previousContextSize - contextSize,
        });
      }
      this.previousContextSize = contextSize;
      this.currentContextSize = contextSize;

      // Per-model usage
      if (event.model) {
        const model = event.model;
        const acc = this.modelUsage.get(model) ?? {
          calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0,
          cacheWriteTokens: 0, cacheReadTokens: 0, cost: 0,
        };
        acc.calls++;
        acc.tokens += inputTok + outputTok;
        acc.inputTokens += inputTok;
        acc.outputTokens += outputTok;
        acc.cacheWriteTokens += cacheWrite;
        acc.cacheReadTokens += cacheRead;
        if (event.cost) acc.cost += event.cost;
        this.modelUsage.set(model, acc);
      }
    }

    // Cost accumulation
    if (event.cost) {
      this.reportedCost += event.cost;
    }

    // Burn rate sampling
    this.updateBurnRate(event.timestamp);

    // 4. Tool tracking from FollowEvent
    if (event.type === 'tool_use' && event.toolName) {
      this.recordFollowToolUse(event);
    } else if (event.type === 'tool_result') {
      this.recordFollowToolResult(event);
    }

    // 5. Task state extraction
    this.extractTaskStateFromFollowEvent(event);

    // 6. Subagent tracking
    this.extractSubagentFromFollowEvent(event);

    // 7. Plan extraction
    this.planExtractor.processEvent(event);

    // 8. Context attribution
    this.attributeContextFromFollowEvent(event);

    // 9. Truncation detection from tool results
    if (event.type === 'tool_result') {
      this.detectTruncationFromFollowEvent(event);
    }

    // 10. Explicit compaction event (summary type)
    if (event.type === 'summary') {
      this.compactionEvents.push({
        timestamp: new Date(event.timestamp),
        contextBefore: this.previousContextSize,
        contextAfter: 0,
        tokensReclaimed: this.previousContextSize,
      });
    }

    // 11. Timeline
    this.addTimelineFromFollowEvent(event);

    // Message count (skip system events)
    if (event.type !== 'system') {
      this.messageCount++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Public getters
  // ═══════════════════════════════════════════════════════════════════════

  getAggregatedTokens(): AggregatedTokens {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      cacheReadTokens: this.cacheReadTokens,
      reportedCost: this.reportedCost,
    };
  }

  getModelStats(): ModelUsageStats[] {
    return Array.from(this.modelUsage.entries())
      .map(([model, acc]) => ({ model, ...acc }))
      .sort((a, b) => b.calls - a.calls);
  }

  getToolStats(): ToolAnalytics[] {
    return Array.from(this.toolAnalytics.values())
      .sort((a, b) => (b.successCount + b.failureCount + b.pendingCount) - (a.successCount + a.failureCount + a.pendingCount));
  }

  getCompactionEvents(): CompactionEvent[] {
    return [...this.compactionEvents];
  }

  getTruncationEvents(): TruncationEvent[] {
    return [...this.truncationEvents];
  }

  getBurnRate(): BurnRateInfo {
    const points = this.burnSamples.map(s => s.tokens);
    const tokensPerMinute = points.length > 0 ? points[points.length - 1] : 0;
    return {
      tokensPerMinute,
      points: [...points],
      sampleCount: this.burnSamples.length,
    };
  }

  getTaskState(): TaskState {
    return {
      tasks: new Map(this.tasks),
      activeTaskId: this.activeTaskId,
    };
  }

  getSubagents(): SubagentLifecycle[] {
    return [...this.subagents];
  }

  getPlan(): PlanState | null {
    const extracted = this.planExtractor.plan;
    if (!extracted) return null;
    return this.convertExtractedPlanToPlanState(extracted);
  }

  getContextAttribution(): ContextAttribution {
    return { ...this.contextAttribution };
  }

  getTimeline(): TimelineEvent[] {
    return [...this.timeline];
  }

  getLatencyStats(): LatencyStats | null {
    if (this.latencyRecords.length === 0) return null;

    const records = this.latencyRecords;
    const totalFirstToken = records.reduce((sum, r) => sum + r.firstTokenLatencyMs, 0);
    const totalResponse = records.reduce((sum, r) => sum + r.totalResponseTimeMs, 0);
    const maxFirstToken = Math.max(...records.map(r => r.firstTokenLatencyMs));
    const last = records[records.length - 1];

    return {
      recentLatencies: [...records],
      avgFirstTokenLatencyMs: Math.round(totalFirstToken / records.length),
      maxFirstTokenLatencyMs: maxFirstToken,
      avgTotalResponseTimeMs: Math.round(totalResponse / records.length),
      lastFirstTokenLatencyMs: last ? last.firstTokenLatencyMs : null,
      completedCycles: records.length,
    };
  }

  getMetrics(): AggregatedMetrics {
    return {
      sessionStartTime: this.sessionStartTime,
      lastEventTime: this.lastEventTime,
      messageCount: this.messageCount,
      eventCount: this.eventCount,
      currentModel: this.currentModel,
      providerId: this._providerId,

      tokens: this.getAggregatedTokens(),
      modelStats: this.getModelStats(),

      currentContextSize: this.currentContextSize,
      contextAttribution: this.getContextAttribution(),
      compactionCount: this.compactionEvents.length,
      compactionEvents: this.getCompactionEvents(),
      truncationCount: this.truncationEvents.length,
      truncationEvents: this.getTruncationEvents(),

      toolStats: this.getToolStats(),
      burnRate: this.getBurnRate(),

      taskState: this.getTaskState(),
      subagents: this.getSubagents(),
      plan: this.getPlan(),

      timeline: this.getTimeline(),
      latencyStats: this.getLatencyStats(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // reset — clear all state
  // ═══════════════════════════════════════════════════════════════════════

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheWriteTokens = 0;
    this.cacheReadTokens = 0;
    this.reportedCost = 0;
    this.modelUsage.clear();
    this.currentContextSize = 0;
    this.previousContextSize = 0;
    this.compactionEvents = [];
    this.truncationEvents = [];
    this.toolAnalytics.clear();
    this.pendingToolCalls.clear();
    this.burnSamples = [];
    this.lastBurnSampleTime = 0;
    this.tokensSinceLastSample = 0;
    this.tasks.clear();
    this.pendingTaskCreates.clear();
    this.activeTaskId = null;
    this.subagents = [];
    this.pendingSubagents.clear();
    this.planExtractor.reset();
    this.contextAttribution = {
      systemPrompt: 0,
      userMessages: 0,
      assistantResponses: 0,
      toolInputs: 0,
      toolOutputs: 0,
      thinking: 0,
      other: 0,
    };
    this.timeline = [];
    this.pendingUserRequest = null;
    this.latencyRecords = [];
    this.messageCount = 0;
    this.eventCount = 0;
    this.sessionStartTime = null;
    this.lastEventTime = null;
    this.currentModel = null;
    this._providerId = this.providerId;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Seed methods — for initializing state from provider snapshots
  // ═══════════════════════════════════════════════════════════════════════

  /** Seeds the current context size (e.g., from a provider usage snapshot on attach). */
  seedContextSize(size: number): void {
    this.currentContextSize = size;
    this.previousContextSize = size;
  }

  /** Seeds context attribution (e.g., from a provider's DB-backed attribution). */
  seedContextAttribution(attribution: ContextAttribution): void {
    this.contextAttribution = { ...attribution };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Snapshot serialization — for fast session resume
  // ═══════════════════════════════════════════════════════════════════════

  /** Serializes all mutable state to a JSON-safe object for snapshot persistence. */
  serialize(): SerializedAggregatorState {
    return {
      version: SNAPSHOT_SCHEMA_VERSION,
      tokens: {
        input: this.inputTokens,
        output: this.outputTokens,
        cacheWrite: this.cacheWriteTokens,
        cacheRead: this.cacheReadTokens,
        reportedCost: this.reportedCost,
      },
      modelUsage: Array.from(this.modelUsage.entries()),
      contextSize: this.currentContextSize,
      previousContextSize: this.previousContextSize,
      compactionEvents: this.compactionEvents,
      truncationEvents: this.truncationEvents,
      toolAnalytics: Array.from(this.toolAnalytics.entries()),
      contextAttribution: { ...this.contextAttribution },
      burnSamples: [...this.burnSamples],
      lastBurnSampleTime: this.lastBurnSampleTime,
      tokensSinceLastSample: this.tokensSinceLastSample,
      latencyRecords: [...this.latencyRecords],
      tasks: Array.from(this.tasks.entries()),
      activeTaskId: this.activeTaskId,
      subagents: [...this.subagents],
      timeline: [...this.timeline],
      messageCount: this.messageCount,
      eventCount: this.eventCount,
      sessionStartTime: this.sessionStartTime,
      lastEventTime: this.lastEventTime,
      currentModel: this.currentModel,
    };
  }

  /** Restores mutable state from a serialized snapshot. Clears transient state (pending calls). */
  restore(state: SerializedAggregatorState): void {
    if (state.version !== SNAPSHOT_SCHEMA_VERSION) {
      return; // Incompatible snapshot — caller should fall back to full replay
    }

    this.inputTokens = state.tokens.input;
    this.outputTokens = state.tokens.output;
    this.cacheWriteTokens = state.tokens.cacheWrite;
    this.cacheReadTokens = state.tokens.cacheRead;
    this.reportedCost = state.tokens.reportedCost;

    this.modelUsage = new Map(state.modelUsage);
    this.currentContextSize = state.contextSize;
    this.previousContextSize = state.previousContextSize;
    this.compactionEvents = [...state.compactionEvents];
    this.truncationEvents = [...state.truncationEvents];
    this.toolAnalytics = new Map(state.toolAnalytics);
    this.contextAttribution = { ...state.contextAttribution };

    this.burnSamples = [...state.burnSamples];
    this.lastBurnSampleTime = state.lastBurnSampleTime;
    this.tokensSinceLastSample = state.tokensSinceLastSample;
    this.latencyRecords = [...state.latencyRecords];

    this.tasks = new Map(state.tasks);
    this.activeTaskId = state.activeTaskId;
    this.subagents = [...state.subagents];
    this.timeline = [...state.timeline];

    this.messageCount = state.messageCount;
    this.eventCount = state.eventCount;
    this.sessionStartTime = state.sessionStartTime;
    this.lastEventTime = state.lastEventTime;
    this.currentModel = state.currentModel;

    // Clear transient state — pending calls won't survive a snapshot boundary
    this.pendingToolCalls.clear();
    this.pendingTaskCreates.clear();
    this.pendingSubagents.clear();
    this.pendingUserRequest = null;
    this.planExtractor.reset();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Token & Context
  // ═══════════════════════════════════════════════════════════════════════

  private accumulateUsage(usage: MessageUsage, timestamp: string, model?: string): void {
    const inputTok = usage.input_tokens;
    const outputTok = usage.output_tokens;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cost = usage.reported_cost ?? 0;

    this.inputTokens += inputTok;
    this.outputTokens += outputTok;
    this.cacheWriteTokens += cacheWrite;
    this.cacheReadTokens += cacheRead;
    this.reportedCost += cost;

    // Burn rate sample accumulation
    this.tokensSinceLastSample += inputTok + outputTok;

    // Context size computation
    let contextSize: number;
    if (this.computeContextSize) {
      contextSize = this.computeContextSize({
        inputTokens: inputTok,
        outputTokens: outputTok,
        cacheWriteTokens: cacheWrite,
        cacheReadTokens: cacheRead,
        reasoningTokens: usage.reasoning_tokens,
      });
    } else {
      contextSize = inputTok + cacheWrite + cacheRead;
    }

    // Compaction detection
    if (this.previousContextSize > 0 && contextSize < this.previousContextSize * COMPACTION_DROP_THRESHOLD) {
      this.compactionEvents.push({
        timestamp: new Date(timestamp),
        contextBefore: this.previousContextSize,
        contextAfter: contextSize,
        tokensReclaimed: this.previousContextSize - contextSize,
      });
    }
    this.previousContextSize = contextSize;
    this.currentContextSize = contextSize;

    // Per-model usage
    const modelKey = model ?? this.currentModel ?? 'unknown';
    const acc = this.modelUsage.get(modelKey) ?? {
      calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0,
      cacheWriteTokens: 0, cacheReadTokens: 0, cost: 0,
    };
    acc.calls++;
    acc.tokens += inputTok + outputTok;
    acc.inputTokens += inputTok;
    acc.outputTokens += outputTok;
    acc.cacheWriteTokens += cacheWrite;
    acc.cacheReadTokens += cacheRead;
    acc.cost += cost;
    this.modelUsage.set(modelKey, acc);

    // Burn rate sampling
    this.updateBurnRate(timestamp);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Burn Rate
  // ═══════════════════════════════════════════════════════════════════════

  private updateBurnRate(timestamp: string): void {
    const now = new Date(timestamp).getTime();
    if (isNaN(now)) return;

    if (this.lastBurnSampleTime === 0) {
      this.lastBurnSampleTime = now;
      return;
    }

    const elapsed = now - this.lastBurnSampleTime;
    if (elapsed >= this.burnSampleMs) {
      const tokPerMin = elapsed > 0 ? Math.round((this.tokensSinceLastSample / elapsed) * 60_000) : 0;
      this.burnSamples.push({ time: now, tokens: tokPerMin });
      this.tokensSinceLastSample = 0;
      this.lastBurnSampleTime = now;

      // Trim to window
      const cutoff = now - this.burnWindowMs;
      this.burnSamples = this.burnSamples.filter(s => s.time >= cutoff);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Latency Tracking (SessionEvent only)
  // ═══════════════════════════════════════════════════════════════════════

  private processLatency(event: SessionEvent): void {
    const now = new Date(event.timestamp);

    if (event.type === 'user' && this.hasTextContent(event)) {
      // User event with text content -> start tracking
      this.pendingUserRequest = {
        timestamp: now,
        firstResponseReceived: false,
      };
    } else if (event.type === 'assistant' && this.pendingUserRequest) {
      if (!this.pendingUserRequest.firstResponseReceived && this.hasTextContent(event)) {
        // First assistant response with text
        this.pendingUserRequest.firstResponseReceived = true;
        this.pendingUserRequest.firstResponseTimestamp = now;
        this.pendingUserRequest.firstTokenLatencyMs = now.getTime() - this.pendingUserRequest.timestamp.getTime();
      }

      if (event.message.usage && this.pendingUserRequest.firstResponseReceived) {
        // Assistant with usage -> complete the cycle
        const totalResponseTimeMs = now.getTime() - this.pendingUserRequest.timestamp.getTime();
        const firstTokenLatencyMs = this.pendingUserRequest.firstTokenLatencyMs ?? totalResponseTimeMs;

        this.latencyRecords.push({
          firstTokenLatencyMs,
          totalResponseTimeMs,
          requestTimestamp: this.pendingUserRequest.timestamp,
        });

        // Cap latency records
        if (this.latencyRecords.length > this.latencyCap) {
          this.latencyRecords.shift();
        }

        this.pendingUserRequest = null;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Tool Extraction from SessionEvent content blocks
  // ═══════════════════════════════════════════════════════════════════════

  private extractToolsFromContent(event: SessionEvent): void {
    const content = event.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        // Assistant content: tool_use block
        const toolUseId = block.id as string;
        const name = block.name as string;
        if (!toolUseId || !name) continue;

        // Record in toolAnalytics
        const analytics = this.toolAnalytics.get(name) ?? {
          name, successCount: 0, failureCount: 0, totalDuration: 0, completedCount: 0, pendingCount: 0,
        };
        analytics.pendingCount++;
        this.toolAnalytics.set(name, analytics);

        // Track pending
        this.pendingToolCalls.set(toolUseId, {
          toolUseId,
          name,
          startTime: new Date(event.timestamp),
        });
      } else if (block.type === 'tool_result') {
        // User content: tool_result block
        const toolUseId = block.tool_use_id as string;
        const isError = block.is_error === true;
        if (!toolUseId) continue;

        const pending = this.pendingToolCalls.get(toolUseId);
        if (pending) {
          this.pendingToolCalls.delete(toolUseId);
          const analytics = this.toolAnalytics.get(pending.name);
          if (analytics) {
            analytics.pendingCount = Math.max(0, analytics.pendingCount - 1);
            analytics.completedCount++;
            if (isError) {
              analytics.failureCount++;
            } else {
              analytics.successCount++;
            }
            // Duration
            const duration = new Date(event.timestamp).getTime() - pending.startTime.getTime();
            if (duration >= 0) {
              analytics.totalDuration += duration;
            }
          }
        }

        // Truncation detection
        this.detectTruncationInContent(block, event.timestamp);
      }
    }
  }

  private detectTruncationInContent(block: Record<string, unknown>, timestamp: string): void {
    const content = block.content;
    const text = typeof content === 'string' ? content : (content ? JSON.stringify(content) : '');
    if (!text) return;

    for (const pattern of TRUNCATION_PATTERNS) {
      if (pattern.regex.test(text)) {
        // Try to find the tool name from pending calls
        const toolUseId = block.tool_use_id as string;
        const pending = toolUseId ? this.pendingToolCalls.get(toolUseId) : undefined;

        this.truncationEvents.push({
          timestamp: new Date(timestamp),
          toolName: pending?.name ?? 'unknown',
          marker: pattern.name,
        });
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Tool tracking from FollowEvent
  // ═══════════════════════════════════════════════════════════════════════

  private recordFollowToolUse(event: FollowEvent): void {
    const name = event.toolName!;

    // Update analytics
    const analytics = this.toolAnalytics.get(name) ?? {
      name, successCount: 0, failureCount: 0, totalDuration: 0, completedCount: 0, pendingCount: 0,
    };
    analytics.pendingCount++;
    this.toolAnalytics.set(name, analytics);

    // Track pending by tool_use_id from raw
    const raw = event.raw as Record<string, unknown> | undefined;
    const toolUseId = raw?.id as string | undefined;
    if (toolUseId) {
      this.pendingToolCalls.set(toolUseId, {
        toolUseId,
        name,
        startTime: new Date(event.timestamp),
      });
    }
  }

  private recordFollowToolResult(event: FollowEvent): void {
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw) return;

    const toolUseId = raw.tool_use_id as string | undefined;
    if (!toolUseId) return;

    const pending = this.pendingToolCalls.get(toolUseId);
    if (!pending) return;

    this.pendingToolCalls.delete(toolUseId);
    const analytics = this.toolAnalytics.get(pending.name);
    if (analytics) {
      analytics.pendingCount = Math.max(0, analytics.pendingCount - 1);
      analytics.completedCount++;

      const isError = raw.is_error === true;
      if (isError) {
        analytics.failureCount++;
      } else {
        analytics.successCount++;
      }

      const duration = new Date(event.timestamp).getTime() - pending.startTime.getTime();
      if (duration >= 0) {
        analytics.totalDuration += duration;
      }
    }
  }

  private detectTruncationFromFollowEvent(event: FollowEvent): void {
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw) return;

    const content = raw.content;
    const text = typeof content === 'string' ? content : (content ? JSON.stringify(content) : '');
    if (!text) return;

    for (const pattern of TRUNCATION_PATTERNS) {
      if (pattern.regex.test(text)) {
        const toolUseId = raw.tool_use_id as string | undefined;
        // Try to find the tool name — it may have been resolved already, so check summary
        let toolName = 'unknown';
        if (toolUseId) {
          const pending = this.pendingToolCalls.get(toolUseId);
          if (pending) toolName = pending.name;
        }
        if (toolName === 'unknown' && event.toolName) {
          toolName = event.toolName;
        }

        this.truncationEvents.push({
          timestamp: new Date(event.timestamp),
          toolName,
          marker: pattern.name,
        });
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Task State from SessionEvent
  // ═══════════════════════════════════════════════════════════════════════

  private extractTaskStateFromEvent(event: SessionEvent): void {
    const content = event.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        const name = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        const toolUseId = block.id as string;
        if (!input) continue;

        if (name === 'TaskCreate' && toolUseId) {
          this.pendingTaskCreates.set(toolUseId, {
            subject: (input.subject as string) || 'Untitled',
            description: input.description as string | undefined,
            activeForm: input.activeForm as string | undefined,
            subagentType: input.subagentType as string | undefined,
            isGoalGate: input.isGoalGate as boolean | undefined,
          });
        } else if (name === 'TaskUpdate') {
          this.applyTaskUpdate(input);
        }
      } else if (block.type === 'tool_result') {
        const toolUseId = block.tool_use_id as string;
        if (!toolUseId) continue;
        this.resolveTaskCreate(toolUseId, block.content ?? block.output, event.timestamp);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Task State from FollowEvent
  // ═══════════════════════════════════════════════════════════════════════

  private extractTaskStateFromFollowEvent(event: FollowEvent): void {
    const raw = event.raw as Record<string, unknown> | undefined;

    if (event.type === 'tool_use' && event.toolName) {
      if (!raw?.input) return;
      const input = raw.input as Record<string, unknown>;
      const toolUseId = raw.id as string | undefined;

      if (event.toolName === 'TaskCreate' && toolUseId) {
        this.pendingTaskCreates.set(toolUseId, {
          subject: (input.subject as string) || 'Untitled',
          description: input.description as string | undefined,
          activeForm: input.activeForm as string | undefined,
          subagentType: input.subagentType as string | undefined,
          isGoalGate: input.isGoalGate as boolean | undefined,
        });
      } else if (event.toolName === 'TaskUpdate') {
        this.applyTaskUpdate(input);
      }
    } else if (event.type === 'tool_result') {
      if (!raw) return;
      const toolUseId = raw.tool_use_id as string | undefined;
      if (!toolUseId) return;
      this.resolveTaskCreate(toolUseId, raw.content, event.timestamp);
    }
  }

  private applyTaskUpdate(input: Record<string, unknown>): void {
    const taskId = input.taskId as string;
    if (!taskId) return;

    const existing = this.tasks.get(taskId);
    if (existing) {
      if (input.status) {
        const newStatus = input.status as string;
        if (newStatus === 'deleted') {
          this.tasks.delete(taskId);
          if (this.activeTaskId === taskId) this.activeTaskId = null;
          return;
        }
        existing.status = newStatus as TrackedTask['status'];
        existing.updatedAt = new Date();
        if (newStatus === 'in_progress') {
          this.activeTaskId = taskId;
        }
      }
      if (input.subject) existing.subject = input.subject as string;
      if (input.description) existing.description = input.description as string;
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
      const now = new Date();
      this.tasks.set(taskId, {
        taskId,
        subject: (input.subject as string) || `Task ${taskId}`,
        status: status as TrackedTask['status'],
        createdAt: now,
        updatedAt: now,
        blockedBy: [],
        blocks: [],
        associatedToolCalls: [],
        activeForm: input.activeForm as string | undefined,
      });
      if (status === 'in_progress') {
        this.activeTaskId = taskId;
      }
    }
  }

  private resolveTaskCreate(toolUseId: string, content: unknown, timestamp: string): void {
    const pending = this.pendingTaskCreates.get(toolUseId);
    if (!pending) return;
    this.pendingTaskCreates.delete(toolUseId);

    const taskId = this.extractTaskIdFromResult(content);
    if (!taskId) return;

    const now = new Date(timestamp);
    this.tasks.set(taskId, {
      taskId,
      subject: pending.subject,
      description: pending.description,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      blockedBy: [],
      blocks: [],
      associatedToolCalls: [],
      activeForm: pending.activeForm,
      subagentType: pending.subagentType,
      isGoalGate: pending.isGoalGate,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Subagent Tracking from SessionEvent
  // ═══════════════════════════════════════════════════════════════════════

  private extractSubagentFromEvent(event: SessionEvent): void {
    const content = event.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' && block.name === 'Task') {
        const input = block.input as Record<string, unknown> | undefined;
        const toolUseId = block.id as string;
        if (!input || !toolUseId) continue;

        const info: SubagentLifecycle = {
          id: toolUseId,
          description: (input.description as string) || 'Unknown task',
          subagentType: (input.subagent_type as string) || (input.subagentType as string) || 'general',
          spawnTime: event.timestamp,
          status: 'running',
        };
        const idx = this.subagents.length;
        this.subagents.push(info);
        this.pendingSubagents.set(toolUseId, idx);
      } else if (block.type === 'tool_result') {
        const toolUseId = block.tool_use_id as string;
        if (!toolUseId) continue;
        this.completeSubagent(toolUseId, event.timestamp);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Subagent Tracking from FollowEvent
  // ═══════════════════════════════════════════════════════════════════════

  private extractSubagentFromFollowEvent(event: FollowEvent): void {
    const raw = event.raw as Record<string, unknown> | undefined;

    if (event.type === 'tool_use' && event.toolName === 'Task') {
      if (!raw?.input) return;
      const input = raw.input as Record<string, unknown>;
      const toolUseId = (raw.id as string) || '';

      const info: SubagentLifecycle = {
        id: toolUseId,
        description: (input.description as string) || 'Unknown task',
        subagentType: (input.subagent_type as string) || (input.subagentType as string) || 'general',
        spawnTime: event.timestamp,
        status: 'running',
      };
      const idx = this.subagents.length;
      this.subagents.push(info);
      if (toolUseId) {
        this.pendingSubagents.set(toolUseId, idx);
      }
    } else if (event.type === 'tool_result') {
      if (!raw) return;
      const toolUseId = raw.tool_use_id as string | undefined;
      if (!toolUseId) return;
      this.completeSubagent(toolUseId, event.timestamp);
    }
  }

  private completeSubagent(toolUseId: string, timestamp: string): void {
    const idx = this.pendingSubagents.get(toolUseId);
    if (idx === undefined) return;
    this.pendingSubagents.delete(toolUseId);

    const agent = this.subagents[idx];
    agent.status = 'completed';
    agent.completionTime = timestamp;
    const start = new Date(agent.spawnTime).getTime();
    const end = new Date(timestamp).getTime();
    if (!isNaN(start) && !isNaN(end) && end >= start) {
      agent.durationMs = end - start;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Plan Extraction from SessionEvent
  // ═══════════════════════════════════════════════════════════════════════

  private extractPlanFromSessionEvent(event: SessionEvent): void {
    // Use toFollowEvents to properly split assistant messages into
    // per-content-block FollowEvents (one per tool_use + one for text).
    // This ensures PlanExtractor sees type:'tool_use' for plan tools
    // like EnterPlanMode, with raw.input set correctly.
    const providerId = (this._providerId as FollowEvent['providerId']) ?? 'claude-code';
    const followEvents = toFollowEvents(event, providerId);
    for (const fe of followEvents) {
      this.planExtractor.processEvent(fe);
    }
  }

  private convertExtractedPlanToPlanState(extracted: {
    title: string;
    steps: Array<{ id: string; description: string; status: string; phase?: string; complexity?: string }>;
    source: 'claude-code' | 'opencode' | 'codex';
    rawMarkdown?: string;
  }): PlanState {
    const completed = extracted.steps.filter(s => s.status === 'completed').length;
    const total = extracted.steps.length;

    return {
      active: true,
      steps: extracted.steps.map(s => ({
        id: s.id,
        description: s.description,
        status: s.status as PlanState['steps'][number]['status'],
        phase: s.phase,
        complexity: s.complexity as PlanState['steps'][number]['complexity'],
      })),
      title: extracted.title,
      source: extracted.source,
      completionRate: total > 0 ? completed / total : 0,
      rawMarkdown: extracted.rawMarkdown,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Context Attribution from SessionEvent
  // ═══════════════════════════════════════════════════════════════════════

  private attributeContextFromEvent(event: SessionEvent): void {
    const content = event.message.content;

    if (event.type === 'user') {
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
            this.contextAttribution.toolOutputs += this.estimateTokens(text);
          } else if (block.type === 'text') {
            const text = (block.text as string) || '';
            if (this.isSystemPromptContent(text)) {
              this.contextAttribution.systemPrompt += this.estimateTokens(text);
            } else {
              this.contextAttribution.userMessages += this.estimateTokens(text);
            }
          }
        }
      } else if (typeof content === 'string') {
        if (this.isSystemPromptContent(content)) {
          this.contextAttribution.systemPrompt += this.estimateTokens(content);
        } else {
          this.contextAttribution.userMessages += this.estimateTokens(content);
        }
      }
    } else if (event.type === 'assistant') {
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'thinking') {
            this.contextAttribution.thinking += this.estimateTokens((block.thinking as string) || '');
          } else if (block.type === 'tool_use') {
            const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || '');
            this.contextAttribution.toolInputs += this.estimateTokens(input);
          } else if (block.type === 'text') {
            this.contextAttribution.assistantResponses += this.estimateTokens((block.text as string) || '');
          }
        }
      }
    } else if (event.type === 'summary') {
      const text = this.extractTextContent(event) || '';
      if (text) {
        this.contextAttribution.other += this.estimateTokens(text);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Context Attribution from FollowEvent
  // ═══════════════════════════════════════════════════════════════════════

  private attributeContextFromFollowEvent(event: FollowEvent): void {
    const raw = event.raw as Record<string, unknown> | undefined;

    // Try to get full content blocks from raw.message.content
    const message = raw?.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (event.type === 'user') {
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
            this.contextAttribution.toolOutputs += this.estimateTokens(text);
          } else if (block.type === 'text') {
            const text = (block.text as string) || '';
            if (this.isSystemPromptContent(text)) {
              this.contextAttribution.systemPrompt += this.estimateTokens(text);
            } else {
              this.contextAttribution.userMessages += this.estimateTokens(text);
            }
          }
        }
      } else if (event.summary) {
        if (this.isSystemPromptContent(event.summary)) {
          this.contextAttribution.systemPrompt += this.estimateTokens(event.summary);
        } else {
          this.contextAttribution.userMessages += this.estimateTokens(event.summary);
        }
      }
    } else if (event.type === 'assistant') {
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'thinking') {
            this.contextAttribution.thinking += this.estimateTokens((block.thinking as string) || '');
          } else if (block.type === 'tool_use') {
            const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || '');
            this.contextAttribution.toolInputs += this.estimateTokens(input);
          } else if (block.type === 'text') {
            this.contextAttribution.assistantResponses += this.estimateTokens((block.text as string) || '');
          }
        }
      } else if (event.summary) {
        this.contextAttribution.assistantResponses += this.estimateTokens(event.summary);
      }
    } else if (event.type === 'tool_use') {
      // Try raw input first (summary is truncated to ~80 chars)
      const rawInput = raw?.input != null ? JSON.stringify(raw.input) : null;
      const text = rawInput || event.summary || '';
      if (text) this.contextAttribution.toolInputs += this.estimateTokens(text);
    } else if (event.type === 'tool_result') {
      const rawContent = raw?.content;
      const text = typeof rawContent === 'string' ? rawContent
        : rawContent ? JSON.stringify(rawContent)
        : event.summary || '';
      if (text) this.contextAttribution.toolOutputs += this.estimateTokens(text);
    } else if (event.type === 'summary') {
      if (event.summary) {
        this.contextAttribution.other += this.estimateTokens(event.summary);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Timeline
  // ═══════════════════════════════════════════════════════════════════════

  private addTimelineFromSessionEvent(event: SessionEvent): void {
    let tlType: TimelineEvent['type'];
    let description: string;
    let noiseLevel: TimelineEvent['noiseLevel'] = 'system';
    const metadata: TimelineEvent['metadata'] = {};

    switch (event.type) {
      case 'user':
        tlType = 'user_prompt';
        description = this.extractTextContent(event) ?? 'User prompt';
        noiseLevel = 'user';
        break;
      case 'assistant':
        tlType = 'assistant_response';
        description = this.extractTextContent(event) ?? 'Assistant response';
        noiseLevel = 'ai';
        if (event.message.model) metadata.model = event.message.model;
        if (event.message.usage) {
          metadata.tokenCount = event.message.usage.input_tokens + event.message.usage.output_tokens;
        }
        break;
      case 'tool_use':
        tlType = 'tool_call';
        description = event.tool ? `${event.tool.name}` : 'Tool call';
        noiseLevel = 'system';
        if (event.tool) metadata.toolName = event.tool.name;
        break;
      case 'tool_result':
        tlType = 'tool_result';
        description = event.result ? `Result for tool call` : 'Tool result';
        noiseLevel = 'noise';
        if (event.result?.is_error) metadata.isError = true;
        break;
      case 'summary':
        tlType = 'compaction';
        description = 'Context compacted';
        noiseLevel = 'system';
        break;
      default:
        tlType = 'session_start';
        description = 'Event';
        break;
    }

    // Truncate description for timeline
    if (description.length > 200) {
      description = description.substring(0, 197) + '...';
    }

    this.timeline.push({
      type: tlType,
      timestamp: event.timestamp,
      description,
      noiseLevel,
      isSidechain: event.isSidechain,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    // Cap timeline
    if (this.timeline.length > this.timelineCap) {
      this.timeline.shift();
    }
  }

  private addTimelineFromFollowEvent(event: FollowEvent): void {
    let tlType: TimelineEvent['type'];
    let description = event.summary || '';
    let noiseLevel: TimelineEvent['noiseLevel'] = 'system';
    const metadata: TimelineEvent['metadata'] = {};

    switch (event.type) {
      case 'user':
        tlType = 'user_prompt';
        noiseLevel = 'user';
        break;
      case 'assistant':
        tlType = 'assistant_response';
        noiseLevel = 'ai';
        if (event.model) metadata.model = event.model;
        if (event.tokens) metadata.tokenCount = event.tokens.input + event.tokens.output;
        break;
      case 'tool_use':
        tlType = 'tool_call';
        noiseLevel = 'system';
        if (event.toolName) metadata.toolName = event.toolName;
        break;
      case 'tool_result':
        tlType = 'tool_result';
        noiseLevel = 'noise';
        break;
      case 'summary':
        tlType = 'compaction';
        noiseLevel = 'system';
        break;
      default:
        tlType = 'session_start';
        break;
    }

    // Truncate description for timeline
    if (description.length > 200) {
      description = description.substring(0, 197) + '...';
    }

    this.timeline.push({
      type: tlType,
      timestamp: event.timestamp,
      description,
      noiseLevel,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    // Cap timeline
    if (this.timeline.length > this.timelineCap) {
      this.timeline.shift();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Helper methods
  // ═══════════════════════════════════════════════════════════════════════

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private hasTextContent(event: SessionEvent): boolean {
    const content = event.message.content;
    if (typeof content === 'string') return content.length > 0;
    if (Array.isArray(content)) {
      return (content as Array<Record<string, unknown>>).some(
        b => b.type === 'text' && typeof b.text === 'string' && (b.text as string).length > 0
      );
    }
    return false;
  }

  private extractTextContent(event: SessionEvent): string | null {
    const content = event.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text as string;
        }
      }
    }
    return null;
  }

  private extractTaskIdFromResult(content: unknown): string | null {
    const str = typeof content === 'string' ? content : JSON.stringify(content || '');
    const taskMatch = str.match(/Task #(\d+)/i);
    if (taskMatch) return taskMatch[1];
    const jsonMatch = str.match(/"taskId"\s*:\s*"?(\d+)"?/i);
    if (jsonMatch) return jsonMatch[1];
    return null;
  }

  private isSystemPromptContent(text: string): boolean {
    return text.includes('<system-reminder>') || text.includes('CLAUDE.md');
  }
}
