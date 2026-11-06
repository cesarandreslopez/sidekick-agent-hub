/**
 * Parser for Codex's headless output, `codex exec --json` (also written
 * `--experimental-json`): one thread event per line.
 *
 * - `thread.started` → `session` (`sessionId` is the thread id that
 *   `codex exec resume` takes); `turn.started` → `status`.
 * - `item.started` / `item.completed` (and `item.updated` with
 *   `includePartial`): agent messages and reasoning → `text`; commands, file
 *   changes, MCP and multi-agent calls, web searches, and to-do lists →
 *   `tool`; error items (warnings, reconnect notices) → `error` (`item`).
 * - `turn.completed` → `usage` and a `success` `result`; `turn.failed` →
 *   `error` (`turn`) and an `error` `result`; `error` → `error` (`stream`).
 *
 * Usage: `turn.completed.usage` is the thread's running total, earlier
 * `exec resume` runs included. It is reported as `thread-total`, and as
 * `run` after subtracting `baselineUsage`. Codex counts cached and
 * cache-written tokens inside `input_tokens` (its uncached input is input
 * minus cached), so the buckets here subtract both; reasoning is inside
 * `output_tokens`.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module headless/codexExecJson
 */

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
  HeadlessToolStatus,
} from './types';
import { count, nonEmpty, parseJsonObject, record, textOfBlocks } from './values';

const PROVIDER = 'codex' as const;

const TOOL_STATUSES: ReadonlySet<string> = new Set([
  'in_progress',
  'completed',
  'failed',
  'declined',
]);

/** A Codex usage object as four disjoint buckets. */
function codexUsage(value: unknown): HeadlessTokenUsage | undefined {
  const usage = record(value);
  if (!usage || count(usage.input_tokens) === undefined) return undefined;
  const input = count(usage.input_tokens) ?? 0;
  const cacheReadTokens = count(usage.cached_input_tokens) ?? 0;
  const cacheWriteTokens = count(usage.cache_write_input_tokens) ?? 0;
  const outputTokens = count(usage.output_tokens) ?? 0;
  const reasoningTokens = count(usage.reasoning_output_tokens);
  const inputTokens = Math.max(0, input - cacheReadTokens - cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

/** `total - baseline`, bucket by bucket, never below zero. */
function subtractUsage(
  total: HeadlessTokenUsage,
  baseline: HeadlessTokenUsage | undefined,
): HeadlessTokenUsage {
  if (!baseline) return total;
  const minus = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') =>
    Math.max(0, total[key] - (count(baseline[key]) ?? 0));
  const inputTokens = minus('inputTokens');
  const outputTokens = minus('outputTokens');
  const cacheReadTokens = minus('cacheReadTokens');
  const cacheWriteTokens = minus('cacheWriteTokens');
  const reasoningTokens =
    total.reasoningTokens !== undefined
      ? Math.max(0, total.reasoningTokens - (count(baseline.reasoningTokens) ?? 0))
      : undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

function withoutType(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  delete copy.type;
  return copy;
}

/** Turns Codex exec JSON events into headless events; one instance per stream. */
class CodexTranslator {
  sessionId?: string;
  terminal = false;
  resultStatus?: HeadlessResultEvent['status'];
  text?: string;
  threadTotal?: HeadlessTokenUsage;
  runUsage?: HeadlessTokenUsage;

  constructor(
    private readonly options: HeadlessParseOptions & { baselineUsage?: HeadlessTokenUsage },
  ) {}

  private unknown(row: Record<string, unknown>): HeadlessEvent[] {
    return this.options.includeUnknown ? [{ type: 'unknown', provider: PROVIDER, raw: row }] : [];
  }

  translate(event: unknown): HeadlessEvent[] {
    const row = record(event);
    if (!row) return [];
    switch (row.type) {
      case 'thread.started': {
        this.sessionId = nonEmpty(row.thread_id) ?? this.sessionId;
        return [
          {
            type: 'session',
            provider: PROVIDER,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.options.model ? { model: this.options.model } : {}),
          },
        ];
      }
      case 'turn.started':
        return [{ type: 'status', provider: PROVIDER, status: 'turn-started' }];
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        if (row.type === 'item.updated' && !this.options.includePartial) return [];
        const item = record(row.item);
        return item ? this.item(row.type, item) : this.unknown(row);
      }
      case 'turn.completed':
        return this.turnCompleted(row);
      case 'turn.failed': {
        this.terminal = true;
        this.resultStatus = 'error';
        const error = record(row.error);
        const message = nonEmpty(error?.message) ?? 'turn failed';
        return [
          {
            type: 'error',
            provider: PROVIDER,
            scope: 'turn',
            message,
            ...(error ? { details: error } : {}),
          },
          {
            type: 'result',
            provider: PROVIDER,
            status: 'error',
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            errors: [message],
          },
        ];
      }
      case 'error':
        return [
          {
            type: 'error',
            provider: PROVIDER,
            scope: 'stream',
            message: nonEmpty(row.message) ?? 'error',
            details: withoutType(row),
          },
        ];
      default:
        return this.unknown(row);
    }
  }

  private turnCompleted(row: Record<string, unknown>): HeadlessEvent[] {
    this.terminal = true;
    this.resultStatus = 'success';
    const events: HeadlessEvent[] = [];
    const total = codexUsage(row.usage);
    const model = this.options.model;
    if (total) {
      this.threadTotal = total;
      this.runUsage = subtractUsage(total, this.options.baselineUsage);
      events.push(
        {
          type: 'usage',
          provider: PROVIDER,
          scope: 'thread-total',
          usage: total,
          ...(model ? { model } : {}),
        },
        {
          type: 'usage',
          provider: PROVIDER,
          scope: 'run',
          usage: this.runUsage,
          ...(model ? { model } : {}),
        },
      );
    }
    events.push({
      type: 'result',
      provider: PROVIDER,
      status: 'success',
      ...(this.text !== undefined ? { text: this.text } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
    return events;
  }

  private item(kind: string, item: Record<string, unknown>): HeadlessEvent[] {
    const id = nonEmpty(item.id) ?? '';
    const phase =
      kind === 'item.started' ? 'started' : kind === 'item.updated' ? 'updated' : 'completed';
    const done = phase === 'completed';
    const status =
      typeof item.status === 'string' && TOOL_STATUSES.has(item.status)
        ? (item.status as HeadlessToolStatus)
        : undefined;
    const tool = (
      name: string,
      fields: Partial<HeadlessToolEvent> = {},
      category = classifyTool(name),
    ): HeadlessEvent[] => [
      {
        type: 'tool',
        provider: PROVIDER,
        phase,
        id,
        name,
        category,
        ...(status ? { status } : {}),
        ...(status === 'failed' ? { isError: true } : {}),
        ...fields,
      },
    ];

    switch (item.type) {
      case 'agent_message': {
        const text = typeof item.text === 'string' ? item.text : undefined;
        if (text === undefined) return [];
        if (done) this.text = text;
        return [
          {
            type: 'text',
            provider: PROVIDER,
            kind: 'message',
            text,
            ...(done ? {} : { partial: true as const }),
            ...(id ? { messageId: id } : {}),
          },
        ];
      }
      case 'reasoning': {
        const text = nonEmpty(item.text);
        if (!text) return [];
        return [
          {
            type: 'text',
            provider: PROVIDER,
            kind: 'reasoning',
            text,
            ...(done ? {} : { partial: true as const }),
            ...(id ? { messageId: id } : {}),
          },
        ];
      }
      case 'command_execution': {
        const command = nonEmpty(item.command);
        const output = nonEmpty(item.aggregated_output);
        const exitCode = Number.isInteger(item.exit_code) ? (item.exit_code as number) : undefined;
        return tool('exec_command', {
          ...(command ? { command, input: { command } } : {}),
          ...(output ? { output } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(status === 'failed' || (done && exitCode !== undefined && exitCode !== 0)
            ? { isError: true }
            : {}),
        });
      }
      case 'file_change':
        return tool(
          'apply_patch',
          Array.isArray(item.changes) ? { input: { changes: item.changes } } : {},
        );
      case 'mcp_tool_call': {
        const name = nonEmpty(item.tool) ?? 'mcp_tool';
        const server = nonEmpty(item.server);
        const result = record(item.result);
        const error = record(item.error);
        const output =
          nonEmpty(error?.message) ??
          (Array.isArray(result?.content) ? textOfBlocks(result.content) : '');
        return tool(
          name,
          {
            ...(item.arguments !== undefined ? { input: item.arguments } : {}),
            ...(output ? { output } : {}),
            ...(server ? { mcpServer: server } : {}),
            ...(error ? { isError: true } : {}),
          },
          'mcp',
        );
      }
      case 'collab_tool_call': {
        const name = nonEmpty(item.tool) ?? 'collab_tool';
        return tool(
          name,
          {
            input: {
              ...(item.prompt !== undefined ? { prompt: item.prompt } : {}),
              ...(Array.isArray(item.receiver_thread_ids)
                ? { receiverThreadIds: item.receiver_thread_ids }
                : {}),
            },
          },
          'subagent',
        );
      }
      case 'web_search':
        return tool('web_search', {
          input: {
            ...(item.query !== undefined ? { query: item.query } : {}),
            ...(item.action !== undefined ? { action: item.action } : {}),
          },
        });
      case 'todo_list':
        return tool(
          'update_plan',
          Array.isArray(item.items) ? { input: { items: item.items } } : {},
        );
      case 'error':
        return [
          {
            type: 'error',
            provider: PROVIDER,
            scope: 'item',
            message: nonEmpty(item.message) ?? 'error',
            details: item,
          },
        ];
      default:
        return this.options.includeUnknown
          ? [{ type: 'unknown', provider: PROVIDER, raw: { type: kind, item } }]
          : [];
    }
  }
}

/** The events of one `codex exec --json` event. Stateless: usage has no baseline. */
export function parseCodexExecEvent(
  event: unknown,
  options: HeadlessParseOptions = {},
): HeadlessEvent[] {
  return new CodexTranslator(options).translate(event);
}

/** An incremental parser over the stdout of `codex exec --json`. */
export function createCodexExecJsonParser(
  options: HeadlessStreamOptions = {},
): HeadlessStreamParser {
  const translator = new CodexTranslator(options);
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
        ...(options.model ? { model: options.model } : {}),
        terminal: translator.terminal,
        ...(translator.resultStatus ? { result: translator.resultStatus } : {}),
        ...(translator.text !== undefined ? { text: translator.text } : {}),
        lines: splitter.lines,
        nonJsonLines,
        oversizedLines: splitter.oversizedLines,
        ...(translator.threadTotal ? { threadTotal: translator.threadTotal } : {}),
        ...(translator.runUsage ? { runUsage: translator.runUsage } : {}),
      };
    },
  };
}
