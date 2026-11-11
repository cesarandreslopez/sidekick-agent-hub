/**
 * Turns canonical session events into activity records.
 *
 * One recorder per session. It knows each provider's quirks:
 *
 * - Claude Code writes one line per content block, all sharing a message id:
 *   a model step is counted once per message.
 * - OpenCode knows a tool call's start only at its end: the `toolEnd` carries
 *   the corrected `startedAt` (end minus duration).
 * - Codex writes some results twice (a function-call output and an exec end
 *   event): a call ends once, and a later result can only make it `denied`.
 * - Codex fans one `apply_patch` out into one edit per file: the recorder
 *   folds them back into one call (`fold`).
 * - Synthetic calls the parsers emit for things already done (Codex
 *   `patch_applied`, plan-mode markers, OpenCode patch parts) start and end
 *   at once (`instant`).
 * - Turn ends come from the shared turn-state rules; calls still open when a
 *   turn ends are closed (`cancelled` when the turn was aborted).
 *
 * Records are content-free: labels come from `activity/classify` and the
 * fixed vocabulary only.
 *
 * Pure: no clock, no filesystem. Deterministic for a given event sequence.
 *
 * @module activity/recorder
 */

import { hookActivityFromEvent } from '../hookActivity';
import { isInjectedPromptText } from '../humanPrompt';
import { memoryAttachmentFromEvent } from '../memoryAttachment';
import { getModelContextWindowSize } from '../modelContext';
import type { SessionProviderId } from '../providerIds';
import { subagentActivityFromEvent } from '../subagentActivity';
import {
  contentText,
  isAgentsKilledSystemEvent,
  isSubagentSpawnTool,
  parseAsyncAgentLaunch,
  parseSpawnResultAgentId,
  parseTaskNotification,
  taskNotificationFromEvent,
  taskStatusFromEvent,
} from '../subagentSpawn';
import { createTurnStateTracker, type TurnStateReason, type TurnStateTracker } from '../turnState';
import type { SessionEvent } from '../types/sessionEvent';
import { classifyActivityTool } from './classify';
import { activityPathLabel, cleanActivityLabel, identifierLabel } from './labels';
import type { ActivityStationId } from './stations';
import { DEFAULT_ACTIVITY_STRINGS, type ActivityLabelKey } from './strings';
import type {
  ActivityContextObservation,
  ActivityDeniedBy,
  ActivityEventSource,
  ActivityHookOutcome,
  ActivityOutcome,
  ActivityRecord,
  ActivityRecorder,
  ActivityRecorderOptions,
  ActivityRecorderState,
  ActivityTurnOutcome,
} from './types';

/** Distributes `Omit` over the record union, so each kind keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RecordDraft = DistributiveOmit<ActivityRecord, 'seq'>;

const MAX_SEEN = 512;
const MAX_ALIASES = 512;
const MAX_CLOSED = 1024;
const COMPACTION_DEDUPE_MS = 2_000;
const REJECTED_PREFIX = "The user doesn't want to proceed with this tool use";
const INTERRUPT_PREFIX = '[Request interrupted by user';
const HOOK_DENIAL = /^(?:PreToolUse|PermissionRequest)(?::[\w.-]+)?\s+hook\b/i;
const OPENCODE_INSTANT_ID = /^(?:patch-|plan-enter-|plan-exit-)/;
const SKILL_BLOCK = /^<skill>\s*<name>\s*([\w:.@/-]{1,64})\s*<\/name>/;
const SLASH_COMMAND = /<command-name>\s*\/?([\w:.@/-]{1,64})\s*<\/command-name>/;
const CODEX_INSTRUCTIONS = /^(?:# AGENTS\.md instructions\b|<user_instructions>)/;
const CODEX_SUBAGENT_NOTIFICATION = /^<subagent_notification>/;

interface OpenCall {
  at: number;
  station: ActivityStationId;
  spawn: boolean;
}

interface StreamState {
  /** Open calls by id, oldest first. */
  open: Map<string, OpenCall>;
  /** Assistant message ids already counted as a step. */
  steps: Set<string>;
  /** Tool-use ids already started (so a repeated block is ignored). */
  started: Set<string>;
  lastActivityAt?: number;
}

/** A call already ended: its outcome, so a later result can only upgrade it to denied. */
interface ClosedCall {
  outcome: ActivityOutcome;
  spawn: boolean;
}

function bounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

function boundedSet<K>(set: Set<K>, key: K, max: number): void {
  set.delete(key);
  set.add(key);
  while (set.size > max) set.delete(set.values().next().value as K);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function blocksOf(event: SessionEvent): Record<string, unknown>[] {
  const content = event.message?.content;
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const item of content) {
    const block = record(item);
    if (block) blocks.push(block);
  }
  return blocks;
}

function textOf(event: SessionEvent): string {
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  return blocksOf(event)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/** Characters of text a tool result put into context (images count 0). */
function resultChars(content: unknown, depth = 0): number {
  if (typeof content === 'string') return content.length;
  if (depth > 4 || content === null || content === undefined) return 0;
  if (Array.isArray(content)) {
    let total = 0;
    for (const item of content) total += resultChars(item, depth + 1);
    return total;
  }
  const block = record(content);
  if (!block) return typeof content === 'number' ? String(content).length : 0;
  if (block.type === 'image' || block.type === 'document') return 0;
  if (typeof block.text === 'string') return block.text.length;
  if (block.content !== undefined) return resultChars(block.content, depth + 1);
  try {
    return Math.min(JSON.stringify(block).length, 10_000_000);
  } catch {
    return 0;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The context of a usage sample: everything the request read (uncached input + cache reads + cache writes). */
function contextTokens(event: SessionEvent): number | undefined {
  const normalized = event.message?.normalizedUsage;
  if (normalized && Number.isFinite(normalized.cacheInclusiveInputTokens)) {
    return normalized.cacheInclusiveInputTokens;
  }
  const usage = event.message?.usage;
  if (!usage) return undefined;
  const total =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  return Number.isFinite(total) ? total : undefined;
}

function vocabularyLabel(key: ActivityLabelKey): { label: string; labelKey: ActivityLabelKey } {
  return { label: DEFAULT_ACTIVITY_STRINGS.labels[key], labelKey: key };
}

function deniedByOf(source: string | undefined): ActivityDeniedBy {
  if (!source) return 'policy';
  if (/hook/i.test(source)) return 'hook';
  if (source === 'user_reject' || /^user/.test(source)) return 'user';
  return 'policy';
}

function turnOutcomeOf(reason: TurnStateReason): ActivityTurnOutcome | null {
  switch (reason) {
    case 'end-turn':
    case 'turn-duration':
    case 'stop-hook':
    case 'turn-complete':
    case 'quiet-after-reply':
      return 'done';
    case 'turn-aborted':
    case 'interrupted':
      return 'aborted';
    case 'api-error':
    case 'turn-failed':
      return 'error';
    default:
      return null;
  }
}

/** The prompt-rule provider: OpenCode prompts carry no harness prefixes of their own. */
function promptProvider(providerId: SessionProviderId): 'claude-code' | 'codex' {
  return providerId === 'codex' ? 'codex' : 'claude-code';
}

class Recorder implements ActivityRecorder {
  private seq = 0;
  private lastAt: number | undefined;
  private streams = new Map<string, StreamState>();
  /** Provider agent ids (a child thread, a Claude agent id) → the spawning call's id. */
  private aliases = new Map<string, string>();
  /** A Codex patch fan-out's per-file tool-use id → the patch call id. */
  private patchFiles = new Map<string, string>();
  private closed = new Map<string, ClosedCall>();
  /** Tool calls a hook record already blocked. */
  private hookBlocked = new Set<string>();
  /** Subagents started and not ended, by canonical id. */
  private activeAgents = new Set<string>();
  private tracker: TurnStateTracker = createTurnStateTracker();
  private working = false;
  private lastContextTokens: number | undefined;
  private lastCompactionAt: number | undefined;
  private sessionEmitted = false;

  constructor(private readonly options: ActivityRecorderOptions) {}

  get nextSeq(): number {
    return this.seq;
  }

  // ── public ──

  observe(event: SessionEvent, source?: ActivityEventSource): ActivityRecord[] {
    const out: ActivityRecord[] = [];
    if (!event || typeof event !== 'object') return out;
    const at = this.timeOf(event.timestamp);
    this.ensureSession(out, at);
    const agentId = this.agentOf(event, source);
    const stream = this.stream(agentId);
    try {
      switch (event.type) {
        case 'assistant':
          this.onAssistant(event, at, agentId, stream, out);
          break;
        case 'user':
          this.onUser(event, at, agentId, stream, out);
          break;
        case 'system':
          this.onSystem(event, at, agentId, stream, out);
          break;
        case 'summary':
          this.onCompaction(event, at, agentId, out);
          break;
        default:
          break;
      }
    } finally {
      if (agentId === undefined) this.afterMainEvent(event, at, out);
    }
    return out;
  }

  observeMany(events: readonly SessionEvent[], source?: ActivityEventSource): ActivityRecord[] {
    const out: ActivityRecord[] = [];
    for (const event of events) out.push(...this.observe(event, source));
    return out;
  }

  observeContext(observation: ActivityContextObservation): ActivityRecord[] {
    const out: ActivityRecord[] = [];
    if (!observation || !Number.isFinite(observation.percent)) return out;
    const at = this.clampTime(finiteNumber(observation.at));
    this.ensureSession(out, at);
    this.push(out, {
      kind: 'context',
      at,
      percent: Math.max(0, Math.min(100, observation.percent)),
      ...(finiteNumber(observation.tokens) !== undefined ? { tokens: observation.tokens } : {}),
      ...(finiteNumber(observation.window) !== undefined ? { window: observation.window } : {}),
      source: 'host',
    });
    return out;
  }

  settle(at: number, outcome: 'unknown' | 'cancelled' = 'unknown'): ActivityRecord[] {
    const out: ActivityRecord[] = [];
    const when = this.clampTime(finiteNumber(at));
    for (const [agentKey, stream] of this.streams) {
      const agentId = agentKey === '' ? undefined : agentKey;
      this.closeOpen(stream, when, agentId, outcome, out);
    }
    for (const agentId of [...this.activeAgents]) {
      this.endAgent(agentId, when, 'cancelled', out);
    }
    return out;
  }

  reset(): void {
    this.seq = 0;
    this.lastAt = undefined;
    this.streams.clear();
    this.aliases.clear();
    this.patchFiles.clear();
    this.closed.clear();
    this.hookBlocked.clear();
    this.activeAgents.clear();
    this.tracker.reset();
    this.working = false;
    this.lastContextTokens = undefined;
    this.lastCompactionAt = undefined;
    this.sessionEmitted = false;
  }

  export(): ActivityRecorderState {
    return {
      version: 1,
      providerId: this.options.providerId,
      seq: this.seq,
      lastAt: this.lastAt ?? null,
      streams: [...this.streams].map(([key, stream]) => ({
        key,
        open: [...stream.open].map(([id, call]) => [id, call.at, call.station, call.spawn]),
        steps: [...stream.steps],
        started: [...stream.started],
        lastActivityAt: stream.lastActivityAt ?? null,
      })),
      aliases: [...this.aliases],
      patchFiles: [...this.patchFiles],
      closed: [...this.closed].map(([id, call]) => [id, call.outcome, call.spawn]),
      hookBlocked: [...this.hookBlocked],
      activeAgents: [...this.activeAgents],
      tracker: this.tracker.export(),
      working: this.working,
      lastContextTokens: this.lastContextTokens ?? null,
      lastCompactionAt: this.lastCompactionAt ?? null,
      sessionEmitted: this.sessionEmitted,
    };
  }

  import(state: unknown): boolean {
    const raw = record(state);
    const ok = raw !== undefined && raw.version === 1 && this.restore(raw);
    if (!ok) this.reset();
    return ok;
  }

  // ── restore ──

  private restore(raw: Record<string, unknown>): boolean {
    if (raw.providerId !== this.options.providerId) return false;
    if (!Number.isInteger(raw.seq) || (raw.seq as number) < 0) return false;
    const optionalNumber = (value: unknown): number | undefined | false =>
      value === null || value === undefined
        ? undefined
        : typeof value === 'number' && Number.isFinite(value)
          ? value
          : false;
    const strings = (value: unknown): string[] | null =>
      Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? (value as string[])
        : null;
    const lastAt = optionalNumber(raw.lastAt);
    const lastContextTokens = optionalNumber(raw.lastContextTokens);
    const lastCompactionAt = optionalNumber(raw.lastCompactionAt);
    if (lastAt === false || lastContextTokens === false || lastCompactionAt === false) {
      return false;
    }
    if (!Array.isArray(raw.streams)) return false;
    const streams = new Map<string, StreamState>();
    for (const item of raw.streams) {
      const entry = record(item);
      if (!entry || typeof entry.key !== 'string' || !Array.isArray(entry.open)) return false;
      const steps = strings(entry.steps);
      const started = strings(entry.started);
      const lastActivityAt = optionalNumber(entry.lastActivityAt);
      if (!steps || !started || lastActivityAt === false) return false;
      const open = new Map<string, OpenCall>();
      for (const call of entry.open) {
        if (
          !Array.isArray(call) ||
          typeof call[0] !== 'string' ||
          typeof call[1] !== 'number' ||
          typeof call[2] !== 'string' ||
          typeof call[3] !== 'boolean'
        ) {
          return false;
        }
        open.set(call[0], { at: call[1], station: call[2] as ActivityStationId, spawn: call[3] });
      }
      streams.set(entry.key, {
        open,
        steps: new Set(steps),
        started: new Set(started),
        ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      });
    }
    const pairs = (value: unknown): Array<[string, string]> | null =>
      Array.isArray(value) &&
      value.every(
        (item) => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string',
      )
        ? (value as Array<[string, string]>)
        : null;
    const aliases = pairs(raw.aliases);
    const patchFiles = pairs(raw.patchFiles);
    const hookBlocked = strings(raw.hookBlocked);
    const activeAgents = strings(raw.activeAgents);
    if (!aliases || !patchFiles || !hookBlocked || !activeAgents) return false;
    if (!Array.isArray(raw.closed)) return false;
    const closed = new Map<string, ClosedCall>();
    for (const item of raw.closed) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'string') {
        return false;
      }
      closed.set(item[0], { outcome: item[1] as ActivityOutcome, spawn: item[2] === true });
    }
    const tracker = createTurnStateTracker();
    if (!tracker.import(raw.tracker)) return false;
    if (typeof raw.working !== 'boolean' || typeof raw.sessionEmitted !== 'boolean') return false;

    this.seq = raw.seq as number;
    this.lastAt = lastAt;
    this.streams = streams;
    this.aliases = new Map(aliases);
    this.patchFiles = new Map(patchFiles);
    this.closed = closed;
    this.hookBlocked = new Set(hookBlocked);
    this.activeAgents = new Set(activeAgents);
    this.tracker = tracker;
    this.working = raw.working;
    this.lastContextTokens = lastContextTokens;
    this.lastCompactionAt = lastCompactionAt;
    this.sessionEmitted = raw.sessionEmitted;
    return true;
  }

  // ── helpers ──

  private push(out: ActivityRecord[], draft: RecordDraft): void {
    out.push({ ...draft, seq: this.seq++ } as ActivityRecord);
  }

  private ensureSession(out: ActivityRecord[], at: number): void {
    if (this.sessionEmitted) return;
    this.sessionEmitted = true;
    this.push(out, {
      kind: 'session',
      at,
      providerId: this.options.providerId,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
    });
  }

  /** Event time, never earlier than the previous record's (logs are not always in order). */
  private timeOf(timestamp: unknown): number {
    const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    return this.clampTime(Number.isFinite(parsed) ? parsed : undefined);
  }

  private clampTime(at: number | undefined): number {
    const value = at === undefined ? (this.lastAt ?? 0) : Math.max(at, this.lastAt ?? at);
    this.lastAt = value;
    return value;
  }

  private canonicalAgent(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  private agentOf(event: SessionEvent, source?: ActivityEventSource): string | undefined {
    if (source?.agentId) {
      if (source.spawnId && source.spawnId !== source.agentId) {
        bounded(this.aliases, source.agentId, source.spawnId, MAX_ALIASES);
      }
      return this.canonicalAgent(source.spawnId ?? source.agentId);
    }
    if (event.agentId) return this.canonicalAgent(event.agentId);
    if (event.isSidechain === true) return 'sidechain';
    return undefined;
  }

  private stream(agentId: string | undefined): StreamState {
    const key = agentId ?? '';
    let stream = this.streams.get(key);
    if (!stream) {
      stream = { open: new Map(), steps: new Set(), started: new Set() };
      this.streams.set(key, stream);
    }
    return stream;
  }

  private label(text: string): string {
    return cleanActivityLabel(text, 60);
  }

  // ── assistant ──

  private onAssistant(
    event: SessionEvent,
    at: number,
    agentId: string | undefined,
    stream: StreamState,
    out: ActivityRecord[],
  ): void {
    const message = event.message;
    const model = message?.model;
    const isCorrection = message?.usageKind === 'correction';

    // A model step: once per message (Claude writes one line per block), not
    // for synthetic messages; Codex steps come from its token counts instead.
    if (
      this.options.providerId !== 'codex' &&
      model !== '<synthetic>' &&
      !isCorrection &&
      (message?.usage || message?.id)
    ) {
      const id = message?.id;
      if (!id || !stream.steps.has(id)) {
        if (id) boundedSet(stream.steps, id, MAX_SEEN);
        this.push(out, {
          kind: 'step',
          at,
          ...(agentId ? { agentId } : {}),
          ...(model ? { model } : {}),
          ...(stream.lastActivityAt !== undefined ? { startedAt: stream.lastActivityAt } : {}),
        });
      }
    }
    if (agentId === undefined && !isCorrection) this.deriveContext(event, at, model, out);

    for (const block of blocksOf(event)) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
      this.startCall(block, at, agentId, stream, out);
    }
    stream.lastActivityAt = at;
  }

  private startCall(
    block: Record<string, unknown>,
    at: number,
    agentId: string | undefined,
    stream: StreamState,
    out: ActivityRecord[],
  ): void {
    const name = typeof block.name === 'string' ? block.name : 'tool';
    const input = record(block.input);
    const rawId = block.id as string;
    const patchCallId =
      typeof input?._sidekickPatchCallId === 'string' ? input._sidekickPatchCallId : undefined;
    if (patchCallId && patchCallId !== rawId) {
      bounded(this.patchFiles, rawId, patchCallId, MAX_CLOSED);
    }
    const id = patchCallId ?? rawId;
    if (stream.started.has(id) || stream.open.has(id)) return;
    boundedSet(stream.started, id, MAX_SEEN * 4);

    const classified = classifyActivityTool(name, input, this.options);
    const fileCount = Number(input?._sidekickPatchFileCount);
    const fold =
      patchCallId && Number.isInteger(fileCount) && fileCount > 1 ? fileCount : undefined;
    const label =
      fold && !classified.labelKey
        ? `${classified.label.replace(/ \+\d+$/, '')} +${fold - 1}`
        : classified.label;
    const instant =
      classified.instant === true ||
      (this.options.providerId === 'opencode' && OPENCODE_INSTANT_ID.test(rawId));
    const spawn = isSubagentSpawnTool(name, input);

    this.push(out, {
      kind: 'toolStart',
      at,
      ...(agentId ? { agentId } : {}),
      id,
      station: classified.station,
      label: this.label(label),
      ...(classified.labelKey ? { labelKey: classified.labelKey } : {}),
      tool: classified.tool,
      ...(classified.hint ? { hint: classified.hint } : {}),
      ...(fold ? { fold } : {}),
      ...(instant ? { instant: true as const } : {}),
      ...(spawn ? { spawn: true as const } : {}),
    });

    if (instant) {
      this.push(out, {
        kind: 'toolEnd',
        at,
        ...(agentId ? { agentId } : {}),
        id,
        outcome: 'ok',
      });
      bounded(
        this.closed,
        this.closedKey(agentId, id),
        { outcome: 'ok', spawn: false },
        MAX_CLOSED,
      );
      return;
    }

    bounded(stream.open, id, { at, station: classified.station, spawn }, this.maxOpen());
    if (spawn) {
      this.activeAgents.add(id);
      this.push(out, {
        kind: 'subagentStart',
        at,
        agentId: id,
        spawnId: id,
        ...(agentId ? { parentAgentId: agentId } : {}),
        label: this.label(classified.label),
      });
    }
  }

  private maxOpen(): number {
    return Math.max(16, this.options.maxOpenCalls ?? 1024);
  }

  private closedKey(agentId: string | undefined, id: string): string {
    return `${agentId ?? ''}\u0000${id}`;
  }

  private deriveContext(
    event: SessionEvent,
    at: number,
    model: string | undefined,
    out: ActivityRecord[],
  ): void {
    if (this.options.deriveContext === false) return;
    const tokens = contextTokens(event);
    if (tokens === undefined || tokens <= 0 || tokens === this.lastContextTokens) return;
    const reported = event.providerMetadata?.contextWindowTokens;
    const window =
      (typeof reported === 'number' && reported > 0 ? reported : undefined) ??
      (this.options.contextWindowOf
        ? this.options.contextWindowOf(model)
        : model
          ? getModelContextWindowSize(model)
          : undefined);
    if (!window || window <= 0) return;
    this.lastContextTokens = tokens;
    this.push(out, {
      kind: 'context',
      at,
      percent: Math.max(0, Math.min(100, (tokens / window) * 100)),
      tokens,
      window,
      source: 'usage',
    });
  }

  // ── user ──

  private onUser(
    event: SessionEvent,
    at: number,
    agentId: string | undefined,
    stream: StreamState,
    out: ActivityRecord[],
  ): void {
    const blocks = blocksOf(event);
    const results = blocks.filter((block) => block.type === 'tool_result');
    if (results.length > 0) {
      for (const block of results) this.endCall(event, block, at, agentId, stream, out);
      stream.lastActivityAt = at;
      return;
    }
    if (event.isMeta === true || event.isCompactSummary === true) return;
    const text = textOf(event);
    const trimmed = text.trim();
    if (!trimmed) return;
    // Whatever arrived, the model's next step starts from here.
    stream.lastActivityAt = at;

    if (trimmed.startsWith(INTERRUPT_PREFIX)) {
      if (agentId === undefined) this.endTurn(at, 'aborted', out);
      return;
    }
    const notification = parseTaskNotification(trimmed);
    if (notification) {
      this.onTaskNotification(notification, at, out);
      return;
    }
    if (agentId !== undefined) return;

    const provider = promptProvider(this.options.providerId);
    if (provider === 'codex') {
      if (CODEX_INSTRUCTIONS.test(trimmed)) {
        this.push(out, {
          kind: 'memoryPushed',
          at,
          ...vocabularyLabel('instructions'),
          chars: text.length,
          via: 'instructions',
        });
        return;
      }
      const skill = SKILL_BLOCK.exec(trimmed);
      if (skill || trimmed.startsWith('<skill>')) {
        this.push(out, {
          kind: 'inbound',
          at,
          station: 'skills',
          ...(skill && this.options.labels !== 'none'
            ? { label: skill[1] }
            : vocabularyLabel('skill')),
        });
        return;
      }
      if (CODEX_SUBAGENT_NOTIFICATION.test(trimmed)) {
        this.push(out, {
          kind: 'inbound',
          at,
          station: 'agents',
          ...vocabularyLabel('notification'),
        });
        return;
      }
    }
    if (event.origin?.kind !== undefined && event.origin.kind !== 'human') return;
    if (event.promptSource === 'system') return;
    if (isInjectedPromptText(trimmed, provider)) return;

    // OpenCode records no turn ends: a new prompt closes the previous turn.
    if (this.options.providerId === 'opencode' && this.working) this.endTurn(at, 'done', out);
    this.push(out, { kind: 'prompt', at });
    const command = SLASH_COMMAND.exec(trimmed);
    const commandName = command ? identifierLabel(command[1]) : undefined;
    if (commandName) {
      this.push(out, {
        kind: 'inbound',
        at,
        station: 'skills',
        ...(this.options.labels === 'none'
          ? vocabularyLabel('skill')
          : { label: `/${commandName}` }),
      });
    }
  }

  private endCall(
    event: SessionEvent,
    block: Record<string, unknown>,
    at: number,
    agentId: string | undefined,
    stream: StreamState,
    out: ActivityRecord[],
  ): void {
    const rawId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
    if (!rawId) return;
    const id = this.patchFiles.get(rawId) ?? rawId;
    const closedKey = this.closedKey(agentId, id);
    const open = stream.open.get(id);
    const previous = this.closed.get(closedKey);
    if (!open && !previous) return;

    const text = contentText(block.content).trimStart();
    const decision = event.permissionDecision;
    let outcome: ActivityOutcome;
    let deniedBy: ActivityDeniedBy | undefined;
    if (decision?.decision === 'reject') {
      outcome = 'denied';
      deniedBy = deniedByOf(decision.source);
    } else if (text.startsWith(REJECTED_PREFIX)) {
      outcome = 'denied';
      deniedBy = 'user';
    } else if (HOOK_DENIAL.test(text)) {
      outcome = 'denied';
      deniedBy = 'hook';
    } else if (text.startsWith(INTERRUPT_PREFIX)) {
      outcome = 'cancelled';
    } else {
      outcome = block.is_error === true ? 'error' : 'ok';
    }

    if (previous) {
      // Already ended: only a refusal changes it now.
      if (outcome !== 'denied' || previous.outcome === 'denied') return;
    }

    const duration = finiteNumber(block.duration);
    const durationMs = duration !== undefined && duration >= 0 ? Math.round(duration) : undefined;
    const asked =
      decision?.decision === 'accept' && typeof decision.source === 'string'
        ? /^user/.test(decision.source)
        : false;
    const startedAt =
      this.options.providerId === 'opencode' && durationMs !== undefined
        ? at - durationMs
        : undefined;

    this.push(out, {
      kind: 'toolEnd',
      at,
      ...(agentId ? { agentId } : {}),
      id,
      outcome,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(previous ? {} : { resultChars: resultChars(block.content) }),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(deniedBy ? { deniedBy } : {}),
      ...(asked ? { asked: true as const } : {}),
    });
    stream.open.delete(id);
    const spawn = open?.spawn ?? previous?.spawn ?? false;
    bounded(this.closed, closedKey, { outcome, spawn }, MAX_CLOSED);

    if (deniedBy === 'hook' && !this.hookBlocked.has(id)) {
      boundedSet(this.hookBlocked, id, MAX_SEEN);
      this.push(out, {
        kind: 'hook',
        at,
        ...(agentId ? { agentId } : {}),
        hookEvent: 'PreToolUse',
        toolUseId: id,
        outcome: 'blocked',
        ...(this.options.labels === 'none'
          ? vocabularyLabel('hookBlocked')
          : { label: 'PreToolUse' }),
      } as RecordDraft);
    }

    if (open?.spawn && !previous) this.onSpawnResult(id, block.content, outcome, at, out);
  }

  private onSpawnResult(
    spawnId: string,
    content: unknown,
    outcome: ActivityOutcome,
    at: number,
    out: ActivityRecord[],
  ): void {
    const reported = parseSpawnResultAgentId(content);
    if (reported && reported !== spawnId) bounded(this.aliases, reported, spawnId, MAX_ALIASES);
    // A background launch keeps running; Codex children end through their activity records.
    if (parseAsyncAgentLaunch(content)) return;
    if (this.options.providerId === 'codex' && outcome === 'ok') return;
    this.endAgent(
      spawnId,
      at,
      outcome === 'ok' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'error',
      out,
    );
  }

  private onTaskNotification(
    notification: { taskId: string; toolUseId?: string; status?: string },
    at: number,
    out: ActivityRecord[],
  ): void {
    const agentId = notification.toolUseId
      ? this.canonicalAgent(notification.toolUseId)
      : this.canonicalAgent(notification.taskId);
    const status = (notification.status ?? '').toLowerCase();
    const outcome = /fail|error/.test(status)
      ? 'error'
      : /kill|stop|cancel/.test(status)
        ? 'cancelled'
        : 'ok';
    this.push(out, { kind: 'inbound', at, station: 'agents', ...vocabularyLabel('notification') });
    this.endAgent(agentId, at, outcome, out);
  }

  private endAgent(
    agentId: string,
    at: number,
    outcome: 'ok' | 'error' | 'cancelled',
    out: ActivityRecord[],
  ): void {
    if (!this.activeAgents.has(agentId)) return;
    this.activeAgents.delete(agentId);
    const stream = this.streams.get(agentId);
    if (stream)
      this.closeOpen(stream, at, agentId, outcome === 'ok' ? 'unknown' : 'cancelled', out);
    this.push(out, { kind: 'subagentEnd', at, agentId, outcome });
  }

  // ── system ──

  private onSystem(
    event: SessionEvent,
    at: number,
    agentId: string | undefined,
    stream: StreamState,
    out: ActivityRecord[],
  ): void {
    const hook = hookActivityFromEvent(event);
    if (hook) {
      this.onHook(hook, at, agentId, out);
      return;
    }
    const memory = memoryAttachmentFromEvent(event);
    if (memory) {
      this.push(out, {
        kind: 'memoryPushed',
        at,
        ...(agentId ? { agentId } : {}),
        ...(this.options.labels === 'none'
          ? vocabularyLabel('memory')
          : { label: activityPathLabel(memory.displayPath ?? memory.path) || 'memory' }),
        chars: memory.chars,
        via: 'attachment',
      });
      return;
    }
    const activity = subagentActivityFromEvent(event);
    if (activity) {
      this.onSubagentActivity(activity, at, agentId, out);
      return;
    }
    const notification = taskNotificationFromEvent(event);
    if (notification) {
      this.onTaskNotification(notification, at, out);
      return;
    }
    const status = taskStatusFromEvent(event);
    if (status) {
      const outcome = /fail|error/i.test(status.status ?? '')
        ? 'error'
        : /kill|stop|cancel/i.test(status.status ?? '')
          ? 'cancelled'
          : 'ok';
      this.endAgent(this.canonicalAgent(status.taskId), at, outcome, out);
      return;
    }
    if (isAgentsKilledSystemEvent(event)) {
      for (const id of [...this.activeAgents]) this.endAgent(id, at, 'cancelled', out);
      return;
    }
    if ((event.type === 'system' && event.subtype === 'compact_boundary') || event.compaction) {
      this.onCompaction(event, at, agentId, out);
      return;
    }
    // A Codex token count: one model request finished.
    const message = event.message;
    if (
      message?.usage &&
      message.usageKind !== 'correction' &&
      message.sourceLabel === 'token count'
    ) {
      this.push(out, {
        kind: 'step',
        at,
        ...(agentId ? { agentId } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(stream.lastActivityAt !== undefined ? { startedAt: stream.lastActivityAt } : {}),
      });
      if (agentId === undefined) this.deriveContext(event, at, message.model, out);
      stream.lastActivityAt = at;
    }
  }

  private onHook(
    hook: NonNullable<ReturnType<typeof hookActivityFromEvent>>,
    at: number,
    agentId: string | undefined,
    out: ActivityRecord[],
  ): void {
    const none = this.options.labels === 'none';
    const outcome: ActivityHookOutcome = hook.outcome;
    const key: ActivityLabelKey =
      outcome === 'blocked'
        ? 'hookBlocked'
        : outcome === 'error'
          ? 'hookError'
          : outcome === 'context'
            ? 'hookContext'
            : 'hookCheck';
    let label: { label: string; labelKey?: ActivityLabelKey };
    if (none) {
      label = vocabularyLabel(key);
    } else {
      const parts = [hook.hookEvent];
      if (hook.matcher) parts.push(hook.matcher);
      if (this.options.labels === 'descriptive' && hook.program) parts.push(hook.program);
      label = { label: this.label(parts.join(' · ')) };
    }
    const toolUseId = hook.toolUseId
      ? (this.patchFiles.get(hook.toolUseId) ?? hook.toolUseId)
      : undefined;
    if (outcome === 'blocked' && toolUseId) boundedSet(this.hookBlocked, toolUseId, MAX_SEEN);
    this.push(out, {
      kind: 'hook',
      at,
      ...(agentId ? { agentId } : {}),
      hookEvent: hook.hookEvent,
      ...(toolUseId ? { toolUseId } : {}),
      outcome,
      ...(hook.durationMs !== undefined ? { durationMs: hook.durationMs } : {}),
      ...(hook.contentChars !== undefined ? { contextChars: hook.contentChars } : {}),
      ...label,
    } as RecordDraft);

    const commands = this.options.memory?.commands ?? [];
    const program = hook.program;
    if (
      program &&
      (hook.contentChars ?? 0) > 0 &&
      commands.some(
        (name) =>
          program === name ||
          (program.startsWith(name) && /^[-_.]/.test(program.slice(name.length))),
      )
    ) {
      this.push(out, {
        kind: 'memoryPushed',
        at,
        ...(agentId ? { agentId } : {}),
        ...(none ? vocabularyLabel('memory') : { label: this.label(program) }),
        chars: hook.contentChars,
        via: 'hook',
      });
    }
  }

  private onSubagentActivity(
    activity: NonNullable<ReturnType<typeof subagentActivityFromEvent>>,
    at: number,
    parentAgentId: string | undefined,
    out: ActivityRecord[],
  ): void {
    const childKeys = [activity.agentThreadId, activity.agentPath].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    switch (activity.kind) {
      case 'started': {
        const spawnId = activity.callId;
        if (!spawnId) return;
        for (const key of childKeys) bounded(this.aliases, key, spawnId, MAX_ALIASES);
        if (!this.activeAgents.has(spawnId)) {
          this.activeAgents.add(spawnId);
          this.push(out, {
            kind: 'subagentStart',
            at,
            agentId: spawnId,
            spawnId,
            ...(parentAgentId ? { parentAgentId } : {}),
            ...vocabularyLabel('subagent'),
          });
        }
        return;
      }
      case 'interacted': {
        const target = childKeys.map((key) => this.canonicalAgent(key)).find(Boolean);
        if (activity.tool === 'followup_task' && target && !this.activeAgents.has(target)) {
          this.activeAgents.add(target);
          this.push(out, {
            kind: 'subagentStart',
            at,
            agentId: target,
            spawnId: target,
            ...vocabularyLabel('subagent'),
          });
        }
        return;
      }
      case 'completed':
      case 'final-answer':
      case 'interrupted': {
        const target = childKeys
          .map((key) => this.canonicalAgent(key))
          .find((key) => this.activeAgents.has(key));
        if (target)
          this.endAgent(target, at, activity.kind === 'interrupted' ? 'cancelled' : 'ok', out);
        return;
      }
      default:
        return;
    }
  }

  private onCompaction(
    event: SessionEvent,
    at: number,
    agentId: string | undefined,
    out: ActivityRecord[],
  ): void {
    if (agentId !== undefined) return;
    if (this.lastCompactionAt !== undefined && at - this.lastCompactionAt < COMPACTION_DEDUPE_MS) {
      return;
    }
    this.lastCompactionAt = at;
    const compaction = event.compaction;
    this.push(out, {
      kind: 'compaction',
      at,
      ...(compaction
        ? { tokensBefore: compaction.tokensBefore, tokensAfter: compaction.tokensAfter }
        : {}),
      ...(compaction?.trigger ? { trigger: compaction.trigger } : {}),
    });
    // The context starts over from the summary.
    this.lastContextTokens = undefined;
  }

  // ── turns ──

  private closeOpen(
    stream: StreamState,
    at: number,
    agentId: string | undefined,
    outcome: 'unknown' | 'cancelled',
    out: ActivityRecord[],
  ): void {
    for (const [id, call] of [...stream.open]) {
      stream.open.delete(id);
      this.push(out, { kind: 'toolEnd', at, ...(agentId ? { agentId } : {}), id, outcome });
      bounded(this.closed, this.closedKey(agentId, id), { outcome, spawn: call.spawn }, MAX_CLOSED);
      // A foreground subagent cut off with its call ends with it.
      if (call.spawn && outcome === 'cancelled') this.endAgent(id, at, 'cancelled', out);
    }
  }

  private endTurn(at: number, outcome: ActivityTurnOutcome, out: ActivityRecord[]): void {
    if (!this.working) return;
    this.working = false;
    const main = this.streams.get('');
    if (main) {
      // A background agent's spawn call keeps its own lifetime; others end with the turn.
      for (const [id, call] of [...main.open]) {
        if (call.spawn && this.activeAgents.has(id) && outcome === 'done') continue;
        main.open.delete(id);
        const callOutcome: ActivityOutcome = outcome === 'aborted' ? 'cancelled' : 'unknown';
        this.push(out, { kind: 'toolEnd', at, id, outcome: callOutcome });
        bounded(
          this.closed,
          this.closedKey(undefined, id),
          { outcome: callOutcome, spawn: call.spawn },
          MAX_CLOSED,
        );
        if (call.spawn && outcome === 'aborted') this.endAgent(id, at, 'cancelled', out);
      }
    }
    this.push(out, { kind: 'turnEnd', at, outcome });
  }

  private afterMainEvent(event: SessionEvent, at: number, out: ActivityRecord[]): void {
    this.tracker.observe(event);
    const current = this.tracker.current({
      now: at,
      processRunning: true,
      idleAfterMs: Number.POSITIVE_INFINITY,
      staleAfterMs: Number.POSITIVE_INFINITY,
    });
    if (current.state === 'working') {
      this.working = true;
      return;
    }
    if (current.state !== 'waiting' || !this.working) return;
    const outcome = turnOutcomeOf(current.reason);
    if (outcome) this.endTurn(at, outcome, out);
  }
}

/** A recorder for one session (see the module docs). */
export function createActivityRecorder(options: ActivityRecorderOptions): ActivityRecorder {
  return new Recorder(options);
}
