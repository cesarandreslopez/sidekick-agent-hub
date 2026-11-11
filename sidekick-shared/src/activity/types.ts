/**
 * Public types of the activity map.
 *
 * The map is built in three layers, all pure and deterministic:
 *
 * 1. **Records** ({@link ActivityRecord}) — a small, append-only, already
 *    classified vocabulary produced from canonical session events by an
 *    {@link ActivityRecorder}. Records are content-free by construction:
 *    labels carry names (a file's last two path parts, a host, a program),
 *    never what was written, read, searched, fetched or prompted. They are
 *    JSON-serializable and are the wire format.
 * 2. **State** ({@link ActivityState}) — one reducer folds records, live or
 *    replayed, into full-session totals plus the bounded view below.
 * 3. **Views** — {@link ActivitySnapshot} (what a renderer draws at a moment)
 *    and {@link ActivityInsights} (full-session statistics and patterns).
 *
 * Every timestamp is epoch milliseconds. Nothing here reads a clock: callers
 * pass `now` / `at` explicitly, so the same input always renders the same
 * output.
 *
 * Types only.
 *
 * @module activity/types
 */

import type { SessionProviderId } from '../providerIds';
import type { SessionEvent } from '../types/sessionEvent';
import type { ActivityStationId } from './stations';
import type { ActivityLabelKey, ActivityStrings } from './strings';

export type { ActivityStationId } from './stations';
export type { ActivityLabelKey, ActivityStrings } from './strings';

// ── Vocabulary ───────────────────────────────────────────────────────────

export type ActivityOutcome = 'ok' | 'error' | 'denied' | 'cancelled' | 'unknown';
export type ActivityDeniedBy = 'user' | 'hook' | 'policy';
/** What a call did, when the classifier can tell from its name alone. */
export type ActivityHint =
  | 'read'
  | 'edit'
  | 'search'
  | 'test'
  | 'build'
  | 'lint'
  | 'install'
  | 'vcs'
  | 'remote';
/**
 * How much a label may say.
 * - `names` (default): file, host, program and identifier names only.
 * - `descriptive`: also the short description the model wrote for a shell
 *   command or subagent (cleaned, at most 60 characters). Model-written prose
 *   can echo content, so this is for local display, not for the wire.
 * - `none`: the fixed vocabulary only; even MCP server names are hidden.
 */
export type ActivityLabelMode = 'names' | 'descriptive' | 'none';
/** Where a pulse starts: the core, the agents station, or the station itself. */
export type ActivityOrigin = 'core' | 'agents' | 'inbound';
export type ActivityHookOutcome = 'ok' | 'error' | 'blocked' | 'context';
export type ActivityTurnOutcome = 'done' | 'aborted' | 'error';
export type ActivityMemoryVia = 'attachment' | 'hook' | 'instructions';
export type ActivityContextSource = 'usage' | 'host';

// ── Records ──────────────────────────────────────────────────────────────

export interface ActivityRecordBase {
  /** Position in the recorder's output, from 0, without gaps. */
  seq: number;
  /** Event time, epoch ms. */
  at: number;
  /** The subagent whose stream produced the record; absent for the main loop. */
  agentId?: string;
}

export interface ActivitySessionRecord extends ActivityRecordBase {
  kind: 'session';
  providerId: SessionProviderId;
  sessionId?: string;
}

/** A human prompt in the main loop. */
export interface ActivityPromptRecord extends ActivityRecordBase {
  kind: 'prompt';
}

/** One model request finished (one assistant message, or a Codex token count). */
export interface ActivityStepRecord extends ActivityRecordBase {
  kind: 'step';
  model?: string;
  /** When the request is estimated to have started (end of the previous activity). */
  startedAt?: number;
}

export interface ActivityToolStartRecord extends ActivityRecordBase {
  kind: 'toolStart';
  /** Tool-call id, unique within its stream. */
  id: string;
  station: ActivityStationId;
  label: string;
  /** Set when `label` is a vocabulary word, so renderers can translate it. */
  labelKey?: ActivityLabelKey;
  /** Canonical tool name, as the parser emitted it (`Bash`, `Edit`, `mcp__x__y`). */
  tool: string;
  hint?: ActivityHint;
  /** Calls folded into this one (a multi-file patch); absent means 1. */
  fold?: number;
  /** A call the log records as already done; a `toolEnd` follows at the same time. */
  instant?: true;
  /** The call starts a subagent; a `subagentStart` follows. */
  spawn?: true;
}

export interface ActivityToolEndRecord extends ActivityRecordBase {
  kind: 'toolEnd';
  id: string;
  outcome: ActivityOutcome;
  durationMs?: number;
  /** Characters of tool output fed back into the context ("context weight"). */
  resultChars?: number;
  /** Corrected start time, when the log knows it only at the end (OpenCode). */
  startedAt?: number;
  deniedBy?: ActivityDeniedBy;
  /** The user was asked for permission and allowed the call. */
  asked?: true;
}

export interface ActivityHookRecord extends ActivityRecordBase {
  kind: 'hook';
  /** `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`, … */
  hookEvent: string;
  /** The tool call the hook ran for, when it ran for one. */
  toolUseId?: string;
  outcome: ActivityHookOutcome;
  durationMs?: number;
  /** Characters of context the hook added; never the text itself. */
  contextChars?: number;
  label: string;
  /** Set when `label` is a vocabulary word. */
  labelKey?: ActivityLabelKey;
}

/** Memory the agent did not ask for: an instruction file or a hook put it into context. */
export interface ActivityMemoryPushedRecord extends ActivityRecordBase {
  kind: 'memoryPushed';
  label: string;
  /** Set when `label` is a vocabulary word. */
  labelKey?: ActivityLabelKey;
  chars?: number;
  via: ActivityMemoryVia;
}

/** Something arrived unasked at a station other than memory (a task notification, an injected skill). */
export interface ActivityInboundRecord extends ActivityRecordBase {
  kind: 'inbound';
  station: ActivityStationId;
  label: string;
  labelKey?: ActivityLabelKey;
}

export interface ActivityContextRecord extends ActivityRecordBase {
  kind: 'context';
  /** 0–100. */
  percent: number;
  tokens?: number;
  window?: number;
  source: ActivityContextSource;
}

export interface ActivityCompactionRecord extends ActivityRecordBase {
  kind: 'compaction';
  tokensBefore?: number;
  tokensAfter?: number;
  trigger?: 'auto' | 'manual';
}

export interface ActivitySubagentStartRecord extends ActivityRecordBase {
  kind: 'subagentStart';
  agentId: string;
  /** The tool call that started it. */
  spawnId?: string;
  parentAgentId?: string;
  label: string;
}

export interface ActivitySubagentEndRecord extends ActivityRecordBase {
  kind: 'subagentEnd';
  agentId: string;
  outcome: 'ok' | 'error' | 'cancelled';
}

export interface ActivityTurnEndRecord extends ActivityRecordBase {
  kind: 'turnEnd';
  outcome: ActivityTurnOutcome;
}

export type ActivityRecord =
  | ActivitySessionRecord
  | ActivityPromptRecord
  | ActivityStepRecord
  | ActivityToolStartRecord
  | ActivityToolEndRecord
  | ActivityHookRecord
  | ActivityMemoryPushedRecord
  | ActivityInboundRecord
  | ActivityContextRecord
  | ActivityCompactionRecord
  | ActivitySubagentStartRecord
  | ActivitySubagentEndRecord
  | ActivityTurnEndRecord;

export type ActivityRecordKind = ActivityRecord['kind'];

export interface ActivityRecordBatch {
  schemaVersion: 1;
  providerId: SessionProviderId;
  sessionId?: string;
  records: ActivityRecord[];
}

// ── Classification and recording ────────────────────────────────────────

export interface ActivityStationOverrides {
  /** MCP server name → station. Matched raw and with `plugin_<p>_` / `claude_ai_` stripped. */
  servers?: Readonly<Record<string, ActivityStationId>>;
  /** Full tool name (`mcp__srv__tool`, `Bash`, …) → station. Checked first. */
  tools?: Readonly<Record<string, ActivityStationId>>;
}

export interface ActivityMemoryOptions {
  /** Path fragments that make a file a memory (Claude Code's memory folder always counts). */
  paths?: readonly string[];
  /** MCP servers whose tools are memory. Default `['memory']`. */
  servers?: readonly string[];
  /** Shell commands or scripts that are memory (`recall` names `recall-sync.py`, never `recallable`). */
  commands?: readonly string[];
  /** Words after a memory command that may be shown; any other word could be content. */
  subcommands?: readonly string[];
  /** Instruction file basenames. Default CLAUDE.md, CLAUDE.local.md, AGENTS.md, AGENTS.override.md. */
  instructionFiles?: readonly string[];
}

export interface ActivityClassifyOptions {
  labels?: ActivityLabelMode;
  stationOverrides?: ActivityStationOverrides;
  memory?: ActivityMemoryOptions;
  /** MCP servers that drive a browser. Defaults cover the common browser servers. */
  browserServers?: readonly string[];
}

export interface ActivityClassification {
  station: ActivityStationId;
  label: string;
  labelKey?: ActivityLabelKey;
  hint?: ActivityHint;
  tool: string;
  instant?: true;
}

export interface ActivityRecorderOptions extends ActivityClassifyOptions {
  providerId: SessionProviderId;
  sessionId?: string;
  /** Derive `context` records from usage. Default true; hosts that know better pass false and call `observeContext`. */
  deriveContext?: boolean;
  /** Context window for a model id. Default: the shared model-context table. */
  contextWindowOf?: (model: string | undefined) => number | undefined;
  /** Bound on calls held open per stream. Default 1024. */
  maxOpenCalls?: number;
}

/** Which stream an event belongs to, when the caller knows (a subagent transcript). */
export interface ActivityEventSource {
  agentId?: string;
  spawnId?: string;
  parentAgentId?: string;
}

export interface ActivityContextObservation {
  at: number;
  percent: number;
  tokens?: number;
  window?: number;
}

/** A recorder's resumable state. JSON; treat as opaque. */
export interface ActivityRecorderState {
  version: 1;
  [key: string]: unknown;
}

export interface ActivityRecorder {
  /** Next `seq` the recorder will assign. */
  readonly nextSeq: number;
  observe(event: SessionEvent, source?: ActivityEventSource): ActivityRecord[];
  observeMany(events: readonly SessionEvent[], source?: ActivityEventSource): ActivityRecord[];
  observeContext(observation: ActivityContextObservation): ActivityRecord[];
  /** Ends every open call (end of a replay, process exit). */
  settle(at: number, outcome?: 'unknown' | 'cancelled'): ActivityRecord[];
  reset(): void;
  export(): ActivityRecorderState;
  /** False when the state is unusable (another version, malformed); the recorder is then reset. */
  import(state: unknown): boolean;
}

// ── State ────────────────────────────────────────────────────────────────

export interface ActivityStateOptions {
  /** Entries kept for drawing. Default 80. */
  ringSize?: number;
  /** Stops on the drawn route. Default 7. */
  routeStops?: number;
  /** Subagents shown orbiting. Default 12. */
  maxAgents?: number;
  /** An ok hook shorter than this is counted but not drawn. Default 400. */
  hookMinMs?: number;
  /** Consecutive failures that open a retry streak. Default 3. */
  retryStreakMin?: number;
  /** A↔B cycles that open an alternation. Default 3. */
  alternationMinCycles?: number;
}

/**
 * Reducer state: full-session totals plus the bounded drawing view.
 * JSON-safe (clone with `cloneActivityState`, persist with `JSON.stringify`);
 * treat its contents as opaque — they may change between minor releases.
 */
export interface ActivityState {
  readonly kind: 'sidekick-activity-state';
  readonly schemaVersion: 1;
}

// ── Snapshot (what a renderer draws) ────────────────────────────────────

export type ActivityEntryMark =
  | 'prompt'
  | 'done'
  | 'aborted'
  | 'switch'
  | 'compaction'
  | 'pushed'
  | 'notification';

export interface ActivityEntry {
  /** Stable key (the tool-call id, or kind + seq). */
  key: string;
  station: ActivityStationId;
  label: string;
  labelKey?: ActivityLabelKey;
  from: ActivityOrigin;
  agentId?: string;
  startedAt: number;
  /** Absent while running. */
  endedAt?: number;
  /** Absent while running. */
  outcome?: ActivityOutcome;
  deniedBy?: ActivityDeniedBy;
  mark?: ActivityEntryMark;
  fold?: number;
  hint?: ActivityHint;
  tool?: string;
}

export interface ActivityStationSnapshot {
  id: ActivityStationId;
  /** Calls (or arrivals) over the whole session. */
  count: number;
  /** Open now. */
  running: number;
  /** Start of the oldest open call. */
  runningSince?: number;
  /** Errors and denials since the last prompt. */
  faults: number;
  lastAt?: number;
  lastFaultAt?: number;
  /** Memory only: how much of `count` arrived unasked. */
  pushed?: number;
}

export interface ActivityAgentSnapshot {
  agentId: string;
  label: string;
  startedAt: number;
}

export interface ActivityRouteStop {
  station: ActivityStationId;
  at: number;
}

export interface ActivityModelSnapshot {
  id: string;
  steps: number;
  switchedAt?: number;
  previous?: string;
}

export interface ActivityContextSnapshot {
  percent: number;
  tokens?: number;
  window?: number;
  at: number;
  source: ActivityContextSource;
}

export interface ActivityTurnSnapshot {
  working: boolean;
  since?: number;
  /** The model is working with no main-loop call open (clock hands on Model). */
  thinkingSince?: number;
  lastPromptAt?: number;
  lastEnd?: { at: number; outcome: ActivityTurnOutcome };
}

export interface ActivityRetryStreakPattern {
  kind: 'retry-streak';
  station: ActivityStationId;
  failures: number;
  startAt: number;
  endAt: number;
  state: 'open' | 'recovered' | 'abandoned';
}

export interface ActivityAlternationPattern {
  kind: 'alternation';
  stations: [ActivityStationId, ActivityStationId];
  cycles: number;
  startAt: number;
  endAt: number;
  state: 'open' | 'closed';
  flavor?: 'edit-test';
}

/** Clients must ignore pattern kinds they do not know. */
export type ActivityPattern = ActivityRetryStreakPattern | ActivityAlternationPattern;

export interface ActivityTotals {
  prompts: number;
  calls: number;
  errors: number;
  denials: number;
  steps: number;
  pushed: number;
}

export interface ActivitySnapshot {
  schemaVersion: 1;
  providerId?: SessionProviderId;
  sessionId?: string;
  /** Time of the last record folded in. */
  at: number;
  startedAt?: number;
  /** One per station, in {@link ACTIVITY_STATIONS} order. */
  stations: ActivityStationSnapshot[];
  /** Newest last; at most `ringSize`; any status. */
  entries: ActivityEntry[];
  /** Every open call (at most 64); may overlap `entries` by key. */
  running: ActivityEntry[];
  agents: ActivityAgentSnapshot[];
  /** The main loop's last stations, oldest first; model, hooks and inbound left out. */
  route: ActivityRouteStop[];
  model?: ActivityModelSnapshot;
  context?: ActivityContextSnapshot;
  compactions: number;
  lastCompactionAt?: number;
  turn: ActivityTurnSnapshot;
  /** At most 8, newest last. */
  patterns: ActivityPattern[];
  totals: ActivityTotals;
}

// ── Insights (full-session statistics) ──────────────────────────────────

export interface ActivityLabelCount {
  label: string;
  count: number;
}

export interface ActivityStationInsight {
  id: ActivityStationId;
  calls: number;
  errors: number;
  denials: number;
  cancelled: number;
  /** Wall-clock time with at least one call open. */
  busyMs: number;
  /** Sum of call durations (parallel calls add up). */
  callMs: number;
  /** busyMs over the session's busy union, 0–1. */
  shareOfBusy: number;
  /** Characters of tool output fed into context. */
  resultChars: number;
  /** resultChars / 4. */
  estTokens: number;
  avgMs?: number;
  p95Ms?: number;
  /** At most 5. */
  topLabels: ActivityLabelCount[];
}

export interface ActivitySlowCall {
  station: ActivityStationId;
  label: string;
  durationMs: number;
  at: number;
}

export interface ActivityInsights {
  schemaVersion: 1;
  providerId?: SessionProviderId;
  sessionId?: string;
  span: { startAt?: number; endAt?: number; activeMs: number };
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
    compactions: number;
    subagents: number;
  };
  /** One per station, in ring order. */
  stations: ActivityStationInsight[];
  /** Main-loop station-to-station moves: counts[from][to], indexed like `stations`. */
  transitions: { stations: ActivityStationId[]; counts: number[][] };
  patterns: ActivityPattern[];
  models: Array<{ model: string; steps: number; firstAt: number; lastAt: number }>;
  /** At most 5, slowest first. */
  slowest: ActivitySlowCall[];
}

// ── Timeline (replay and scrubbing) ─────────────────────────────────────

export type ActivityMarkerKind =
  | 'prompt'
  | 'turnEnd'
  | 'fault'
  | 'compaction'
  | 'modelSwitch'
  | 'pattern';

export interface ActivityMarker {
  at: number;
  kind: ActivityMarkerKind;
  station?: ActivityStationId;
}

export interface ActivityTimelineOptions extends ActivityStateOptions {
  /** Records between state checkpoints. Default 256. */
  checkpointEvery?: number;
  /** Oldest records are dropped past this (their effect stays in the totals). Default unbounded. */
  maxRecords?: number;
  /**
   * The state before the first record given: another timeline's `base()`
   * (after it dropped old records), or a restored checkpoint. Default: empty.
   */
  base?: ActivityState;
}

export interface ActivityTimeline {
  readonly length: number;
  readonly startAt?: number;
  readonly endAt?: number;
  append(records: readonly ActivityRecord[]): void;
  /** State after every record. Do not mutate. */
  head(): Readonly<ActivityState>;
  /** A fresh state as of `at` (records with `at` ≤ the given time). */
  stateAt(at: number): ActivityState;
  snapshotAt(at: number): ActivitySnapshot;
  markers(): ActivityMarker[];
  records(): readonly ActivityRecord[];
  /**
   * A fresh copy of the state before the first record held: empty, the
   * `base` the timeline was created with, or the effect of records dropped
   * by `maxRecords`. With `records()` it rebuilds this timeline exactly.
   */
  base(): ActivityState;
}

export interface ActivityExport {
  schemaVersion: 1;
  kind: 'sidekick-activity';
  providerId?: SessionProviderId;
  sessionId?: string;
  /** The moment the snapshot shows. */
  at: number;
  snapshot: ActivitySnapshot;
  insights: ActivityInsights;
  records?: ActivityRecord[];
}

// ── Feed and text ───────────────────────────────────────────────────────

export interface ActivityFeedRow {
  /** The newest entry the row stands for. */
  entry: ActivityEntry;
  /** Entries folded into the row (1 when alone). */
  times: number;
  tookMs: number;
}

export interface ActivityFeedOptions {
  /** Rows returned. Default 16. */
  max?: number;
  /** Leave model steps out. Default true. */
  hideSteps?: boolean;
  /** Only this station's entries. */
  station?: ActivityStationId;
}

export interface DescribeActivityOptions {
  now?: number;
  strings?: Partial<ActivityStrings>;
}

export interface DescribeActivityInsightsOptions {
  strings?: Partial<ActivityStrings>;
  /** Lines returned. Default 12. */
  maxLines?: number;
}

// ── Rendering ───────────────────────────────────────────────────────────

/**
 * - `dark` / `light`: colors as presentation attributes, no `<style>`.
 * - `auto`: dark attributes plus a `prefers-color-scheme: light` style block.
 * - `css-vars`: classes and `var(--sidekick-activity-*, fallback)` only, for
 *   hosts that theme the map (a VS Code webview).
 */
export type ActivityTheme = 'dark' | 'light' | 'auto' | 'css-vars';
/**
 * - `full`: everything moves.
 * - `reduced`: opacity fades only; clock hands and orbits drawn still.
 * - `none`: no `<animate>` at all; the frame as it looks at `now`.
 */
export type ActivityMotion = 'full' | 'reduced' | 'none';
/** Who sits at the top of the ring. */
export type ActivityLayout = 'you-top' | 'you-bottom';

export type ActivityPaletteRole =
  | 'ground'
  | 'raised'
  | 'line'
  | 'spoke'
  | 'text'
  | 'muted'
  | 'dim'
  | 'accent'
  | 'hot'
  | 'fault'
  | 'warn'
  | 'memory'
  | 'memoryHot';

export interface ActivityPalette extends Record<ActivityPaletteRole, string> {
  /** One hue per station (pulses, worn spokes, lit rings). */
  stations: Record<ActivityStationId, string>;
}

export interface RenderActivityMapSvgOptions {
  /** The moment drawn, epoch ms. For a replay, the cursor; for a frozen session, `snapshot.at`. */
  now: number;
  theme?: ActivityTheme;
  palette?: Partial<ActivityPalette>;
  /** With `css-vars`: put the class rules inside the SVG. Default true. */
  embedStyles?: boolean;
  /** Class name prefix. Default `sam`. */
  classPrefix?: string;
  layout?: ActivityLayout;
  motion?: ActivityMotion;
  /** Playback speed for animation durations. Default 1. */
  speed?: number;
  /** Add to every animation offset; for hosts that keep one `<svg>` alive (its `getCurrentTime() * 1000`). */
  clockOffsetMs?: number;
  /** Text in the core, at most 10 characters. Default by provider. */
  coreName?: string;
  modelLabel?: (modelId: string) => string;
  strings?: Partial<ActivityStrings>;
  /** Pixel size, or `responsive` (viewBox only, 100% width). Default twice the viewBox. */
  size?: { width: number; height: number } | 'responsive';
  /** Prefix for element ids (`<title>`, `<desc>`), unique per page. */
  idPrefix?: string;
  /** Stations to emphasise (the rest dim). */
  highlight?: ActivityStationId | readonly ActivityStationId[];
  /** Adds a `<desc>` with the insight summary. */
  insights?: ActivityInsights;
}

export type ActivityTone =
  | 'default'
  | 'muted'
  | 'dim'
  | 'accent'
  | 'hot'
  | 'fault'
  | 'memory'
  | 'ok';

export interface ActivityTextSegment {
  text: string;
  tone: ActivityTone;
  bold?: boolean;
  station?: ActivityStationId;
}

export interface ActivityTextLayout {
  mode: 'ring' | 'list';
  width: number;
  /** Each row's visible length is at most `width` (as measured). */
  rows: ActivityTextSegment[][];
}

export interface LayoutActivityMapTextOptions {
  now: number;
  width: number;
  height?: number;
  /** `auto`: ring when the area allows (≥ 64 × 15), else list. */
  mode?: 'auto' | 'ring' | 'list';
  layout?: ActivityLayout;
  coreName?: string;
  modelLabel?: (modelId: string) => string;
  strings?: Partial<ActivityStrings>;
  /** Visible width of a string. Default: code points. */
  measure?: (text: string) => number;
  highlight?: ActivityStationId | readonly ActivityStationId[];
}
