/**
 * Event types for parsed headless agent output: `claude -p --output-format
 * stream-json` and `codex exec --json`.
 *
 * Pure types; no runtime code.
 *
 * @module headless/types
 */

import type { ToolCategory } from '../toolCategory';

export type HeadlessProvider = 'claude-code' | 'codex';

/**
 * Token counts in four disjoint buckets. `totalTokens` is their sum; Codex
 * counts reasoning inside `outputTokens`, so `reasoningTokens` is
 * informational and never added.
 */
export interface HeadlessTokenUsage {
  /** Input that was neither read from nor written to the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

/** The run started or resumed: what the agent reported about its session. */
export interface HeadlessSessionEvent {
  type: 'session';
  provider: HeadlessProvider;
  /** Claude `session_id`; Codex `thread_id` (pass it to `codex exec resume`). */
  sessionId?: string;
  model?: string;
  cwd?: string;
  /** Claude: the tools offered to the model. */
  tools?: string[];
  /** Claude: the CLI version. */
  version?: string;
  permissionMode?: string;
}

/** Text the agent produced: its reply, or a reasoning summary. */
export interface HeadlessTextEvent {
  type: 'text';
  provider: HeadlessProvider;
  kind: 'message' | 'reasoning';
  text: string;
  /** A streamed fragment (`includePartial`), not the complete text. */
  partial?: true;
  /** Claude message id, or Codex item id. */
  messageId?: string;
  /** Claude: the subagent tool call this text belongs to. */
  parentToolUseId?: string;
}

export type HeadlessToolStatus = 'in_progress' | 'completed' | 'failed' | 'declined';

/** A tool call starting, progressing, or finishing. */
export interface HeadlessToolEvent {
  type: 'tool';
  provider: HeadlessProvider;
  phase: 'started' | 'updated' | 'completed';
  /** Claude `tool_use` id; Codex item id. */
  id: string;
  /**
   * The tool: Claude's tool name; for Codex `exec_command`, `apply_patch`,
   * `web_search`, `update_plan`, the MCP tool, or the multi-agent tool.
   * Unknown on a Claude result whose call was not seen.
   */
  name?: string;
  /** What the tool does, from `classifyTool()`. */
  category: ToolCategory;
  input?: unknown;
  /** Shell calls: the command line. */
  command?: string;
  /** The result text, when the tool finished. */
  output?: string;
  exitCode?: number;
  status?: HeadlessToolStatus;
  /** The tool reported a failure. */
  isError?: boolean;
  mcpServer?: string;
  /** Claude: the subagent tool call this call ran under. */
  parentToolUseId?: string;
}

/**
 * Token usage. `call`: one model call (Claude, de-duplicated by message id).
 * `run`: everything this process used (Claude's `result`; Codex's thread
 * total minus `baselineUsage`). `thread-total`: Codex's running total for
 * the whole thread, earlier `exec resume` runs included.
 */
export interface HeadlessUsageEvent {
  type: 'usage';
  provider: HeadlessProvider;
  scope: 'call' | 'run' | 'thread-total';
  usage: HeadlessTokenUsage;
  model?: string;
  messageId?: string;
  /** Claude `result.total_cost_usd`, on the `run` usage. */
  costUsd?: number;
}

/**
 * How the run ended. `incomplete`: the stream ended without a terminal event
 * (the process was killed, crashed, or its output was cut).
 */
export interface HeadlessResultEvent {
  type: 'result';
  provider: HeadlessProvider;
  status: 'success' | 'error' | 'incomplete';
  /** The final reply: Claude `result`; Codex's last agent message. */
  text?: string;
  sessionId?: string;
  /** Claude `subtype` (`success`, `error_max_turns`, …). */
  subtype?: string;
  durationMs?: number;
  numTurns?: number;
  costUsd?: number;
  /** Claude `errors`; Codex `turn.failed` message. */
  errors?: string[];
}

/**
 * A reported error. `turn`: the turn failed (Codex `turn.failed`). `stream`:
 * an error event of the stream (Codex `error`, a Claude API error message);
 * whether it ends the run is up to the agent. `item`: a non-fatal error item
 * (Codex warnings and reconnect notices).
 */
export interface HeadlessErrorEvent {
  type: 'error';
  provider: HeadlessProvider;
  scope: 'turn' | 'stream' | 'item';
  message: string;
  /** Claude assistant `error` code (`rate_limit`, `authentication_failed`, …). */
  code?: string;
  /**
   * The error payload as the agent wrote it: Codex `error` event fields
   * without `type`, the `turn.failed` error object, or the error item;
   * structured fields such as `codexErrorInfo` survive here.
   */
  details?: Record<string, unknown>;
}

/** The context was compacted (Claude `compact_boundary`). */
export interface HeadlessCompactionEvent {
  type: 'compaction';
  provider: HeadlessProvider;
  trigger?: string;
  preTokens?: number;
}

/** A hook ran (Claude `hook_started` / `hook_response`). */
export interface HeadlessHookEvent {
  type: 'hook';
  provider: HeadlessProvider;
  phase: 'started' | 'progress' | 'completed';
  name?: string;
  event?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** A status change: Claude `status` (`compacting`, cleared as null), Codex `turn.started`. */
export interface HeadlessStatusEvent {
  type: 'status';
  provider: HeadlessProvider;
  status: string | null;
}

/** A record the parser does not interpret (`includeUnknown`). */
export interface HeadlessUnknownEvent {
  type: 'unknown';
  provider: HeadlessProvider;
  raw: unknown;
}

export type HeadlessEvent =
  | HeadlessSessionEvent
  | HeadlessTextEvent
  | HeadlessToolEvent
  | HeadlessUsageEvent
  | HeadlessResultEvent
  | HeadlessErrorEvent
  | HeadlessCompactionEvent
  | HeadlessHookEvent
  | HeadlessStatusEvent
  | HeadlessUnknownEvent;

/** Options for the one-record parse functions. */
export interface HeadlessParseOptions {
  /** Model for usage events when the stream does not name one (Codex never does). */
  model?: string;
  /** Emit streamed fragments: Claude `stream_event` deltas, Codex `item.updated`. */
  includePartial?: boolean;
  /** Emit records the parser does not interpret as `unknown` events. */
  includeUnknown?: boolean;
}

export interface HeadlessStreamOptions extends HeadlessParseOptions {
  /** Longest line parsed, in UTF-8 bytes (default 16 MiB); longer ones are skipped and counted. */
  maxLineBytes?: number;
  /**
   * Codex: the thread total before this run (the last `thread-total` usage
   * of the previous `exec resume`), subtracted to give this run's usage.
   */
  baselineUsage?: HeadlessTokenUsage;
}

/** What a stream parser has seen so far. */
export interface HeadlessStreamState {
  provider: HeadlessProvider;
  sessionId?: string;
  model?: string;
  /** A terminal event (Claude `result`, Codex `turn.completed` / `turn.failed`) arrived. */
  terminal: boolean;
  result?: HeadlessResultEvent['status'];
  /** The final reply so far. */
  text?: string;
  /** Complete lines read, blank ones included. */
  lines: number;
  /** Lines that were not JSON objects. */
  nonJsonLines: number;
  /** Lines over `maxLineBytes`, skipped. */
  oversizedLines: number;
  /** Codex: the latest thread total. */
  threadTotal?: HeadlessTokenUsage;
  /** This run's usage: Claude's `result` totals; Codex's thread total minus the baseline. */
  runUsage?: HeadlessTokenUsage;
}

/** An incremental parser over a process's stdout. */
export interface HeadlessStreamParser {
  /**
   * Feed raw output: bytes (decoded as UTF-8, characters split across chunks
   * are joined) or text. Do not mix the two in one stream. Returns the
   * events of the lines that became complete.
   */
  push(chunk: string | Uint8Array): HeadlessEvent[];
  /**
   * The output ended: parses a final line without a newline and, when no
   * terminal event arrived, emits a `result` with status `incomplete`.
   */
  end(): HeadlessEvent[];
  state(): HeadlessStreamState;
}
