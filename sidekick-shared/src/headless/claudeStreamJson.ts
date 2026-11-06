/**
 * Parser for Claude Code's headless output, `claude -p --output-format
 * stream-json` (one SDK message per line).
 *
 * - `system` `init` → `session`; `compact_boundary` → `compaction`;
 *   `status` → `status`; `hook_started` / `hook_progress` /
 *   `hook_response` → `hook`.
 * - `assistant` → `text` (replies and thinking), `tool` (`started`), and a
 *   per-call `usage`. Claude Code writes one record per content block, each
 *   repeating the call's `message.id` and usage, so the stream parser emits
 *   one `call` usage per message id, with the last values seen, once the
 *   next call or the result arrives. An assistant `error` → `error`.
 * - `user` tool results → `tool` (`completed`).
 * - `result` → `usage` (`run`, with `total_cost_usd`) and `result`.
 * - `stream_event` text and thinking deltas → partial `text` (`includePartial`).
 *
 * Usage buckets are disjoint, as the Messages API reports them.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module headless/claudeStreamJson
 */

import { parseMcpToolName } from '../parsers/mcpToolName';
import { classifyTool } from '../toolCategory';
import { createLineSplitter } from './lineSplitter';
import type {
  HeadlessEvent,
  HeadlessParseOptions,
  HeadlessResultEvent,
  HeadlessStreamOptions,
  HeadlessStreamParser,
  HeadlessStreamState,
  HeadlessTokenUsage,
  HeadlessToolEvent,
} from './types';
import { count, nonEmpty, parseJsonObject, record, textOfBlocks } from './values';

const PROVIDER = 'claude-code' as const;
/** Tool names and emitted call ids remembered, oldest forgotten first. */
const MAX_TRACKED_IDS = 4096;

function claudeUsage(value: unknown): HeadlessTokenUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  if (count(usage.input_tokens) === undefined && count(usage.output_tokens) === undefined) {
    return undefined;
  }
  const inputTokens = count(usage.input_tokens) ?? 0;
  const outputTokens = count(usage.output_tokens) ?? 0;
  const cacheReadTokens = count(usage.cache_read_input_tokens) ?? 0;
  const cacheWriteTokens = count(usage.cache_creation_input_tokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_IDS) map.delete(map.keys().next().value as K);
}

interface PendingCall {
  usage: HeadlessTokenUsage;
  model?: string;
}

/** Turns Claude stream-json records into events; one instance per stream. */
class ClaudeTranslator {
  private readonly toolNames = new Map<string, string>();
  /** Calls whose usage waits for the call to end (stream mode only). */
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly countedCalls = new Map<string, true>();
  sessionId?: string;
  model?: string;
  terminal = false;
  resultStatus?: HeadlessResultEvent['status'];
  text?: string;
  runUsage?: HeadlessTokenUsage;

  constructor(
    private readonly options: HeadlessParseOptions,
    /** De-duplicate per-call usage by message id (stream mode). */
    private readonly dedupe: boolean,
  ) {}

  translate(message: unknown): HeadlessEvent[] {
    const row = record(message);
    if (!row) return [];
    switch (row.type) {
      case 'system':
        return this.system(row);
      case 'assistant':
        return this.assistant(row);
      case 'user':
        return this.user(row);
      case 'result':
        return this.result(row);
      case 'stream_event':
        return this.partial(row);
      default:
        return this.unknown(row);
    }
  }

  /** Usage of the calls still waiting, oldest first, except `keep`. */
  flushCalls(keep?: string): HeadlessEvent[] {
    const events: HeadlessEvent[] = [];
    for (const [id, call] of [...this.pendingCalls]) {
      if (id === keep) continue;
      this.pendingCalls.delete(id);
      remember(this.countedCalls, id, true);
      events.push({
        type: 'usage',
        provider: PROVIDER,
        scope: 'call',
        usage: call.usage,
        messageId: id,
        ...(call.model ? { model: call.model } : {}),
      });
    }
    return events;
  }

  private unknown(row: Record<string, unknown>): HeadlessEvent[] {
    return this.options.includeUnknown ? [{ type: 'unknown', provider: PROVIDER, raw: row }] : [];
  }

  private system(row: Record<string, unknown>): HeadlessEvent[] {
    switch (row.subtype) {
      case 'init': {
        this.sessionId = nonEmpty(row.session_id) ?? this.sessionId;
        this.model = nonEmpty(row.model) ?? this.model;
        const tools = Array.isArray(row.tools)
          ? row.tools.filter((tool): tool is string => typeof tool === 'string')
          : undefined;
        const cwd = nonEmpty(row.cwd);
        const version = nonEmpty(row.claude_code_version);
        const permissionMode = nonEmpty(row.permissionMode);
        return [
          {
            type: 'session',
            provider: PROVIDER,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.model ? { model: this.model } : {}),
            ...(cwd ? { cwd } : {}),
            ...(tools ? { tools } : {}),
            ...(version ? { version } : {}),
            ...(permissionMode ? { permissionMode } : {}),
          },
        ];
      }
      case 'compact_boundary': {
        const metadata = record(row.compact_metadata);
        const trigger = nonEmpty(metadata?.trigger);
        const preTokens = count(metadata?.pre_tokens);
        return [
          {
            type: 'compaction',
            provider: PROVIDER,
            ...(trigger ? { trigger } : {}),
            ...(preTokens !== undefined ? { preTokens } : {}),
          },
        ];
      }
      case 'status':
        return [
          {
            type: 'status',
            provider: PROVIDER,
            status: typeof row.status === 'string' ? row.status : null,
          },
        ];
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response': {
        const name = nonEmpty(row.hook_name);
        const event = nonEmpty(row.hook_event);
        const exitCode = Number.isInteger(row.exit_code) ? (row.exit_code as number) : undefined;
        const stdout = nonEmpty(row.stdout);
        const stderr = nonEmpty(row.stderr);
        return [
          {
            type: 'hook',
            provider: PROVIDER,
            phase:
              row.subtype === 'hook_started'
                ? 'started'
                : row.subtype === 'hook_progress'
                  ? 'progress'
                  : 'completed',
            ...(name ? { name } : {}),
            ...(event ? { event } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(stdout ? { stdout } : {}),
            ...(stderr ? { stderr } : {}),
          },
        ];
      }
      default:
        return this.unknown(row);
    }
  }

  private assistant(row: Record<string, unknown>): HeadlessEvent[] {
    const message = record(row.message);
    if (!message) return this.unknown(row);
    const events: HeadlessEvent[] = [];
    const id = nonEmpty(message.id);
    const model = nonEmpty(message.model) ?? this.options.model ?? this.model;
    if (nonEmpty(message.model) && message.model !== '<synthetic>')
      this.model = message.model as string;
    const parentToolUseId = nonEmpty(row.parent_tool_use_id);
    const usage = message.model === '<synthetic>' ? undefined : claudeUsage(message.usage);
    if (usage) {
      if (!this.dedupe || !id) {
        events.push({
          type: 'usage',
          provider: PROVIDER,
          scope: 'call',
          usage,
          ...(model ? { model } : {}),
          ...(id ? { messageId: id } : {}),
        });
      } else {
        // A new call ends the earlier ones; the latest record of a call wins.
        events.push(...this.flushCalls(id));
        if (!this.countedCalls.has(id)) {
          this.pendingCalls.set(id, { usage, ...(model ? { model } : {}) });
        }
      }
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    const errorCode = nonEmpty(row.error);
    if (errorCode) {
      events.push({
        type: 'error',
        provider: PROVIDER,
        scope: 'stream',
        message: textOfBlocks(blocks) || errorCode,
        code: errorCode,
      });
      return events;
    }
    for (const value of blocks) {
      const block = record(value);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        if (!parentToolUseId) this.text = block.text;
        events.push({
          type: 'text',
          provider: PROVIDER,
          kind: 'message',
          text: block.text,
          ...(id ? { messageId: id } : {}),
          ...(parentToolUseId ? { parentToolUseId } : {}),
        });
      } else if (block.type === 'thinking' && nonEmpty(block.thinking)) {
        events.push({
          type: 'text',
          provider: PROVIDER,
          kind: 'reasoning',
          text: block.thinking as string,
          ...(id ? { messageId: id } : {}),
          ...(parentToolUseId ? { parentToolUseId } : {}),
        });
      } else if (block.type === 'tool_use' && nonEmpty(block.id) && nonEmpty(block.name)) {
        const name = block.name as string;
        remember(this.toolNames, block.id as string, name);
        const input = record(block.input);
        const command = name === 'Bash' ? nonEmpty(input?.command) : undefined;
        const mcpServer = parseMcpToolName(name)?.serverName;
        events.push({
          type: 'tool',
          provider: PROVIDER,
          phase: 'started',
          id: block.id as string,
          name,
          category: classifyTool(name),
          input: block.input,
          ...(command ? { command } : {}),
          status: 'in_progress',
          ...(mcpServer ? { mcpServer } : {}),
          ...(parentToolUseId ? { parentToolUseId } : {}),
        });
      }
    }
    return events;
  }

  private user(row: Record<string, unknown>): HeadlessEvent[] {
    const message = record(row.message);
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const parentToolUseId = nonEmpty(row.parent_tool_use_id);
    const events: HeadlessEvent[] = [];
    for (const value of blocks) {
      const block = record(value);
      if (!block || block.type !== 'tool_result' || !nonEmpty(block.tool_use_id)) continue;
      const id = block.tool_use_id as string;
      const name = this.toolNames.get(id);
      const isError = block.is_error === true;
      const output =
        typeof block.content === 'string'
          ? block.content
          : textOfBlocks(Array.isArray(block.content) ? block.content : []);
      const mcpServer = name ? parseMcpToolName(name)?.serverName : undefined;
      const event: HeadlessToolEvent = {
        type: 'tool',
        provider: PROVIDER,
        phase: 'completed',
        id,
        ...(name ? { name } : {}),
        category: name ? classifyTool(name) : 'other',
        ...(output ? { output } : {}),
        status: isError ? 'failed' : 'completed',
        ...(isError ? { isError: true } : {}),
        ...(mcpServer ? { mcpServer } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {}),
      };
      events.push(event);
    }
    return events.length > 0 ? events : this.unknown(row);
  }

  private result(row: Record<string, unknown>): HeadlessEvent[] {
    const events = this.flushCalls();
    this.terminal = true;
    this.sessionId = nonEmpty(row.session_id) ?? this.sessionId;
    const usage = claudeUsage(row.usage);
    const costUsd =
      typeof row.total_cost_usd === 'number' && Number.isFinite(row.total_cost_usd)
        ? row.total_cost_usd
        : undefined;
    if (usage) {
      this.runUsage = usage;
      events.push({
        type: 'usage',
        provider: PROVIDER,
        scope: 'run',
        usage,
        ...(this.model ? { model: this.model } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
    }
    const subtype = nonEmpty(row.subtype);
    const status = subtype === 'success' && row.is_error !== true ? 'success' : 'error';
    this.resultStatus = status;
    const text = typeof row.result === 'string' ? row.result : undefined;
    if (text !== undefined) this.text = text;
    const errors = Array.isArray(row.errors)
      ? row.errors.filter((error): error is string => typeof error === 'string')
      : [];
    const durationMs = count(row.duration_ms);
    const numTurns = count(row.num_turns);
    events.push({
      type: 'result',
      provider: PROVIDER,
      status,
      ...(text !== undefined ? { text } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(subtype ? { subtype } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(numTurns !== undefined ? { numTurns } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    });
    return events;
  }

  private partial(row: Record<string, unknown>): HeadlessEvent[] {
    if (!this.options.includePartial) return [];
    const event = record(row.event);
    const delta = record(event?.delta);
    if (event?.type !== 'content_block_delta' || !delta) return this.unknown(row);
    const parentToolUseId = nonEmpty(row.parent_tool_use_id);
    const text =
      delta.type === 'text_delta'
        ? nonEmpty(delta.text)
        : delta.type === 'thinking_delta'
          ? nonEmpty(delta.thinking)
          : undefined;
    if (!text) return [];
    return [
      {
        type: 'text',
        provider: PROVIDER,
        kind: delta.type === 'text_delta' ? 'message' : 'reasoning',
        text,
        partial: true,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      },
    ];
  }
}

/**
 * The events of one stream-json record. Stateless: per-call usage is
 * reported for every record (the stream parser de-duplicates it), and a
 * tool result does not know its tool's name.
 */
export function parseClaudeStreamMessage(
  message: unknown,
  options: HeadlessParseOptions = {},
): HeadlessEvent[] {
  return new ClaudeTranslator(options, false).translate(message);
}

/** An incremental parser over the stdout of `claude -p --output-format stream-json`. */
export function createClaudeStreamJsonParser(
  options: HeadlessStreamOptions = {},
): HeadlessStreamParser {
  const translator = new ClaudeTranslator(options, true);
  const splitter = createLineSplitter({ maxLineBytes: options.maxLineBytes });
  let nonJsonLines = 0;
  let ended = false;
  const translate = (lines: string[]): HeadlessEvent[] => {
    const events: HeadlessEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseJsonObject(line);
      if (parsed === undefined) nonJsonLines++;
      else events.push(...translator.translate(parsed));
    }
    return events;
  };
  return {
    push(chunk) {
      return ended ? [] : translate(splitter.push(chunk));
    },
    end() {
      if (ended) return [];
      ended = true;
      const events = translate(splitter.end());
      events.push(...translator.flushCalls());
      if (!translator.terminal) {
        translator.resultStatus = 'incomplete';
        events.push({
          type: 'result',
          provider: PROVIDER,
          status: 'incomplete',
          ...(translator.text !== undefined ? { text: translator.text } : {}),
          ...(translator.sessionId ? { sessionId: translator.sessionId } : {}),
        });
      }
      return events;
    },
    state(): HeadlessStreamState {
      return {
        provider: PROVIDER,
        ...(translator.sessionId ? { sessionId: translator.sessionId } : {}),
        ...(translator.model ? { model: translator.model } : {}),
        terminal: translator.terminal,
        ...(translator.resultStatus ? { result: translator.resultStatus } : {}),
        ...(translator.text !== undefined ? { text: translator.text } : {}),
        lines: splitter.lines,
        nonJsonLines,
        oversizedLines: splitter.oversizedLines,
        ...(translator.runUsage ? { runUsage: translator.runUsage } : {}),
      };
    },
  };
}
