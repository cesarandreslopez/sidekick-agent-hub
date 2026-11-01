/**
 * @fileoverview Stateful parser converting Codex rollout lines to SessionEvent[].
 *
 * Unlike OpenCode's stateless converter, this is stateful because:
 * - exec_command_begin/end and mcp_tool_call_begin/end need pairing by call_id
 * - turn_context sets the current model for subsequent events
 * - token_count repeats its cumulative total on duplicate events, so each
 *   call is counted only when `total_token_usage` changes
 *
 * Moved from sidekick-vscode to sidekick-shared for reuse across packages.
 *
 * @module parsers/codexParser
 */

import type { SessionEvent, MessageUsage } from '../types/sessionEvent';
import type {
  CodexRolloutLine,
  CodexSessionMeta,
  CodexResponseItem,
  CodexCompacted,
  CodexTurnContext,
  CodexEventMsg,
  CodexMessageItem,
  CodexReasoningItem,
  CodexFunctionCallItem,
  CodexFunctionCallOutputItem,
  CodexLocalShellCallItem,
  CodexCustomToolCallItem,
  CodexCustomToolCallOutputItem,
  CodexContentPart,
  CodexTokenUsage,
  CodexRateLimits,
  CodexTokenCountEvent,
  CodexTaskStartedEvent,
  CodexExecCommandBeginEvent,
  CodexExecCommandEndEvent,
  CodexMcpToolCallBeginEvent,
  CodexMcpToolCallEndEvent,
  CodexErrorEvent,
  CodexContextCompactedEvent,
  CodexPatchAppliedEvent,
} from '../types/codex';
import { isAggregateCodexLimit } from '../types/codex';
import { normalizeToolName } from './openCodeParser';
import { normalizeProviderUsage } from '../usageNormalization';

/** Pending exec command awaiting its end event. */
interface PendingExecCommand {
  call_id: string;
  command: string[];
  workdir?: string;
  timestamp: string;
}

function reportedCompaction(
  tokensBefore: number | undefined,
  tokensAfter: number | undefined,
): Pick<SessionEvent, 'compaction'> | Record<string, never> {
  if (
    typeof tokensBefore !== 'number' ||
    typeof tokensAfter !== 'number' ||
    !Number.isFinite(tokensBefore) ||
    !Number.isFinite(tokensAfter) ||
    tokensBefore < tokensAfter ||
    tokensAfter < 0
  ) {
    return {};
  }
  return { compaction: { tokensBefore, tokensAfter } };
}

/** Pending MCP tool call awaiting its end event. */
interface PendingMcpToolCall {
  call_id: string;
  server_name?: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
  timestamp: string;
}

function normalizeRateLimits(
  rateLimits: CodexRateLimits | null | undefined,
): SessionEvent['rateLimits'] | undefined {
  if (!rateLimits?.primary && !rateLimits?.secondary) return undefined;
  return {
    primary: rateLimits.primary
      ? {
          usedPercent: rateLimits.primary.used_percent || 0,
          windowMinutes: rateLimits.primary.window_minutes || 0,
          resetsAt: rateLimits.primary.resets_at || 0,
        }
      : undefined,
    secondary: rateLimits.secondary
      ? {
          usedPercent: rateLimits.secondary.used_percent || 0,
          windowMinutes: rateLimits.secondary.window_minutes || 0,
          resetsAt: rateLimits.secondary.resets_at || 0,
        }
      : undefined,
  };
}

const CODEX_USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;

function usageField(usage: CodexTokenUsage, field: (typeof CODEX_USAGE_FIELDS)[number]): number {
  const value = usage[field];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function codexTotalOf(usage: CodexTokenUsage): number {
  return (
    usageField(usage, 'total_tokens') ||
    usageField(usage, 'input_tokens') + usageField(usage, 'output_tokens')
  );
}

/**
 * Resolve the usage of the single call a Codex `token_count` event reports.
 *
 * Codex emits `token_count` repeatedly — rate-limit refreshes and resumes
 * resend the same `info` — so summing `last_token_usage` per event counts
 * those calls again. `total_token_usage` is cumulative, which makes an
 * unchanged total the reliable duplicate signal. When `last_token_usage` is
 * missing, the call is the growth of the cumulative total (never the total
 * itself). A total that drops means the counter restarted; re-baseline on it.
 */
export function resolveCodexCallUsage(
  info:
    | { last_token_usage?: CodexTokenUsage | null; total_token_usage?: CodexTokenUsage | null }
    | null
    | undefined,
  previousTotal: CodexTokenUsage | null,
): { usage: CodexTokenUsage | null; total: CodexTokenUsage | null } {
  if (!info) return { usage: null, total: previousTotal };
  const last = info.last_token_usage ?? null;
  const total = info.total_token_usage ?? null;

  if (total && previousTotal) {
    const unchanged = CODEX_USAGE_FIELDS.every(
      (field) => usageField(total, field) === usageField(previousTotal, field),
    );
    if (unchanged) return { usage: null, total };
    if (codexTotalOf(total) < codexTotalOf(previousTotal)) {
      return { usage: last ?? total, total };
    }
  }
  if (last) return { usage: last, total: total ?? previousTotal };
  if (!total) return { usage: null, total: previousTotal };

  const delta = {} as CodexTokenUsage;
  let any = false;
  for (const field of CODEX_USAGE_FIELDS) {
    const value = Math.max(
      0,
      usageField(total, field) - (previousTotal ? usageField(previousTotal, field) : 0),
    );
    delta[field] = value;
    if (value > 0) any = true;
  }
  return { usage: any ? delta : null, total };
}

/**
 * Codex-specific tool name normalization.
 * Extends the shared normalizeToolName with Codex-specific mappings.
 */
export function normalizeCodexToolName(name: string): string {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === 'local_shell' || lower === 'local_shell_call') return 'Bash';
  if (lower === 'exec_command') return 'Bash';
  if (lower === 'write_stdin') return 'Bash';
  if (lower === 'request_user_input') return 'AskUserQuestion';
  if (lower === 'update_plan') return 'UpdatePlan';
  if (lower === 'web_search') return 'WebSearch';
  return normalizeToolName(name);
}

/**
 * Normalizes Codex tool input fields for downstream monitor compatibility.
 */
export function normalizeCodexToolInput(
  canonicalToolName: string,
  rawToolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...input };
  normalized._sidekickRawToolName = rawToolName;

  // Codex exec_command uses cmd; monitor expects command for Bash context extraction.
  if (
    canonicalToolName === 'Bash' &&
    typeof normalized.cmd === 'string' &&
    normalized.command === undefined
  ) {
    normalized.command = normalized.cmd;
  }

  // request_user_input currently emits questions; keep as-is (compatible with AskUserQuestion extractor).
  return normalized;
}

function parsePlainTextFailure(output: string): boolean {
  if (!output) return false;
  const exitCodeMatch = /Process exited with code\s+(-?\d+)/i.exec(output);
  if (exitCodeMatch) {
    return Number(exitCodeMatch[1]) !== 0;
  }

  return /(Permission denied|No such file|not found|SyntaxError|failed|error:)/i.test(output);
}

/**
 * Extracts plain text from Codex message content.
 */
function extractTextFromContent(content: CodexContentPart[] | string): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.text) texts.push(part.text);
  }
  return texts.join('\n');
}

/**
 * Extracts file paths from an apply_patch input string.
 * Matches lines like: `*** Add File: src/math.ts` or `*** Update File: src/index.ts`
 */
export function extractPatchFilePaths(input: string): string[] {
  const paths: string[] = [];
  const re = /\*\*\* (?:Add|Update|Delete) File: (.+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    paths.push(m[1].trim());
  }
  return paths;
}

/** Default cap on each piece of per-call correlation state the parser keeps. */
export const DEFAULT_MAX_TRACKED_TOOL_CALLS = 4096;

export interface CodexRolloutParserOptions {
  /**
   * How many call ids each correlation table (emitted tool uses, expanded
   * patches, pending exec and MCP calls) remembers before forgetting the
   * oldest. Bounds memory on long-running rollouts; default 4096.
   */
  maxTrackedToolCalls?: number;
  /**
   * Approximate bytes the parser may hold for pending tool calls: exec and
   * MCP calls still waiting for their end event (with their buffered command
   * or arguments) and `apply_patch` calls waiting for their output. Past the
   * budget the oldest pending call is forgotten first, as
   * `maxTrackedToolCalls` does by count, so its end event still emits a tool
   * use but without the forgotten details; a single call larger than the
   * budget is not kept at all. `getPendingStats()` counts the evictions.
   * Default: unlimited.
   */
  maxPendingBytes?: number;
  /**
   * Metadata-only scan: tool-call inputs are emitted as `{}` plus the
   * `_sidekick*` raw-name keys, tool results carry empty content (their
   * `is_error` and `duration` are kept), reasoning is emitted with empty
   * thinking text, and pending calls buffer no command or arguments. Tool
   * names, ids, timestamps, models, usage, rate limits, and message text are
   * unchanged. For cheap passes over large rollouts; default false.
   */
  metadataOnly?: boolean;
}

/** Pending tool-call state counters from {@link CodexRolloutParser.getPendingStats}. */
export interface CodexPendingStats {
  /** Tool calls waiting for their end or output event. */
  pendingCalls: number;
  /** Approximate bytes they hold; `null` unless `maxPendingBytes` is set. */
  pendingBytes: number | null;
  /** Pending calls forgotten because a table exceeded `maxTrackedToolCalls`. */
  evictedByCount: number;
  /** Pending calls forgotten because `maxPendingBytes` was exceeded. */
  evictedByBytes: number;
}

/** Fixed per-entry cost added to each pending call's byte estimate. */
const PENDING_ENTRY_OVERHEAD_BYTES = 64;

/** Prefix of the bookkeeping keys the parser stashes inside tool inputs. */
const SIDEKICK_INPUT_KEY_PREFIX = '_sidekick';

/** Adds `key`, refreshing its position, and evicts the oldest past `max`. */
function rememberBounded<K>(set: Set<K>, key: K, max: number): void {
  set.delete(key);
  set.add(key);
  while (set.size > max) set.delete(set.values().next().value as K);
}

/** A pending call's place in the oldest-first byte budget. */
interface PendingLedgerEntry {
  table: Map<string, unknown>;
  callId: string;
  bytes: number;
}

function stringBytes(...values: Array<string | undefined>): number {
  let total = 0;
  for (const value of values) if (typeof value === 'string') total += value.length;
  return total;
}

function approxJsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Only the `_sidekick*` bookkeeping keys of a tool input. */
function sidekickKeysOnly(input: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key.startsWith(SIDEKICK_INPUT_KEY_PREFIX)) kept[key] = input[key];
  }
  return kept;
}

/**
 * Stateful parser for Codex JSONL rollout lines.
 *
 * Maintains internal state for:
 * - Session metadata (from session_meta)
 * - Current model (from turn_context)
 * - Pending exec commands and MCP tool calls (begin/end pairing)
 * - Previous cumulative token total (to skip duplicate token_count events)
 */
export class CodexRolloutParser {
  private sessionMeta: CodexSessionMeta | null = null;
  private currentModel: string | null = null;
  private pendingExecCommands = new Map<string, PendingExecCommand>();
  private pendingMcpToolCalls = new Map<string, PendingMcpToolCall>();
  private lastTokenUsage: CodexTokenUsage | null = null;
  /** Cumulative `total_token_usage` from the previous token_count event. */
  private prevTotalUsage: CodexTokenUsage | null = null;
  private modelContextWindow: number | null = null;
  private lastRateLimits: CodexRateLimits | null = null;
  private hasAggregateRateLimits = false;
  private inPlanMode = false;
  private emittedToolUseIds = new Set<string>();
  private patchExpandedToolUseIds = new Map<string, string[]>();
  private readonly maxTrackedToolCalls: number;
  /** Byte budget for pending calls; `null` = unlimited (no accounting). */
  private readonly maxPendingBytes: number | null;
  private readonly metadataOnly: boolean;
  /** Pending calls in insertion order, for the byte budget. */
  private pendingLedger = new Map<string, PendingLedgerEntry>();
  private pendingBytes = 0;
  private evictedByCount = 0;
  private evictedByBytes = 0;

  constructor(options: CodexRolloutParserOptions = {}) {
    const max = options.maxTrackedToolCalls;
    this.maxTrackedToolCalls =
      typeof max === 'number' && max >= 1 ? Math.floor(max) : DEFAULT_MAX_TRACKED_TOOL_CALLS;
    const maxBytes = options.maxPendingBytes;
    this.maxPendingBytes =
      typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 1
        ? Math.floor(maxBytes)
        : null;
    this.metadataOnly = options.metadataOnly === true;
  }

  /** Counters for the pending tool-call state and what the caps evicted. */
  getPendingStats(): CodexPendingStats {
    return {
      pendingCalls:
        this.pendingExecCommands.size +
        this.pendingMcpToolCalls.size +
        this.patchExpandedToolUseIds.size,
      pendingBytes: this.maxPendingBytes === null ? null : this.pendingBytes,
      evictedByCount: this.evictedByCount,
      evictedByBytes: this.evictedByBytes,
    };
  }

  /** Get stored session metadata. */
  getSessionMeta(): CodexSessionMeta | null {
    return this.sessionMeta;
  }

  /** Get current model from turn_context. */
  getCurrentModel(): string | null {
    return this.currentModel;
  }

  /** Get the last observed token usage snapshot. */
  getLastTokenUsage(): CodexTokenUsage | null {
    return this.lastTokenUsage;
  }

  /** Get the model context window size from token_count events. */
  getModelContextWindow(): number | null {
    return this.modelContextWindow;
  }

  /** Get the last observed rate limits from token_count events. */
  getLastRateLimits(): CodexRateLimits | null {
    return this.lastRateLimits;
  }

  /**
   * Converts a single rollout line to zero or more session events.
   */
  convertLine(line: CodexRolloutLine): SessionEvent[] {
    switch (line.type) {
      case 'session_meta':
        return this.handleSessionMeta(line.timestamp, line.payload as CodexSessionMeta);
      case 'response_item':
        return this.handleResponseItem(line.timestamp, line.payload as CodexResponseItem);
      case 'compacted':
        return this.handleCompacted(line.timestamp, line.payload as CodexCompacted);
      case 'turn_context':
        return this.handleTurnContext(line.payload as CodexTurnContext);
      case 'event_msg':
        return this.handleEventMsg(line.timestamp, line.payload as CodexEventMsg);
      default:
        return [];
    }
  }

  /** Reset all parser state. */
  reset(): void {
    this.sessionMeta = null;
    this.currentModel = null;
    this.pendingExecCommands.clear();
    this.pendingMcpToolCalls.clear();
    this.lastTokenUsage = null;
    this.prevTotalUsage = null;
    this.modelContextWindow = null;
    this.lastRateLimits = null;
    this.hasAggregateRateLimits = false;
    this.inPlanMode = false;
    this.emittedToolUseIds.clear();
    this.patchExpandedToolUseIds.clear();
    this.pendingLedger.clear();
    this.pendingBytes = 0;
    this.evictedByCount = 0;
    this.evictedByBytes = 0;
  }

  // --- Pending call state ---

  /**
   * Stores a pending call, refreshing its position, then enforces the count
   * cap on its table and the byte budget across all pending tables, oldest
   * first.
   */
  private putPending<V>(
    table: Map<string, V>,
    callId: string,
    value: V,
    estimateBytes: () => number,
  ): void {
    this.forgetPendingBytes(table, callId);
    table.delete(callId);
    table.set(callId, value);
    while (table.size > this.maxTrackedToolCalls) {
      const oldest = table.keys().next().value as string;
      table.delete(oldest);
      this.forgetPendingBytes(table, oldest);
      this.evictedByCount += 1;
    }
    if (this.maxPendingBytes === null) return;
    const bytes = PENDING_ENTRY_OVERHEAD_BYTES + estimateBytes();
    this.pendingLedger.set(this.ledgerKey(table, callId), {
      table: table as Map<string, unknown>,
      callId,
      bytes,
    });
    this.pendingBytes += bytes;
    while (this.pendingBytes > this.maxPendingBytes && this.pendingLedger.size > 0) {
      const [key, oldest] = this.pendingLedger.entries().next().value as [
        string,
        PendingLedgerEntry,
      ];
      this.pendingLedger.delete(key);
      this.pendingBytes -= oldest.bytes;
      oldest.table.delete(oldest.callId);
      this.evictedByBytes += 1;
    }
  }

  /** Removes and returns a pending call. */
  private takePending<V>(table: Map<string, V>, callId: string): V | undefined {
    const value = table.get(callId);
    table.delete(callId);
    this.forgetPendingBytes(table, callId);
    return value;
  }

  private forgetPendingBytes(table: Map<string, unknown>, callId: string): void {
    if (this.maxPendingBytes === null) return;
    const key = this.ledgerKey(table, callId);
    const entry = this.pendingLedger.get(key);
    if (!entry) return;
    this.pendingLedger.delete(key);
    this.pendingBytes -= entry.bytes;
  }

  private ledgerKey(table: Map<string, unknown>, callId: string): string {
    const kind =
      table === this.pendingExecCommands ? 'e' : table === this.pendingMcpToolCalls ? 'm' : 'p';
    return `${kind}\u0000${callId}`;
  }

  /** The emitted tool input: unchanged, or only its `_sidekick*` keys in metadata-only mode. */
  private toolInput(input: Record<string, unknown>): Record<string, unknown> {
    return this.metadataOnly ? sidekickKeysOnly(input) : input;
  }

  /** The emitted tool-result content: unchanged, or empty in metadata-only mode. */
  private toolOutput<V>(content: V): V | string {
    return this.metadataOnly ? '' : content;
  }

  // --- Handlers ---

  private handleSessionMeta(timestamp: string, payload: CodexSessionMeta): SessionEvent[] {
    this.sessionMeta = payload;
    const text = payload.base_instructions?.text?.trim();
    return [
      {
        type: 'system',
        ...(text
          ? {
              message: {
                role: 'system',
                id: `${payload.id}:base-instructions`,
                sourceLabel: 'base instructions',
                content: [{ type: 'text', text }],
              },
            }
          : {}),
        timestamp,
        cwd: payload.cwd || undefined,
      },
    ];
  }

  private handleResponseItem(timestamp: string, payload: CodexResponseItem): SessionEvent[] {
    // payload IS the item directly (no .item wrapper)
    if (!payload || !payload.type) return [];

    switch (payload.type) {
      case 'message':
        return this.handleMessage(timestamp, payload as CodexMessageItem);
      case 'reasoning':
        return this.handleReasoning(timestamp, payload as CodexReasoningItem);
      case 'function_call':
        return this.handleFunctionCall(timestamp, payload as CodexFunctionCallItem);
      case 'function_call_output':
        return this.handleFunctionCallOutput(timestamp, payload as CodexFunctionCallOutputItem);
      case 'local_shell_call':
        return this.handleLocalShellCall(timestamp, payload as CodexLocalShellCallItem);
      case 'custom_tool_call':
        return this.handleCustomToolCall(timestamp, payload as CodexCustomToolCallItem);
      case 'custom_tool_call_output':
        return this.handleCustomToolCallOutput(timestamp, payload as CodexCustomToolCallOutputItem);
      default:
        return [];
    }
  }

  private handleMessage(timestamp: string, item: CodexMessageItem): SessionEvent[] {
    const text = extractTextFromContent(item.content);
    if (!text) return [];

    if (item.role === 'user') {
      return [
        {
          type: 'user',
          message: {
            role: 'user',
            id: item.id,
            content: [{ type: 'text', text }],
          },
          timestamp,
        },
      ];
    }

    if (item.role === 'assistant') {
      return [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            id: item.id,
            model: this.currentModel || undefined,
            content: [{ type: 'text', text }],
          },
          timestamp,
        },
      ];
    }

    if (item.role === 'developer' || item.role === 'system') {
      return [
        {
          type: 'system',
          message: {
            role: item.role,
            id: item.id,
            sourceLabel: item.role,
            content: [{ type: 'text', text }],
          },
          timestamp,
        },
      ];
    }

    return [];
  }

  private handleReasoning(timestamp: string, item: CodexReasoningItem): SessionEvent[] {
    const summaryTexts = (item.summary || [])
      .filter((s) => s.type === 'summary_text' && s.text)
      .map((s) => s.text);

    if (summaryTexts.length === 0) return [];

    return [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: item.id,
          model: this.currentModel || undefined,
          content: [
            { type: 'thinking', thinking: this.metadataOnly ? '' : summaryTexts.join('\n') },
          ],
        },
        timestamp,
      },
    ];
  }

  private handleFunctionCall(timestamp: string, item: CodexFunctionCallItem): SessionEvent[] {
    let parsedArgs: Record<string, unknown> = {};
    if (!this.metadataOnly) {
      try {
        parsedArgs = JSON.parse(item.arguments);
      } catch {
        parsedArgs = { raw: item.arguments };
      }
    }

    const canonicalName = normalizeCodexToolName(item.name);
    const normalizedInput = normalizeCodexToolInput(canonicalName, item.name, parsedArgs);
    rememberBounded(this.emittedToolUseIds, item.call_id, this.maxTrackedToolCalls);

    return [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: item.id,
          model: this.currentModel || undefined,
          content: [
            {
              type: 'tool_use',
              id: item.call_id,
              name: canonicalName,
              input: this.toolInput(normalizedInput),
            },
          ],
        },
        timestamp,
      },
    ];
  }

  private handleFunctionCallOutput(
    timestamp: string,
    item: CodexFunctionCallOutputItem,
  ): SessionEvent[] {
    const isError = parsePlainTextFailure(item.output);
    return [
      {
        type: 'user',
        message: {
          role: 'user',
          id: `${item.call_id}:result`,
          content: [
            {
              type: 'tool_result',
              tool_use_id: item.call_id,
              content: this.toolOutput(item.output),
              is_error: isError,
            },
          ],
        },
        timestamp,
      },
    ];
  }

  private handleLocalShellCall(timestamp: string, item: CodexLocalShellCallItem): SessionEvent[] {
    const command = item.action?.command?.join(' ') || '';
    rememberBounded(this.emittedToolUseIds, item.call_id, this.maxTrackedToolCalls);
    return [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: item.id,
          model: this.currentModel || undefined,
          content: [
            {
              type: 'tool_use',
              id: item.call_id,
              name: 'Bash',
              input: this.toolInput({
                command,
                workdir: item.action?.workdir,
                _sidekickRawToolName: 'local_shell_call',
              }),
            },
          ],
        },
        timestamp,
      },
    ];
  }

  private handleCustomToolCall(timestamp: string, item: CodexCustomToolCallItem): SessionEvent[] {
    if (item.name === 'apply_patch') {
      const filePaths = extractPatchFilePaths(item.input);
      if (filePaths.length === 0) return [];
      const toolUseIds = filePaths.map((fp) => `${item.call_id}-${fp}`);
      this.putPending(this.patchExpandedToolUseIds, item.call_id, toolUseIds, () =>
        stringBytes(item.call_id, ...toolUseIds),
      );
      for (const id of toolUseIds) {
        rememberBounded(this.emittedToolUseIds, id, this.maxTrackedToolCalls);
      }
      return filePaths.map((fp) => ({
        type: 'assistant' as const,
        message: {
          role: 'assistant' as const,
          id: `${item.call_id}-${fp}`,
          model: this.currentModel || undefined,
          content: [
            {
              type: 'tool_use',
              id: `${item.call_id}-${fp}`,
              name: 'Edit',
              input: this.toolInput({
                file_path: fp,
                _sidekickRawToolName: 'apply_patch',
              }),
            },
          ],
        },
        timestamp,
      }));
    }

    // Generic custom tool
    let parsedInput: Record<string, unknown> = {};
    if (!this.metadataOnly) {
      try {
        parsedInput = JSON.parse(item.input);
      } catch {
        parsedInput = { raw: item.input };
      }
    }

    const canonicalName = normalizeCodexToolName(item.name);
    const normalizedInput = normalizeCodexToolInput(canonicalName, item.name, parsedInput);
    rememberBounded(this.emittedToolUseIds, item.call_id, this.maxTrackedToolCalls);

    return [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: item.call_id,
          model: this.currentModel || undefined,
          content: [
            {
              type: 'tool_use',
              id: item.call_id,
              name: canonicalName,
              input: this.toolInput(normalizedInput),
            },
          ],
        },
        timestamp,
      },
    ];
  }

  private handleCustomToolCallOutput(
    timestamp: string,
    item: CodexCustomToolCallOutputItem,
  ): SessionEvent[] {
    let isError = false;
    let duration: number | undefined;
    try {
      const parsed = JSON.parse(item.output);
      isError = parsed?.metadata?.exit_code !== 0 && parsed?.metadata?.exit_code !== undefined;
      if (parsed?.metadata?.duration_seconds) {
        duration = Math.round(parsed.metadata.duration_seconds * 1000);
      }
    } catch {
      isError = parsePlainTextFailure(item.output);
    }

    const toolUseIds = this.takePending(this.patchExpandedToolUseIds, item.call_id) ?? [
      item.call_id,
    ];
    return toolUseIds.map((toolUseId) => ({
      type: 'user',
      message: {
        role: 'user',
        id: `${toolUseId}:result`,
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: this.toolOutput(item.output),
            is_error: isError,
            duration,
          },
        ],
      },
      timestamp,
    }));
  }

  private handleCompacted(timestamp: string, payload: CodexCompacted): SessionEvent[] {
    return [
      {
        type: 'summary',
        message: {
          role: 'assistant',
          id: `compacted-${timestamp}`,
          content: payload.summary || 'Context compacted',
        },
        timestamp,
        ...reportedCompaction(payload.tokens_before, payload.tokens_after),
      },
    ];
  }

  private handleTurnContext(payload: CodexTurnContext): SessionEvent[] {
    if (payload.model) {
      this.currentModel = payload.model;
    }
    return [];
  }

  private handleEventMsg(timestamp: string, event: CodexEventMsg): SessionEvent[] {
    // payload IS the event directly (no .event wrapper)
    if (!event || !event.type) return [];

    switch (event.type) {
      case 'token_count': {
        const e = event as CodexTokenCountEvent;
        // Store model_context_window if provided (actual limit for current model)
        if (e.info?.model_context_window) {
          this.modelContextWindow = e.info.model_context_window;
        }
        // Store rate_limits if provided (subscription quota data). Codex interleaves
        // multiple families (aggregate "codex" plus per-model ones like codex_bengalfox);
        // keep the latest aggregate sample so a trailing model-specific event at 0% does
        // not mask the plan quota. Fall back to a non-aggregate sample only until an
        // aggregate one has been seen.
        if (e.rate_limits) {
          if (isAggregateCodexLimit(e.rate_limits.limit_id)) {
            this.lastRateLimits = e.rate_limits;
            this.hasAggregateRateLimits = true;
          } else if (!this.hasAggregateRateLimits) {
            this.lastRateLimits = e.rate_limits;
          }
        }
        // Usage data is nested under info (info can be null). Codex repeats an
        // unchanged cumulative total on duplicate events; count each call once.
        const resolved = resolveCodexCallUsage(e.info, this.prevTotalUsage);
        this.prevTotalUsage = resolved.total;
        return this.handleTokenCount(timestamp, resolved.usage, e.rate_limits);
      }

      // agent_message and user_message are suppressed — they duplicate
      // response_item/message events which carry richer metadata (id, content parts, role).

      case 'exec_command_begin': {
        const e = event as CodexExecCommandBeginEvent;
        const pending: PendingExecCommand = this.metadataOnly
          ? { call_id: e.call_id, command: [], timestamp }
          : { call_id: e.call_id, command: e.command, workdir: e.workdir, timestamp };
        this.putPending(this.pendingExecCommands, e.call_id, pending, () =>
          stringBytes(
            pending.call_id,
            pending.workdir,
            pending.timestamp,
            ...(Array.isArray(pending.command) ? pending.command : []),
          ),
        );
        return [];
      }

      case 'exec_command_end': {
        const e = event as CodexExecCommandEndEvent;
        const pending = this.takePending(this.pendingExecCommands, e.call_id);
        const command = pending?.command?.join(' ') || '';
        const events: SessionEvent[] = [];

        if (!this.emittedToolUseIds.has(e.call_id)) {
          rememberBounded(this.emittedToolUseIds, e.call_id, this.maxTrackedToolCalls);
          events.push({
            type: 'assistant',
            message: {
              role: 'assistant',
              id: `exec-${e.call_id}`,
              model: this.currentModel || undefined,
              content: [
                {
                  type: 'tool_use',
                  id: e.call_id,
                  name: 'Bash',
                  input: this.toolInput({
                    command,
                    workdir: pending?.workdir,
                    _sidekickRawToolName: 'exec_command',
                  }),
                },
              ],
            },
            timestamp: pending?.timestamp || timestamp,
          });
        }

        const output = this.metadataOnly
          ? ''
          : [e.stdout, e.stderr].filter(Boolean).join('\n') || '';
        events.push({
          type: 'user',
          message: {
            role: 'user',
            id: `exec-${e.call_id}:result`,
            content: [
              {
                type: 'tool_result',
                tool_use_id: e.call_id,
                content: output,
                is_error: e.exit_code !== 0,
                duration: e.duration_ms,
              },
            ],
          },
          timestamp,
        });

        return events;
      }

      case 'mcp_tool_call_begin': {
        const e = event as CodexMcpToolCallBeginEvent;
        const pending: PendingMcpToolCall = {
          call_id: e.call_id,
          server_name: e.server_name,
          tool_name: e.tool_name,
          arguments: this.metadataOnly ? undefined : e.arguments,
          timestamp,
        };
        this.putPending(
          this.pendingMcpToolCalls,
          e.call_id,
          pending,
          () =>
            stringBytes(pending.call_id, pending.server_name, pending.tool_name, timestamp) +
            approxJsonBytes(pending.arguments),
        );
        return [];
      }

      case 'mcp_tool_call_end': {
        const e = event as CodexMcpToolCallEndEvent;
        const pendingMcp = this.takePending(this.pendingMcpToolCalls, e.call_id);
        const toolName = pendingMcp?.tool_name || 'McpTool';
        const events: SessionEvent[] = [];

        if (!this.emittedToolUseIds.has(e.call_id)) {
          rememberBounded(this.emittedToolUseIds, e.call_id, this.maxTrackedToolCalls);
          events.push({
            type: 'assistant',
            message: {
              role: 'assistant',
              id: `mcp-${e.call_id}`,
              model: this.currentModel || undefined,
              content: [
                {
                  type: 'tool_use',
                  id: e.call_id,
                  name: normalizeCodexToolName(toolName),
                  input: this.toolInput({
                    ...(pendingMcp?.arguments || {}),
                    _sidekickRawToolName: toolName,
                    _sidekickMcpServerName: pendingMcp?.server_name,
                  }),
                },
              ],
            },
            timestamp: pendingMcp?.timestamp || timestamp,
          });
        }

        events.push({
          type: 'user',
          message: {
            role: 'user',
            id: `mcp-${e.call_id}:result`,
            content: [
              {
                type: 'tool_result',
                tool_use_id: e.call_id,
                content: this.toolOutput(e.result || ''),
                is_error: e.is_error || false,
                duration: e.duration_ms,
              },
            ],
          },
          timestamp,
        });

        return events;
      }

      case 'error': {
        const e = event as CodexErrorEvent;
        return [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              id: `error-${timestamp}`,
              model: this.currentModel || undefined,
              content: [
                { type: 'text', text: `[Error${e.code ? ` (${e.code})` : ''}] ${e.message}` },
              ],
            },
            timestamp,
          },
        ];
      }

      case 'context_compacted': {
        const e = event as CodexContextCompactedEvent;
        return [
          {
            type: 'summary',
            message: {
              role: 'assistant',
              id: `ctx-compacted-${timestamp}`,
              content: e.summary || 'Context compacted',
            },
            timestamp,
            ...reportedCompaction(e.tokens_before, e.tokens_after),
          },
        ];
      }

      case 'patch_applied': {
        const e = event as CodexPatchAppliedEvent;
        if (!e.file_path) return [];
        const patchId = `patch-${timestamp}-${e.file_path}`;
        return [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              id: patchId,
              model: this.currentModel || undefined,
              content: [
                {
                  type: 'tool_use',
                  id: patchId,
                  name: 'Edit',
                  input: this.toolInput({
                    file_path: e.file_path,
                    additions: e.additions ?? 0,
                    deletions: e.deletions ?? 0,
                    _sidekickRawToolName: 'patch_applied',
                  }),
                },
              ],
            },
            timestamp,
          },
        ];
      }

      case 'turn_started':
      case 'turn_complete':
      case 'task_started': {
        const collaborationMode = (event as CodexTaskStartedEvent).collaboration_mode_kind;
        if (collaborationMode !== 'plan' || this.inPlanMode) return [];
        this.inPlanMode = true;
        return [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              id: `plan-enter-${timestamp}`,
              model: this.currentModel || undefined,
              content: [
                {
                  type: 'tool_use',
                  id: `plan-enter-${timestamp}`,
                  name: 'EnterPlanMode',
                  input: this.toolInput({
                    source: 'codex_task_started',
                    _sidekickRawToolName: 'task_started',
                  }),
                },
              ],
            },
            timestamp,
          },
        ];
      }

      case 'task_complete':
        if (!this.inPlanMode) return [];
        this.inPlanMode = false;
        return [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              id: `plan-exit-${timestamp}`,
              model: this.currentModel || undefined,
              content: [
                {
                  type: 'tool_use',
                  id: `plan-exit-${timestamp}`,
                  name: 'ExitPlanMode',
                  input: this.toolInput({
                    source: 'codex_task_complete',
                    _sidekickRawToolName: 'task_complete',
                  }),
                },
              ],
            },
            timestamp,
          },
        ];

      case 'turn_aborted':
      case 'agent_reasoning':
      case 'agent_message':
      case 'user_message':
      case 'background':
        return [];

      default:
        return [];
    }
  }

  private handleTokenCount(
    timestamp: string,
    usage: CodexTokenUsage | null,
    rateLimits?: CodexRateLimits | null,
  ): SessionEvent[] {
    const normalizedRateLimits = normalizeRateLimits(rateLimits);
    if (!usage && !normalizedRateLimits) return [];

    const normalizedUsage = usage
      ? normalizeProviderUsage({
          semantics: 'openai',
          provider: 'openai',
          source: 'codex-token-count',
          model: this.currentModel || undefined,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cached_input_tokens,
          reasoningTokens: usage.reasoning_output_tokens,
        })
      : undefined;
    const mappedUsage: MessageUsage | undefined = normalizedUsage
      ? {
          // Codex reports cached_input_tokens as a subset of input_tokens,
          // while MessageUsage categories are disjoint. Normalize once here
          // so aggregation and pricing do not count cached input twice.
          input_tokens: normalizedUsage.uncachedInputTokens,
          output_tokens: normalizedUsage.outputTokens,
          cache_read_input_tokens: normalizedUsage.cacheReadTokens,
          cache_creation_input_tokens: normalizedUsage.cacheWriteTokens,
          reasoning_tokens: normalizedUsage.reasoningTokens,
        }
      : undefined;

    if (usage) {
      this.lastTokenUsage = usage;
    }

    return [
      {
        type: 'system',
        message: {
          role: 'system',
          id: `token-count-${timestamp}`,
          sourceLabel: 'token count',
          model: this.currentModel || undefined,
          usage: mappedUsage,
          normalizedUsage,
          content: [],
        },
        timestamp,
        providerMetadata: { providerId: 'codex', source: 'codex-rollout' },
        rateLimits: normalizedRateLimits,
      },
    ];
  }
}
