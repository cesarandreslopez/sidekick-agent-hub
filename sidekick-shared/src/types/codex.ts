/**
 * @fileoverview Type definitions for Codex CLI (OpenAI) session rollout format.
 *
 * Codex stores sessions as JSONL rollout files in:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * with an optional SQLite index at ~/.codex/state.sqlite.
 *
 * Each line is a JSON object: { timestamp, type, payload }
 * with 5 top-level types: session_meta, response_item, compacted, turn_context, event_msg.
 *
 * @module types/codex
 */

// --- Top-level rollout line ---

/** Top-level rollout line in a Codex JSONL file. */
export interface CodexRolloutLine {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Discriminator for the payload type */
  type: 'session_meta' | 'response_item' | 'compacted' | 'turn_context' | 'event_msg';
  /**
   * Zero-based position of the record in its rollout (recent Codex versions).
   * In a forked subagent rollout, records before the child's
   * `session_meta.subagent_history_start_ordinal` are the parent's history.
   */
  ordinal?: number;
  /** Type-specific payload */
  payload: CodexSessionMeta | CodexResponseItem | CodexCompacted | CodexTurnContext | CodexEventMsg;
}

// --- session_meta ---

/** Session metadata written at the start of a rollout file. */
export interface CodexSessionMeta {
  id: string;
  timestamp?: string;
  cwd: string;
  originator?: string;
  model_provider?: string;
  cli_version?: string;
  source?: string;
  base_instructions?: { text?: string };
  git?: { branch?: string; commit?: string; dirty?: boolean };
  forked_from_id?: string;
  /** The root session of a subagent tree (recent Codex versions). */
  session_id?: string;
  /** Subagents: the thread that spawned this one. */
  parent_thread_id?: string;
  /** `user`, `subagent`, … (recent Codex versions). */
  thread_source?: string;
  /** Subagents: display nickname, e.g. `Banach`. */
  agent_nickname?: string | null;
  /** Subagents: agent path, e.g. `/root/review_builder`. */
  agent_path?: string | null;
  /** Subagents: requested role (`agent_type`), when one was given. */
  agent_role?: string | null;
  /**
   * Forked subagents: the ordinal of the first record that is the child's
   * own; earlier records are the parent's history the fork embeds.
   */
  subagent_history_start_ordinal?: number;
  history_mode?: string;
  multi_agent_version?: string;
}

// --- response_item ---

/**
 * A response item from the model.
 * The payload IS the item directly (no .item wrapper).
 * Tagged union on `type`.
 */
export type CodexResponseItem =
  | CodexMessageItem
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexFunctionCallItem
  | CodexFunctionCallOutputItem
  | CodexLocalShellCallItem
  | CodexWebSearchCallItem
  | CodexCustomToolCallItem
  | CodexCustomToolCallOutputItem;

/** Chat message (user, assistant, or developer). */
export interface CodexMessageItem {
  type: 'message';
  id?: string;
  role: 'user' | 'assistant' | 'developer' | 'system';
  content: CodexContentPart[] | string;
  status?: string;
  phase?: string;
}

/**
 * A message between agents of a multi-agent session (`author` and
 * `recipient` are agent paths such as `/root/review_builder` and `/root`).
 * Its first text part starts `Message Type: MESSAGE | NEW_TASK |
 * FINAL_ANSWER`, followed by `Task name:`, `Sender:`, and `Payload:` lines.
 */
export interface CodexAgentMessageItem {
  type: 'agent_message';
  id?: string;
  author?: string;
  recipient?: string;
  content: Array<CodexContentPart | { type: 'encrypted_content'; encrypted_content?: string }>;
}

/** Content part within a message. */
export interface CodexContentPart {
  type: 'output_text' | 'input_text' | 'refusal' | 'text';
  text?: string;
  annotations?: unknown[];
}

/** Reasoning / thinking output. */
export interface CodexReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: CodexReasoningSummary[];
  content?: unknown;
  encrypted_content?: string;
}

export interface CodexReasoningSummary {
  type: 'summary_text';
  text: string;
}

/** Function call initiated by the model. */
export interface CodexFunctionCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
  /** Tool namespace, e.g. `collaboration` for the multi-agent tools. */
  namespace?: string;
}

/** Result of a function call. */
export interface CodexFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/** Local shell command execution. */
export interface CodexLocalShellCallItem {
  type: 'local_shell_call';
  id?: string;
  call_id: string;
  action: {
    type: 'exec';
    command: string[];
    workdir?: string;
    timeout?: number;
  };
  status?: string;
}

/** Web search call. */
export interface CodexWebSearchCallItem {
  type: 'web_search_call';
  id?: string;
  call_id?: string;
  status?: string;
}

/** Custom tool call (e.g. apply_patch, web_search). */
export interface CodexCustomToolCallItem {
  type: 'custom_tool_call';
  id?: string;
  call_id: string;
  name: string;
  input: string;
  status?: string;
}

/** Result of a custom tool call. */
export interface CodexCustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  call_id: string;
  output: string;
}

// --- compacted ---

/** Context compaction marker. */
export interface CodexCompacted {
  summary?: string;
  tokens_before?: number;
  tokens_after?: number;
}

// --- turn_context ---

/** Turn context providing model and policy info. */
export interface CodexTurnContext {
  model?: string;
  cwd?: string;
  approval_policy?: string;
  sandbox_policy?: string;
  effort?: string;
}

// --- event_msg ---

/**
 * Event message. The payload IS the event directly (no .event wrapper).
 * Tagged union on `type`.
 */
export type CodexEventMsg = CodexEvent;

export type CodexEvent =
  | CodexTurnStartedEvent
  | CodexTurnCompleteEvent
  | CodexTaskStartedEvent
  | CodexTaskCompleteEvent
  | CodexTurnAbortedEvent
  | CodexTokenCountEvent
  | CodexAgentMessageEvent
  | CodexAgentReasoningEvent
  | CodexUserMessageEvent
  | CodexExecCommandBeginEvent
  | CodexExecCommandEndEvent
  | CodexMcpToolCallBeginEvent
  | CodexMcpToolCallEndEvent
  | CodexErrorEvent
  | CodexContextCompactedEvent
  | CodexPatchAppliedEvent
  | CodexItemCompletedEvent
  | CodexBackgroundEvent
  | CodexGenericEvent;

export interface CodexTurnStartedEvent {
  type: 'turn_started';
  turn_id?: string;
}

export interface CodexTurnCompleteEvent {
  type: 'turn_complete';
  turn_id?: string;
}

export interface CodexTaskStartedEvent {
  type: 'task_started';
  turn_id?: string;
  model_context_window?: number;
  collaboration_mode_kind?: string;
}

export interface CodexTaskCompleteEvent {
  type: 'task_complete';
  turn_id?: string;
  last_agent_message?: string;
}

export interface CodexTurnAbortedEvent {
  type: 'turn_aborted';
  reason?: string;
}

export interface CodexAgentReasoningEvent {
  type: 'agent_reasoning';
  text: string;
}

export interface CodexTokenCountEvent {
  type: 'token_count';
  info: {
    total_token_usage?: CodexTokenUsage;
    last_token_usage?: CodexTokenUsage;
    model_context_window?: number;
  } | null;
  rate_limits?: CodexRateLimits;
}

export interface CodexRateLimits {
  limit_id?: string;
  limit_name?: string | null;
  primary?: { used_percent: number; window_minutes?: number | null; resets_at?: number | null };
  secondary?: { used_percent: number; window_minutes?: number | null; resets_at?: number | null };
  credits?: unknown;
  plan_type?: string;
  rate_limit_reached_type?: string;
}

/**
 * Codex reports several rate-limit families per session, keyed by `limit_id`.
 * The aggregate plan quota — what the usage API surfaces — is `limit_id: "codex"`
 * (or absent on older payloads). Model/feature-specific families (e.g.
 * `codex_bengalfox`, `premium`) report their own windows and can read 0% while the
 * plan is heavily used, so they must never mask the aggregate in the standard
 * quota view. Returns true only for the aggregate family.
 */
export function isAggregateCodexLimit(limitId?: string | null): boolean {
  return !limitId || limitId === 'codex';
}

export interface CodexTokenUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexAgentMessageEvent {
  type: 'agent_message';
  message: string;
}

export interface CodexUserMessageEvent {
  type: 'user_message';
  message: string;
}

export interface CodexExecCommandBeginEvent {
  type: 'exec_command_begin';
  call_id: string;
  command: string[];
  workdir?: string;
  timeout?: number;
}

export interface CodexExecCommandEndEvent {
  type: 'exec_command_end';
  call_id: string;
  exit_code: number;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
}

export interface CodexMcpToolCallBeginEvent {
  type: 'mcp_tool_call_begin';
  call_id: string;
  server_name?: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
}

export interface CodexMcpToolCallEndEvent {
  type: 'mcp_tool_call_end';
  call_id: string;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
}

export interface CodexErrorEvent {
  type: 'error';
  message: string;
  code?: string;
}

export interface CodexContextCompactedEvent {
  type: 'context_compacted';
  summary?: string;
  tokens_before?: number;
  tokens_after?: number;
}

export interface CodexPatchAppliedEvent {
  type: 'patch_applied';
  file_path?: string;
  additions?: number;
  deletions?: number;
}

/**
 * A completed turn item. `SubAgentActivity` items record the multi-agent
 * lifecycle: `kind` `started` (id = the spawn call), `completed` (id =
 * `subagent-completed-<child turn id>`), `interacted` (id = a
 * `followup_task` / `send_message` call), `interrupted` (id = an
 * `interrupt_agent` call).
 */
export interface CodexItemCompletedEvent {
  type: 'item_completed';
  thread_id?: string;
  turn_id?: string;
  item?: {
    type?: string;
    id?: string;
    kind?: string;
    agent_thread_id?: string;
    agent_path?: string;
    model?: string | null;
    reasoning_effort?: string | null;
    [key: string]: unknown;
  };
}

export interface CodexBackgroundEvent {
  type: 'background';
  message?: string;
}

/** Catch-all for unrecognized event types. */
export interface CodexGenericEvent {
  type: string;
  [key: string]: unknown;
}

// --- SQLite row type ---

/** Row from the Codex state.sqlite threads table. */
export interface CodexDbThread {
  id: string;
  rollout_path: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  title?: string;
  tokens_used?: number;
  first_user_message?: string;
  model_provider?: string;
  git_branch?: string;
  git_commit?: string;
  forked_from_id?: string;
  /** `cli`, `exec`, … or a JSON object string for spawned subagents. */
  source?: string;
  agent_nickname?: string | null;
  agent_role?: string | null;
  /** Subagents: agent path, e.g. `/root/review_builder` (recent schemas). */
  agent_path?: string | null;
  /** `user`, `subagent`, … (recent schemas). */
  thread_source?: string | null;
  /** 1 once the thread is archived; Codex then moves its rollout to `archived_sessions/`. */
  archived?: number;
  /** Unix seconds when the thread was archived. */
  archived_at?: number | null;
}
