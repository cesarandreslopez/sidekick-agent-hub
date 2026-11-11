/**
 * The activity reducer: one state, folded record by record, for live
 * updates, replay and scrubbing alike.
 *
 * The state holds full-session totals (calls, errors, busy time, context
 * weight, label counts, transitions, patterns) next to the bounded drawing
 * view (the newest entries, the open calls, the route). It is plain JSON:
 * clone it to scrub, persist it with `JSON.stringify`.
 *
 * Patterns:
 * - **retry streak**: failed main-loop calls at one station with no success
 *   there in between (calls at other stations, such as the edits between two
 *   failing test runs, do not break it; a failure at another station starts
 *   a new one). It opens at `retryStreakMin` failures; the next success at
 *   its station marks it `recovered`, the end of the turn `abandoned`.
 * - **alternation**: the main loop's last stops strictly alternate between
 *   two stations for `alternationMinCycles` cycles (A, B, A, B, A, B). With
 *   files and shell, an edit and a test among them, its flavor is
 *   `edit-test`.
 *
 * Pure and deterministic.
 *
 * @module activity/state
 */

import type { SessionProviderId } from '../providerIds';
import { ACTIVITY_STATIONS, type ActivityStationId } from './stations';
import { DEFAULT_ACTIVITY_STRINGS, type ActivityLabelKey } from './strings';
import type {
  ActivityEntry,
  ActivityHint,
  ActivityOutcome,
  ActivityPattern,
  ActivityRecord,
  ActivitySlowCall,
  ActivitySnapshot,
  ActivityState,
  ActivityStateOptions,
  ActivityTurnOutcome,
} from './types';

// ── Internal shape ───────────────────────────────────────────────────────

export const HISTOGRAM_BUCKETS = 16;
const LABEL_SLOTS = 32;
const ROUTE_MEMORY = 32;
const MAX_PATTERNS = 64;
const MAX_RUNNING_SHOWN = 64;
const MAX_SWITCHES = 64;
const SNAPSHOT_PATTERNS = 8;

export interface ResolvedStateOptions {
  ringSize: number;
  routeStops: number;
  maxAgents: number;
  hookMinMs: number;
  retryStreakMin: number;
  alternationMinCycles: number;
}

export interface StationAccumulator {
  count: number;
  running: number;
  faults: number;
  lastAt?: number;
  lastFaultAt?: number;
  pushed: number;
  calls: number;
  errors: number;
  denials: number;
  cancelled: number;
  busyMs: number;
  busyOpen: number;
  busySince?: number;
  callMs: number;
  timed: number;
  histogram: number[];
  resultChars: number;
  /** Space-saving counter: `[label, count]`, at most 32 slots. */
  labels: Array<[string, number]>;
}

export interface RunningCall {
  /** Index into nothing: a copy of the drawn entry while it runs. */
  entry: ActivityEntry;
  /** Whether the main loop made the call. */
  main: boolean;
}

export interface RouteMemoryStop {
  station: ActivityStationId;
  at: number;
  hints: ActivityHint[];
}

export interface InternalActivityState extends ActivityState {
  options: ResolvedStateOptions;
  providerId?: SessionProviderId;
  sessionId?: string;
  startedAt?: number;
  at: number;
  stations: Record<ActivityStationId, StationAccumulator>;
  entries: ActivityEntry[];
  running: Record<string, RunningCall>;
  agents: Record<string, { label: string; startedAt: number }>;
  agentsSeen: string[];
  route: RouteMemoryStop[];
  lastMainStation?: ActivityStationId;
  transitions: number[][];
  model?: { id: string; steps: number; switchedAt?: number; previous?: string };
  models: Record<string, { steps: number; firstAt: number; lastAt: number }>;
  switches: number[];
  context?: ActivitySnapshot['context'];
  compactions: number;
  lastCompactionAt?: number;
  turn: {
    working: boolean;
    since?: number;
    lastPromptAt?: number;
    lastEnd?: { at: number; outcome: ActivityTurnOutcome };
    lastMainActivityAt?: number;
  };
  streak?: { station: ActivityStationId; failures: number; startAt: number; endAt: number };
  patterns: ActivityPattern[];
  globalBusy: { open: number; since?: number; busyMs: number };
  totals: {
    prompts: number;
    turns: number;
    steps: number;
    calls: number;
    errors: number;
    denials: number;
    cancelled: number;
    asks: number;
    resultChars: number;
    hookRuns: number;
    hookMs: number;
    pushed: number;
    subagents: number;
  };
  slowest: ActivitySlowCall[];
}

function resolveOptions(options: ActivityStateOptions | undefined): ResolvedStateOptions {
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return {
    ringSize: positive(options?.ringSize, 80),
    routeStops: positive(options?.routeStops, 7),
    maxAgents: positive(options?.maxAgents, 12),
    hookMinMs:
      typeof options?.hookMinMs === 'number' && options.hookMinMs >= 0 ? options.hookMinMs : 400,
    retryStreakMin: Math.max(2, positive(options?.retryStreakMin, 3)),
    alternationMinCycles: Math.max(2, positive(options?.alternationMinCycles, 3)),
  };
}

function emptyStation(): StationAccumulator {
  return {
    count: 0,
    running: 0,
    faults: 0,
    pushed: 0,
    calls: 0,
    errors: 0,
    denials: 0,
    cancelled: 0,
    busyMs: 0,
    busyOpen: 0,
    callMs: 0,
    timed: 0,
    histogram: new Array<number>(HISTOGRAM_BUCKETS).fill(0),
    resultChars: 0,
    labels: [],
  };
}

const STATION_INDEX = new Map<ActivityStationId, number>(
  ACTIVITY_STATIONS.map((id, index) => [id, index]),
);

function internal(state: ActivityState): InternalActivityState {
  return state as InternalActivityState;
}

// ── Public API ───────────────────────────────────────────────────────────

export function createActivityState(
  meta?: { providerId?: SessionProviderId; sessionId?: string },
  options?: ActivityStateOptions,
): ActivityState {
  const stations = {} as Record<ActivityStationId, StationAccumulator>;
  for (const id of ACTIVITY_STATIONS) stations[id] = emptyStation();
  const state: InternalActivityState = {
    kind: 'sidekick-activity-state',
    schemaVersion: 1,
    options: resolveOptions(options),
    ...(meta?.providerId ? { providerId: meta.providerId } : {}),
    ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
    at: 0,
    stations,
    entries: [],
    running: {},
    agents: {},
    agentsSeen: [],
    route: [],
    transitions: ACTIVITY_STATIONS.map(() => new Array<number>(ACTIVITY_STATIONS.length).fill(0)),
    models: {},
    switches: [],
    compactions: 0,
    turn: { working: false },
    patterns: [],
    globalBusy: { open: 0, busyMs: 0 },
    totals: {
      prompts: 0,
      turns: 0,
      steps: 0,
      calls: 0,
      errors: 0,
      denials: 0,
      cancelled: 0,
      asks: 0,
      resultChars: 0,
      hookRuns: 0,
      hookMs: 0,
      pushed: 0,
      subagents: 0,
    },
    slowest: [],
  };
  return state;
}

/** Folds one record into `state` (mutates it). */
export function applyActivityRecord(state: ActivityState, record: ActivityRecord): void {
  const s = internal(state);
  if (!record || typeof record !== 'object') return;
  const at = Number.isFinite(record.at) ? record.at : s.at;
  if (at > s.at) s.at = at;
  switch (record.kind) {
    case 'session':
      s.providerId = record.providerId;
      if (record.sessionId) s.sessionId = record.sessionId;
      if (s.startedAt === undefined) s.startedAt = at;
      return;
    case 'prompt':
      onPrompt(s, at);
      return;
    case 'step':
      onStep(s, record, at);
      return;
    case 'toolStart':
      onToolStart(s, record, at);
      return;
    case 'toolEnd':
      onToolEnd(s, record, at);
      return;
    case 'hook':
      onHook(s, record, at);
      return;
    case 'memoryPushed':
      s.totals.pushed++;
      bump(s, 'memory', at);
      s.stations.memory.pushed++;
      pushEntry(s, {
        key: `pushed-${record.seq}`,
        station: 'memory',
        label: record.label,
        ...(record.labelKey ? { labelKey: record.labelKey } : {}),
        from: 'inbound',
        startedAt: at,
        endedAt: at,
        outcome: 'ok',
        mark: 'pushed',
      });
      touchStart(s, at);
      return;
    case 'inbound':
      bump(s, record.station, at);
      pushEntry(s, {
        key: `inbound-${record.seq}`,
        station: record.station,
        label: record.label,
        ...(record.labelKey ? { labelKey: record.labelKey } : {}),
        from: 'inbound',
        startedAt: at,
        endedAt: at,
        outcome: 'ok',
        mark: 'notification',
      });
      touchStart(s, at);
      return;
    case 'context':
      s.context = {
        percent: Math.max(0, Math.min(100, record.percent)),
        ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
        ...(record.window !== undefined ? { window: record.window } : {}),
        at,
        source: record.source,
      };
      return;
    case 'compaction':
      onCompaction(s, record, at);
      return;
    case 'subagentStart':
      if (!s.agents[record.agentId]) {
        s.agents[record.agentId] = { label: record.label, startedAt: at };
        if (!s.agentsSeen.includes(record.agentId)) {
          s.agentsSeen.push(record.agentId);
          if (s.agentsSeen.length > 256) s.agentsSeen.shift();
          s.totals.subagents++;
        }
      }
      return;
    case 'subagentEnd':
      delete s.agents[record.agentId];
      return;
    case 'turnEnd':
      onTurnEnd(s, record.outcome, record.seq, at);
      return;
    default:
      return;
  }
}

export function applyActivityRecords(
  state: ActivityState,
  records: readonly ActivityRecord[],
): void {
  for (const record of records) applyActivityRecord(state, record);
}

export function cloneActivityState(state: ActivityState): ActivityState {
  return JSON.parse(JSON.stringify(state)) as ActivityState;
}

/** Restores a state persisted with `JSON.stringify`; null when unusable. */
export function restoreActivityState(value: unknown): ActivityState | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'sidekick-activity-state' || raw.schemaVersion !== 1) return null;
  const stations = raw.stations as Record<string, unknown> | undefined;
  if (!stations || typeof stations !== 'object') return null;
  for (const id of ACTIVITY_STATIONS) {
    const station = stations[id] as Record<string, unknown> | undefined;
    if (
      !station ||
      typeof station.count !== 'number' ||
      !Array.isArray(station.histogram) ||
      station.histogram.length !== HISTOGRAM_BUCKETS ||
      !Array.isArray(station.labels)
    ) {
      return null;
    }
  }
  if (
    !Array.isArray(raw.entries) ||
    typeof raw.running !== 'object' ||
    raw.running === null ||
    typeof raw.agents !== 'object' ||
    raw.agents === null ||
    !Array.isArray(raw.agentsSeen) ||
    !Array.isArray(raw.route) ||
    !Array.isArray(raw.transitions) ||
    raw.transitions.length !== ACTIVITY_STATIONS.length ||
    !Array.isArray(raw.switches) ||
    !Array.isArray(raw.patterns) ||
    !Array.isArray(raw.slowest) ||
    typeof raw.at !== 'number' ||
    typeof raw.turn !== 'object' ||
    typeof raw.totals !== 'object' ||
    typeof raw.globalBusy !== 'object' ||
    typeof raw.options !== 'object'
  ) {
    return null;
  }
  const state = cloneActivityState(value as ActivityState) as InternalActivityState;
  state.options = resolveOptions(state.options);
  return state;
}

export function snapshotActivity(state: ActivityState): ActivitySnapshot {
  const s = internal(state);
  const running = Object.values(s.running);
  const runningSince = new Map<ActivityStationId, number>();
  for (const call of running) {
    const previous = runningSince.get(call.entry.station);
    if (previous === undefined || call.entry.startedAt < previous) {
      runningSince.set(call.entry.station, call.entry.startedAt);
    }
  }
  const stations = ACTIVITY_STATIONS.map((id) => {
    const station = s.stations[id];
    const since = runningSince.get(id);
    return {
      id,
      count: station.count,
      running: Math.max(0, station.running),
      ...(since !== undefined ? { runningSince: since } : {}),
      faults: station.faults,
      ...(station.lastAt !== undefined ? { lastAt: station.lastAt } : {}),
      ...(station.lastFaultAt !== undefined ? { lastFaultAt: station.lastFaultAt } : {}),
      ...(id === 'memory' ? { pushed: station.pushed } : {}),
    };
  });
  const mainRunning = running.some((call) => call.main);
  const lastMain = s.turn.lastMainActivityAt;
  const agents = Object.entries(s.agents)
    .map(([agentId, agent]) => ({ agentId, label: agent.label, startedAt: agent.startedAt }))
    .slice(-s.options.maxAgents);
  const route = collapseRoute(s.route).slice(-s.options.routeStops);
  return {
    schemaVersion: 1,
    ...(s.providerId ? { providerId: s.providerId } : {}),
    ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    at: s.at,
    ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
    stations,
    entries: s.entries.map((entry) => ({ ...entry })),
    running: running
      .map((call) => ({ ...call.entry }))
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-MAX_RUNNING_SHOWN),
    agents,
    route,
    ...(s.model ? { model: { ...s.model } } : {}),
    ...(s.context ? { context: { ...s.context } } : {}),
    compactions: s.compactions,
    ...(s.lastCompactionAt !== undefined ? { lastCompactionAt: s.lastCompactionAt } : {}),
    turn: {
      working: s.turn.working,
      ...(s.turn.since !== undefined ? { since: s.turn.since } : {}),
      ...(s.turn.working && !mainRunning && lastMain !== undefined
        ? { thinkingSince: lastMain }
        : {}),
      ...(s.turn.lastPromptAt !== undefined ? { lastPromptAt: s.turn.lastPromptAt } : {}),
      ...(s.turn.lastEnd ? { lastEnd: { ...s.turn.lastEnd } } : {}),
    },
    patterns: s.patterns.slice(-SNAPSHOT_PATTERNS).map(copyPattern),
    totals: {
      prompts: s.totals.prompts,
      calls: s.totals.calls,
      errors: s.totals.errors,
      denials: s.totals.denials,
      steps: s.totals.steps,
      pushed: s.totals.pushed,
    },
  };
}

// ── Reducer helpers ──────────────────────────────────────────────────────

export function copyPattern(pattern: ActivityPattern): ActivityPattern {
  return pattern.kind === 'alternation'
    ? { ...pattern, stations: [pattern.stations[0], pattern.stations[1]] }
    : { ...pattern };
}

function vocabulary(key: ActivityLabelKey): { label: string; labelKey: ActivityLabelKey } {
  return { label: DEFAULT_ACTIVITY_STRINGS.labels[key], labelKey: key };
}

function bump(s: InternalActivityState, station: ActivityStationId, at: number): void {
  const acc = s.stations[station];
  acc.count++;
  acc.lastAt = at;
}

function touchStart(s: InternalActivityState, at: number): void {
  if (s.startedAt === undefined) s.startedAt = at;
}

function pushEntry(s: InternalActivityState, entry: ActivityEntry): void {
  s.entries.push(entry);
  const overflow = s.entries.length - s.options.ringSize;
  if (overflow > 0) s.entries.splice(0, overflow);
}

function findEntry(s: InternalActivityState, key: string): ActivityEntry | undefined {
  for (let index = s.entries.length - 1; index >= 0; index--) {
    if (s.entries[index].key === key) return s.entries[index];
  }
  return undefined;
}

function callKey(agentId: string | undefined, id: string): string {
  return agentId ? `${agentId}/${id}` : id;
}

function fault(s: InternalActivityState, station: ActivityStationId, at: number): void {
  if (station === 'you') return;
  const acc = s.stations[station];
  acc.faults++;
  acc.lastFaultAt = at;
}

function onPrompt(s: InternalActivityState, at: number): void {
  s.totals.prompts++;
  for (const id of ACTIVITY_STATIONS) s.stations[id].faults = 0;
  bump(s, 'you', at);
  pushEntry(s, {
    key: `prompt-${at}-${s.totals.prompts}`,
    station: 'you',
    ...vocabulary('newMessage'),
    from: 'inbound',
    startedAt: at,
    endedAt: at,
    outcome: 'ok',
    mark: 'prompt',
  });
  s.turn.working = true;
  s.turn.since = at;
  s.turn.lastPromptAt = at;
  s.turn.lastMainActivityAt = at;
  endStreak(s, 'abandoned');
  touchStart(s, at);
}

function onTurnEnd(
  s: InternalActivityState,
  outcome: ActivityTurnOutcome,
  seq: number,
  at: number,
): void {
  s.turn.working = false;
  s.turn.lastEnd = { at, outcome };
  s.totals.turns++;
  endStreak(s, 'abandoned', at);
  pushEntry(s, {
    key: `turn-${seq}`,
    station: 'you',
    ...vocabulary(
      outcome === 'done' ? 'answerReady' : outcome === 'aborted' ? 'turnInterrupted' : 'turnFailed',
    ),
    from: 'core',
    startedAt: at,
    endedAt: at,
    outcome: outcome === 'done' ? 'ok' : outcome === 'aborted' ? 'cancelled' : 'error',
    mark: outcome === 'done' ? 'done' : 'aborted',
  });
}

function onStep(
  s: InternalActivityState,
  record: Extract<ActivityRecord, { kind: 'step' }>,
  at: number,
): void {
  s.totals.steps++;
  const model = record.model;
  const main = record.agentId === undefined;
  if (model) {
    const known = s.models[model];
    if (known) {
      known.steps++;
      known.lastAt = at;
    } else {
      s.models[model] = { steps: 1, firstAt: at, lastAt: at };
    }
  }
  if (main && model) {
    if (s.model && s.model.id !== model) {
      const previous = s.model.id;
      s.model = { id: model, steps: 1, switchedAt: at, previous };
      s.switches.push(at);
      if (s.switches.length > MAX_SWITCHES) s.switches.shift();
      pushEntry(s, {
        key: `switch-${record.seq}`,
        station: 'model',
        label: `${previous} → ${model}`,
        labelKey: 'modelSwitch',
        from: 'core',
        startedAt: at,
        endedAt: at,
        outcome: 'ok',
        mark: 'switch',
      });
    } else if (s.model) {
      s.model.steps++;
    } else {
      s.model = { id: model, steps: 1 };
    }
  }
  bump(s, 'model', at);
  const startedAt =
    typeof record.startedAt === 'number' && record.startedAt <= at ? record.startedAt : at;
  pushEntry(s, {
    key: `step-${record.seq}`,
    station: 'model',
    label: model ?? DEFAULT_ACTIVITY_STRINGS.labels.modelStep,
    labelKey: 'modelStep',
    from: main ? 'core' : 'agents',
    ...(record.agentId ? { agentId: record.agentId } : {}),
    startedAt,
    endedAt: at,
    outcome: 'ok',
  });
  if (main) s.turn.lastMainActivityAt = at;
  touchStart(s, at);
}

function onToolStart(
  s: InternalActivityState,
  record: Extract<ActivityRecord, { kind: 'toolStart' }>,
  at: number,
): void {
  const key = callKey(record.agentId, record.id);
  if (s.running[key]) return;
  const main = record.agentId === undefined;
  const station = record.station;
  const acc = s.stations[station];
  bump(s, station, at);
  acc.calls++;
  acc.running++;
  if (acc.busyOpen === 0) acc.busySince = at;
  acc.busyOpen++;
  if (s.globalBusy.open === 0) s.globalBusy.since = at;
  s.globalBusy.open++;
  s.totals.calls++;
  countLabel(acc, record.label);

  const entry: ActivityEntry = {
    key,
    station,
    label: record.label,
    ...(record.labelKey ? { labelKey: record.labelKey } : {}),
    from: main ? 'core' : 'agents',
    ...(record.agentId ? { agentId: record.agentId } : {}),
    startedAt: at,
    ...(record.fold && record.fold > 1 ? { fold: record.fold } : {}),
    ...(record.hint ? { hint: record.hint } : {}),
    tool: record.tool,
  };
  pushEntry(s, entry);
  s.running[key] = { entry: { ...entry }, main };

  if (main) {
    s.turn.lastMainActivityAt = at;
    if (!s.turn.working) {
      // Work without a recorded prompt (a resumed or headless session) is a turn too.
      s.turn.working = true;
      s.turn.since = at;
    }
    if (station !== 'model' && station !== 'hooks') onRouteStop(s, station, at, record.hint);
  }
  touchStart(s, at);
}

function onToolEnd(
  s: InternalActivityState,
  record: Extract<ActivityRecord, { kind: 'toolEnd' }>,
  at: number,
): void {
  const key = callKey(record.agentId, record.id);
  const running = s.running[key];
  if (!running) {
    upgradeToDenied(s, key, record, at);
    return;
  }
  delete s.running[key];
  const main = running.main;
  const station = running.entry.station;
  const acc = s.stations[station];
  let startedAt = running.entry.startedAt;
  if (typeof record.startedAt === 'number' && record.startedAt < startedAt) {
    startedAt = record.startedAt;
  }
  const duration =
    typeof record.durationMs === 'number' && record.durationMs >= 0
      ? record.durationMs
      : Math.max(0, at - startedAt);

  acc.running = Math.max(0, acc.running - 1);
  acc.busyOpen = Math.max(0, acc.busyOpen - 1);
  if (acc.busyOpen === 0 && acc.busySince !== undefined) {
    acc.busyMs += Math.max(0, at - Math.min(acc.busySince, startedAt));
    delete acc.busySince;
  }
  s.globalBusy.open = Math.max(0, s.globalBusy.open - 1);
  if (s.globalBusy.open === 0 && s.globalBusy.since !== undefined) {
    s.globalBusy.busyMs += Math.max(0, at - Math.min(s.globalBusy.since, startedAt));
    delete s.globalBusy.since;
  }
  if (record.outcome !== 'unknown') {
    acc.callMs += duration;
    acc.timed++;
    acc.histogram[bucketOf(duration)]++;
    recordSlow(s, { station, label: running.entry.label, durationMs: duration, at });
  }
  if (typeof record.resultChars === 'number' && record.resultChars > 0) {
    acc.resultChars += record.resultChars;
    s.totals.resultChars += record.resultChars;
  }
  if (record.asked) s.totals.asks++;
  applyOutcome(s, station, record.outcome, at);

  const entry = findEntry(s, key);
  const patch = {
    startedAt,
    endedAt: at,
    outcome: record.outcome,
    ...(record.deniedBy ? { deniedBy: record.deniedBy } : {}),
  };
  if (entry) Object.assign(entry, patch);
  lastActivity(s, main, at);

  if (main && station !== 'model' && station !== 'hooks') {
    onStreakOutcome(s, station, record.outcome, at);
  }
}

function applyOutcome(
  s: InternalActivityState,
  station: ActivityStationId,
  outcome: ActivityOutcome,
  at: number,
): void {
  const acc = s.stations[station];
  if (outcome === 'error') {
    acc.errors++;
    s.totals.errors++;
    fault(s, station, at);
  } else if (outcome === 'denied') {
    acc.denials++;
    s.totals.denials++;
    fault(s, station, at);
  } else if (outcome === 'cancelled') {
    acc.cancelled++;
    s.totals.cancelled++;
  }
}

/** A later result refused a call that had already ended: count it as denied instead. */
function upgradeToDenied(
  s: InternalActivityState,
  key: string,
  record: Extract<ActivityRecord, { kind: 'toolEnd' }>,
  at: number,
): void {
  if (record.outcome !== 'denied') return;
  const entry = findEntry(s, key);
  if (!entry || entry.outcome === 'denied' || entry.endedAt === undefined) return;
  const acc = s.stations[entry.station];
  if (entry.outcome === 'error') {
    acc.errors = Math.max(0, acc.errors - 1);
    s.totals.errors = Math.max(0, s.totals.errors - 1);
    acc.denials++;
    s.totals.denials++;
  } else {
    if (entry.outcome === 'cancelled') {
      acc.cancelled = Math.max(0, acc.cancelled - 1);
      s.totals.cancelled = Math.max(0, s.totals.cancelled - 1);
    }
    applyOutcome(s, entry.station, 'denied', at);
  }
  entry.outcome = 'denied';
  if (record.deniedBy) entry.deniedBy = record.deniedBy;
}

function lastActivity(s: InternalActivityState, main: boolean, at: number): void {
  if (main) s.turn.lastMainActivityAt = at;
}

function onHook(
  s: InternalActivityState,
  record: Extract<ActivityRecord, { kind: 'hook' }>,
  at: number,
): void {
  s.totals.hookRuns++;
  const duration =
    typeof record.durationMs === 'number' && record.durationMs > 0 ? record.durationMs : 0;
  s.totals.hookMs += duration;
  const notable =
    record.outcome !== 'ok' || (record.contextChars ?? 0) > 0 || duration >= s.options.hookMinMs;
  if (!notable) return;
  const acc = s.stations.hooks;
  bump(s, 'hooks', at);
  acc.calls++;
  countLabel(acc, record.label);
  if (duration > 0) {
    acc.callMs += duration;
    acc.timed++;
    acc.histogram[bucketOf(duration)]++;
    acc.busyMs += duration;
  }
  const outcome: ActivityOutcome =
    record.outcome === 'blocked' ? 'denied' : record.outcome === 'error' ? 'error' : 'ok';
  if (outcome === 'denied') {
    acc.denials++;
    fault(s, 'hooks', at);
  } else if (outcome === 'error') {
    acc.errors++;
    fault(s, 'hooks', at);
  }
  pushEntry(s, {
    key: `hook-${record.seq}`,
    station: 'hooks',
    label: record.label,
    ...(record.labelKey ? { labelKey: record.labelKey } : {}),
    from: record.agentId ? 'agents' : 'core',
    ...(record.agentId ? { agentId: record.agentId } : {}),
    startedAt: Math.max(s.startedAt ?? at - duration, at - duration),
    endedAt: at,
    outcome,
    ...(outcome === 'denied' ? { deniedBy: 'hook' as const } : {}),
    ...(record.outcome === 'context' ? { mark: 'pushed' as const } : {}),
  });
  touchStart(s, at);
}

function onCompaction(
  s: InternalActivityState,
  record: Extract<ActivityRecord, { kind: 'compaction' }>,
  at: number,
): void {
  s.compactions++;
  s.lastCompactionAt = at;
  pushEntry(s, {
    key: `compaction-${record.seq}`,
    station: 'model',
    ...vocabulary('compacting'),
    from: 'core',
    startedAt: at,
    endedAt: at,
    outcome: 'ok',
    mark: 'compaction',
  });
  const window = s.context?.window;
  if (typeof record.tokensAfter === 'number' && window && window > 0) {
    s.context = {
      percent: Math.max(0, Math.min(100, (record.tokensAfter / window) * 100)),
      tokens: record.tokensAfter,
      window,
      at,
      source: s.context?.source ?? 'usage',
    };
  }
}

// ── Statistics ───────────────────────────────────────────────────────────

/** Log₂ bucket of a duration: 0 for < 2 ms … 15 for ≥ 32 s. */
export function bucketOf(ms: number): number {
  const value = Math.max(0, ms) + 1;
  return Math.min(HISTOGRAM_BUCKETS - 1, Math.floor(Math.log2(value)));
}

/** Upper bound (ms) of a histogram bucket. */
export function bucketUpperMs(bucket: number): number {
  return 2 ** (bucket + 1) - 1;
}

function countLabel(acc: StationAccumulator, label: string): void {
  if (!label) return;
  const found = acc.labels.find((slot) => slot[0] === label);
  if (found) {
    found[1]++;
    return;
  }
  if (acc.labels.length < LABEL_SLOTS) {
    acc.labels.push([label, 1]);
    return;
  }
  // Space-saving: the smallest slot gives its place to the new label.
  let min = 0;
  for (let index = 1; index < acc.labels.length; index++) {
    if (acc.labels[index][1] < acc.labels[min][1]) min = index;
  }
  acc.labels[min] = [label, acc.labels[min][1] + 1];
}

function recordSlow(s: InternalActivityState, call: ActivitySlowCall): void {
  if (call.durationMs <= 0) return;
  s.slowest.push(call);
  s.slowest.sort((a, b) => b.durationMs - a.durationMs || a.at - b.at);
  if (s.slowest.length > 5) s.slowest.length = 5;
}

// ── Route, transitions and patterns ──────────────────────────────────────

function collapseRoute(
  route: readonly RouteMemoryStop[],
): Array<{ station: ActivityStationId; at: number }> {
  return route.map((stop) => ({ station: stop.station, at: stop.at }));
}

function onRouteStop(
  s: InternalActivityState,
  station: ActivityStationId,
  at: number,
  hint: ActivityHint | undefined,
): void {
  const from = s.lastMainStation;
  if (from !== undefined) {
    const row = STATION_INDEX.get(from);
    const column = STATION_INDEX.get(station);
    if (row !== undefined && column !== undefined) s.transitions[row][column]++;
  }
  s.lastMainStation = station;

  const last = s.route[s.route.length - 1];
  if (last && last.station === station) {
    last.at = at;
    if (hint && !last.hints.includes(hint)) last.hints.push(hint);
    return;
  }
  s.route.push({ station, at, hints: hint ? [hint] : [] });
  if (s.route.length > ROUTE_MEMORY) s.route.shift();
  detectAlternation(s, at);
}

function addPattern(s: InternalActivityState, pattern: ActivityPattern): void {
  s.patterns.push(pattern);
  if (s.patterns.length > MAX_PATTERNS) s.patterns.shift();
}

/** The open retry-streak pattern for the current streak, if it opened. */
function streakPattern(
  s: InternalActivityState,
): Extract<ActivityPattern, { kind: 'retry-streak' }> | undefined {
  const streak = s.streak;
  if (!streak) return undefined;
  for (let index = s.patterns.length - 1; index >= 0; index--) {
    const pattern = s.patterns[index];
    if (
      pattern.kind === 'retry-streak' &&
      pattern.state === 'open' &&
      pattern.station === streak.station &&
      pattern.startAt === streak.startAt
    ) {
      return pattern;
    }
  }
  return undefined;
}

function openAlternation(
  s: InternalActivityState,
): Extract<ActivityPattern, { kind: 'alternation' }> | undefined {
  for (let index = s.patterns.length - 1; index >= 0; index--) {
    const pattern = s.patterns[index];
    if (pattern.kind === 'alternation' && pattern.state === 'open') return pattern;
  }
  return undefined;
}

function detectAlternation(s: InternalActivityState, at: number): void {
  const route = s.route;
  const n = route.length;
  const open = openAlternation(s);
  if (n < 2) return;
  const a = route[n - 1].station;
  const b = route[n - 2].station;
  let length = 2;
  while (length < n && route[n - 1 - length].station === (length % 2 === 0 ? a : b)) length++;
  const cycles = Math.floor(length / 2);
  const pair = [b, a].sort() as [ActivityStationId, ActivityStationId];
  if (open && !(open.stations.includes(a) && open.stations.includes(b) && cycles >= 2)) {
    open.state = 'closed';
  }
  if (cycles < s.options.alternationMinCycles) return;
  const stops = route.slice(n - length);
  const flavor =
    pair[0] === 'files' &&
    pair[1] === 'shell' &&
    stops.some((stop) => stop.station === 'files' && stop.hints.includes('edit')) &&
    stops.some((stop) => stop.station === 'shell' && stop.hints.includes('test'))
      ? ('edit-test' as const)
      : undefined;
  const current = openAlternation(s);
  if (current && current.stations[0] === pair[0] && current.stations[1] === pair[1]) {
    current.cycles = cycles;
    current.endAt = at;
    if (flavor) current.flavor = flavor;
    return;
  }
  addPattern(s, {
    kind: 'alternation',
    stations: pair,
    cycles,
    startAt: stops[0].at,
    endAt: at,
    state: 'open',
    ...(flavor ? { flavor } : {}),
  });
}

function onStreakOutcome(
  s: InternalActivityState,
  station: ActivityStationId,
  outcome: ActivityOutcome,
  at: number,
): void {
  if (outcome === 'error' || outcome === 'denied') {
    if (s.streak && s.streak.station === station) {
      s.streak.failures++;
      s.streak.endAt = at;
    } else {
      endStreak(s, 'abandoned');
      s.streak = { station, failures: 1, startAt: at, endAt: at };
    }
    const streak = s.streak;
    if (streak.failures >= s.options.retryStreakMin) {
      const existing = streakPattern(s);
      if (existing) {
        existing.failures = streak.failures;
        existing.endAt = at;
      } else {
        addPattern(s, {
          kind: 'retry-streak',
          station,
          failures: streak.failures,
          startAt: streak.startAt,
          endAt: at,
          state: 'open',
        });
      }
    }
    return;
  }
  if (outcome === 'ok' && s.streak && s.streak.station === station) {
    endStreak(s, 'recovered', at);
  }
}

function endStreak(s: InternalActivityState, state: 'recovered' | 'abandoned', at?: number): void {
  if (!s.streak) return;
  const pattern = streakPattern(s);
  if (pattern) {
    pattern.state = state;
    if (at !== undefined) pattern.endAt = at;
  }
  delete s.streak;
}
