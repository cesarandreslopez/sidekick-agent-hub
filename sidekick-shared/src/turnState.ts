/**
 * Whether an agent session is working on a turn, waiting for its user, idle,
 * or over, from its canonical session events.
 *
 * - `working`: a turn is running (a prompt arrived, the model is calling
 *   tools, a Codex turn started and has not ended).
 * - `waiting`: the turn is over and the agent waits for the next prompt, or
 *   for an answer to a question it asked (`AskUserQuestion`, `ExitPlanMode`).
 * - `idle`: waiting with nothing new for `idleAfterMs`.
 * - `ended`: the agent process exited (`processRunning: false`), or nothing
 *   happened for `staleAfterMs` and the process is not known to be running.
 *
 * What ends a turn is read from the log where the agent records it
 * (`evidence: 'reported'`): Claude Code's `stop_reason` (`end_turn`, …),
 * `turn_duration` and `stop_hook_summary` lines, API error messages, and
 * interrupt markers; Codex's turn-lifecycle events (`includeTurnLifecycle`).
 * A Codex log without lifecycle events is read by inference (`evidence:
 * 'inferred'`): a reply with no tool call pending ends the turn once
 * {@link TURN_STATE_REPLY_GRACE_MS} pass without anything new. The
 * synthetic plan-mode and patch tool uses the Codex parser emits never get
 * results and are ignored.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module turnState
 */

import { turnLifecycleFromEvent } from './turnLifecycle';
import type { SessionEvent } from './types/sessionEvent';

export type TurnState = 'working' | 'waiting' | 'idle' | 'ended';

export type TurnStateReason =
  | 'no-events'
  | 'user-prompt'
  | 'assistant-activity'
  | 'tool-pending'
  | 'tool-result'
  | 'end-turn'
  | 'turn-duration'
  | 'stop-hook'
  | 'api-error'
  | 'interrupted'
  | 'awaiting-input'
  | 'turn-started'
  | 'turn-complete'
  | 'turn-failed'
  | 'turn-aborted'
  | 'quiet-after-reply'
  | 'idle'
  | 'stale'
  | 'process-exited';

export interface TurnStateResult {
  state: TurnState;
  /** ISO time the session entered `state` (the record that put it there, or the time it crossed a threshold). */
  since: string | null;
  reason: TurnStateReason;
  /** ISO time of the last event that carried a usable timestamp. */
  lastEventAt: string | null;
  /** Tool calls issued and not answered yet, oldest first (at most 64). */
  pendingToolUseIds?: string[];
  /** `reported`: the log recorded the boundary; `inferred`: timing heuristics decided it. */
  evidence: 'reported' | 'inferred';
}

export interface TurnStateOptions {
  /** Clock in ms since epoch (default `Date.now()`). */
  now?: number;
  /** Nothing new for this long, the process not known to be running: `ended`. Default 30 min. */
  staleAfterMs?: number;
  /** A `waiting` session with nothing new for this long is `idle`. Default 5 min. */
  idleAfterMs?: number;
  /**
   * Whether the agent process is alive, when the caller knows. `false` makes
   * the session `ended`; `true` keeps staleness from ending it.
   */
  processRunning?: boolean;
}

/** How long a Codex reply without lifecycle events must stand before its turn counts as over. */
export const TURN_STATE_REPLY_GRACE_MS = 5_000;
export const DEFAULT_TURN_STATE_IDLE_MS = 5 * 60 * 1000;
export const DEFAULT_TURN_STATE_STALE_MS = 30 * 60 * 1000;

/** Tools whose call means the agent is waiting for its user's answer. */
const AWAITING_INPUT_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'request_user_input',
]);

/** Raw names of the Codex parser's synthetic tool uses, which never get results. */
const SYNTHETIC_RAW_TOOLS: ReadonlySet<string> = new Set([
  'task_started',
  'task_complete',
  'patch_applied',
]);

const ENDING_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
]);

const MAX_PENDING_TOOLS = 1024;
const REPORTED_PENDING_TOOLS = 64;

/** JSON-serializable tracker state from {@link TurnStateTracker.export}. */
export interface TurnStateSnapshot {
  version: 1;
  state: 'working' | 'waiting' | null;
  reason: TurnStateReason;
  evidence: 'reported' | 'inferred';
  since: string | null;
  lastEventAt: string | null;
  /** Pending tool calls, oldest first: `[id, awaitingInput]`. */
  pending: Array<[string, boolean]>;
  sawLifecycle: boolean;
  /** The last activity was a reply with no tool call in it. */
  lastWasReply: boolean;
}

export interface TurnStateTracker {
  /** Applies events in log order. */
  observe(events: SessionEvent | readonly SessionEvent[]): void;
  /** The state now, with the time-based rules applied. */
  current(options?: TurnStateOptions): TurnStateResult;
  reset(): void;
  export(): TurnStateSnapshot;
  /** Replaces the state with one from `export()`; false (nothing changed) when invalid. */
  import(snapshot: unknown): boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function blocksOf(event: SessionEvent): Record<string, unknown>[] {
  const content = event.message?.content;
  if (!Array.isArray(content)) return [];
  return content.map(record).filter((block): block is Record<string, unknown> => !!block);
}

function textOf(event: SessionEvent): string {
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  return blocksOf(event)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function validTime(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

const REASONS: ReadonlySet<string> = new Set<TurnStateReason>([
  'no-events',
  'user-prompt',
  'assistant-activity',
  'tool-pending',
  'tool-result',
  'end-turn',
  'turn-duration',
  'stop-hook',
  'api-error',
  'interrupted',
  'awaiting-input',
  'turn-started',
  'turn-complete',
  'turn-failed',
  'turn-aborted',
  'quiet-after-reply',
  'idle',
  'stale',
  'process-exited',
]);

class Tracker implements TurnStateTracker {
  private state: 'working' | 'waiting' | null = null;
  private reason: TurnStateReason = 'no-events';
  private evidence: 'reported' | 'inferred' = 'inferred';
  private since: string | null = null;
  private lastEventAt: string | null = null;
  /** Tool call id → whether it waits for the user's answer. */
  private pending = new Map<string, boolean>();
  private sawLifecycle = false;
  private lastWasReply = false;

  observe(events: SessionEvent | readonly SessionEvent[]): void {
    const list = Array.isArray(events) ? events : [events as SessionEvent];
    for (const event of list) this.apply(event);
  }

  private set(
    state: 'working' | 'waiting',
    reason: TurnStateReason,
    at: string | null,
    evidence: 'reported' | 'inferred' = 'reported',
  ): void {
    if (this.state !== state || this.since === null) this.since = at ?? this.since;
    this.state = state;
    this.reason = reason;
    this.evidence = evidence;
  }

  private remember(id: string, awaiting: boolean): void {
    this.pending.delete(id);
    this.pending.set(id, awaiting);
    while (this.pending.size > MAX_PENDING_TOOLS) {
      this.pending.delete(this.pending.keys().next().value as string);
    }
  }

  private apply(event: SessionEvent): void {
    if (!event || typeof event !== 'object') return;
    const at = validTime(event.timestamp);
    if (at !== null) this.lastEventAt = at;

    const lifecycle = turnLifecycleFromEvent(event);
    if (lifecycle) {
      this.sawLifecycle = true;
      this.lastWasReply = false;
      if (lifecycle.kind === 'task_started') {
        this.set('working', 'turn-started', at);
      } else {
        // A finished or aborted turn answers nothing that is still open.
        this.pending.clear();
        this.set(
          'waiting',
          lifecycle.kind === 'turn_aborted'
            ? 'turn-aborted'
            : lifecycle.failed
              ? 'turn-failed'
              : 'turn-complete',
          at,
        );
      }
      return;
    }

    switch (event.type) {
      case 'system': {
        const subtype = (event as { subtype?: unknown }).subtype;
        if (subtype === 'turn_duration' || subtype === 'stop_hook_summary') {
          this.pending.clear();
          this.lastWasReply = false;
          this.set('waiting', subtype === 'turn_duration' ? 'turn-duration' : 'stop-hook', at);
        }
        return;
      }
      case 'user':
        this.applyUser(event, at);
        return;
      case 'assistant':
        this.applyAssistant(event, at);
        return;
      case 'tool_use': {
        const name = event.tool?.name;
        const id = (event.message as { id?: unknown } | undefined)?.id;
        if (typeof id === 'string') this.remember(id, AWAITING_INPUT_TOOLS.has(name ?? ''));
        this.lastWasReply = false;
        this.set('working', 'tool-pending', at);
        return;
      }
      case 'tool_result': {
        this.pending.delete(event.result?.tool_use_id ?? '');
        this.lastWasReply = false;
        this.set('working', 'tool-result', at);
        return;
      }
      default:
        return;
    }
  }

  private applyUser(event: SessionEvent, at: string | null): void {
    if (event.isMeta === true || event.isSidechain === true) return;
    const blocks = blocksOf(event);
    const results = blocks.filter((block) => block.type === 'tool_result');
    if (results.length > 0) {
      for (const block of results) {
        if (typeof block.tool_use_id === 'string') this.pending.delete(block.tool_use_id);
      }
      this.lastWasReply = false;
      this.set('working', 'tool-result', at);
      return;
    }
    const text = textOf(event).trim();
    if (!text) return;
    if (text.startsWith('[Request interrupted by user')) {
      this.pending.clear();
      this.lastWasReply = false;
      this.set('waiting', 'interrupted', at);
      return;
    }
    // A prompt, a queued message, or a background task's notice: the agent runs again.
    this.lastWasReply = false;
    this.set('working', 'user-prompt', at);
  }

  private applyAssistant(event: SessionEvent, at: string | null): void {
    if (event.isSidechain === true) return;
    const message = event.message;
    const raw = event as unknown as Record<string, unknown>;
    const text = textOf(event);
    if (
      raw.isApiErrorMessage === true ||
      (message?.model === '<synthetic>' && /^API Error\b/.test(text.trim()))
    ) {
      this.pending.clear();
      this.lastWasReply = false;
      this.set('waiting', 'api-error', at);
      return;
    }
    let calledTool = false;
    for (const block of blocksOf(event)) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
      const input = record(block.input);
      const rawName = input?._sidekickRawToolName;
      if (typeof rawName === 'string' && SYNTHETIC_RAW_TOOLS.has(rawName)) continue;
      calledTool = true;
      this.remember(block.id, AWAITING_INPUT_TOOLS.has(String(block.name)));
    }
    const stopReason = message?.stop_reason;
    if (
      !calledTool &&
      typeof stopReason === 'string' &&
      ENDING_STOP_REASONS.has(stopReason) &&
      this.pending.size === 0
    ) {
      this.lastWasReply = false;
      this.set('waiting', 'end-turn', at);
      return;
    }
    const replied = !calledTool && text.trim().length > 0;
    if (calledTool || replied || blocksOf(event).length > 0) {
      this.lastWasReply = replied;
      this.set('working', calledTool ? 'tool-pending' : 'assistant-activity', at);
    }
  }

  current(options: TurnStateOptions = {}): TurnStateResult {
    const now = options.now ?? Date.now();
    const idleAfterMs = options.idleAfterMs ?? DEFAULT_TURN_STATE_IDLE_MS;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_TURN_STATE_STALE_MS;
    const pendingIds = [...this.pending.keys()];
    const pendingToolUseIds =
      pendingIds.length > 0
        ? { pendingToolUseIds: pendingIds.slice(0, REPORTED_PENDING_TOOLS) }
        : {};
    const lastEventAt = this.lastEventAt;
    const lastMs = lastEventAt === null ? null : Date.parse(lastEventAt);
    const iso = (ms: number): string => new Date(ms).toISOString();

    if (options.processRunning === false) {
      return {
        state: 'ended',
        since: lastEventAt,
        reason: 'process-exited',
        lastEventAt,
        ...pendingToolUseIds,
        evidence: 'reported',
      };
    }
    if (lastMs !== null && options.processRunning !== true && now - lastMs > staleAfterMs) {
      return {
        state: 'ended',
        since: iso(lastMs + staleAfterMs),
        reason: 'stale',
        lastEventAt,
        ...pendingToolUseIds,
        evidence: 'inferred',
      };
    }
    if (this.state === null || lastMs === null) {
      return { state: 'idle', since: null, reason: 'no-events', lastEventAt, evidence: 'inferred' };
    }

    let state: 'working' | 'waiting' = this.state;
    let reason = this.reason;
    let evidence = this.evidence;
    let since = this.since;
    if ([...this.pending.values()].some(Boolean)) {
      // The agent asked its user something and waits for the answer.
      state = 'waiting';
      reason = 'awaiting-input';
      evidence = 'reported';
    } else if (
      state === 'working' &&
      !this.sawLifecycle &&
      this.lastWasReply &&
      this.pending.size === 0
    ) {
      // A reply with nothing pending, from a log that records no turn ends.
      if (now - lastMs >= TURN_STATE_REPLY_GRACE_MS) {
        state = 'waiting';
        reason = 'quiet-after-reply';
        since = iso(lastMs + TURN_STATE_REPLY_GRACE_MS);
      }
      evidence = 'inferred';
    }
    if (state === 'waiting' && now - lastMs > idleAfterMs) {
      return {
        state: 'idle',
        since: iso(lastMs + idleAfterMs),
        reason: 'idle',
        lastEventAt,
        ...pendingToolUseIds,
        evidence: 'inferred',
      };
    }
    return { state, since, reason, lastEventAt, ...pendingToolUseIds, evidence };
  }

  reset(): void {
    this.state = null;
    this.reason = 'no-events';
    this.evidence = 'inferred';
    this.since = null;
    this.lastEventAt = null;
    this.pending.clear();
    this.sawLifecycle = false;
    this.lastWasReply = false;
  }

  export(): TurnStateSnapshot {
    return {
      version: 1,
      state: this.state,
      reason: this.reason,
      evidence: this.evidence,
      since: this.since,
      lastEventAt: this.lastEventAt,
      pending: [...this.pending],
      sawLifecycle: this.sawLifecycle,
      lastWasReply: this.lastWasReply,
    };
  }

  import(snapshot: unknown): boolean {
    const raw = record(snapshot);
    if (!raw || raw.version !== 1) return false;
    if (raw.state !== null && raw.state !== 'working' && raw.state !== 'waiting') return false;
    if (typeof raw.reason !== 'string' || !REASONS.has(raw.reason)) return false;
    if (raw.evidence !== 'reported' && raw.evidence !== 'inferred') return false;
    if (raw.since !== null && validTime(raw.since) === null) return false;
    if (raw.lastEventAt !== null && validTime(raw.lastEventAt) === null) return false;
    if (typeof raw.sawLifecycle !== 'boolean' || typeof raw.lastWasReply !== 'boolean') {
      return false;
    }
    const pending = raw.pending;
    if (
      !Array.isArray(pending) ||
      !pending.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'boolean',
      )
    ) {
      return false;
    }
    this.reset();
    this.state = raw.state as 'working' | 'waiting' | null;
    this.reason = raw.reason as TurnStateReason;
    this.evidence = raw.evidence;
    this.since = raw.since as string | null;
    this.lastEventAt = raw.lastEventAt as string | null;
    for (const [id, awaiting] of pending as Array<[string, boolean]>) this.remember(id, awaiting);
    this.sawLifecycle = raw.sawLifecycle;
    this.lastWasReply = raw.lastWasReply;
    return true;
  }
}

/** An incremental turn-state classifier: observe events as they arrive, ask for `current()`. */
export function createTurnStateTracker(): TurnStateTracker {
  return new Tracker();
}

/** The turn state of a session from its events in log order (see the module docs). */
export function classifyTurnState(
  events: readonly SessionEvent[],
  options: TurnStateOptions = {},
): TurnStateResult {
  const tracker = new Tracker();
  tracker.observe(events);
  return tracker.current(options);
}
