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
}

// --- response_item ---

/**
 * A response item from the model.
 * The payload IS the item directly (no .item wrapper).
 * Tagged union on `type`.
 */
export type CodexResponseItem =
  | CodexMessageItem
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
  primary?: { used_percent: number; window_minutes: number; resets_at: number };
  secondary?: { used_percent: number; window_minutes: number; resets_at: number };
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
}
