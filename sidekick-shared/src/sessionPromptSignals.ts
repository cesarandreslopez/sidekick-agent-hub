/**
 * What the human-prompt filter leaves out of a session, for consumers that
 * classify a whole session: the agent's reply to each prompt and timestamped
 * interaction signals (interrupts, rejected or failed tools, compactions, API
 * errors, rollbacks). Pure: log records in, results out; no file system access.
 *
 * Records reach an extractor after the prompt scanner has seen them, with the
 * ordinal of the latest human prompt, so replies and signals share the prompt
 * ordinals of `collectPromptHistory()`.
 */

import type { PromptHistoryProvider } from './promptHistory';

export type PromptHistorySignalKind =
  | 'interrupt'
  | 'toolRejected'
  | 'toolError'
  | 'compaction'
  | 'apiError'
  | 'rollback';

export interface PromptHistorySignal {
  kind: PromptHistorySignalKind;
  /** ISO timestamp from the log line; never synthesized. */
  timestamp: string;
  /** Ordinal of the human prompt this followed, or -1 before the first prompt. */
  afterOrdinal: number;
  /** The tool involved, for `toolRejected` and `toolError`, when the log names it. */
  tool?: string;
  /**
   * `toolRejected`: the reason the person typed, untruncated. `toolError` and
   * `apiError`: the error text, cut to 1024 characters (`textTruncated`).
   */
  text?: string;
  textTruncated?: true;
}

export interface PromptHistoryReply {
  /** The agent's last text for the prompt's turn, untruncated. */
  text: string;
  /** ISO timestamp of the log line that carried the reply. */
  timestamp: string;
}

export interface SessionRecordInclude {
  signals: boolean;
  replies: boolean;
}

export interface SessionRecordExtraction {
  /** Earliest timestamp on any record. */
  firstTimestamp?: string;
  /** Latest timestamp on any record. */
  lastTimestamp?: string;
  signals: PromptHistorySignal[];
  /** Keyed by prompt ordinal. */
  replies: Map<number, PromptHistoryReply>;
}

export interface SessionRecordExtractor {
  observe(record: Record<string, unknown>, info: { ordinal: number; lineOffset: number }): void;
  result(): SessionRecordExtraction;
}

/** Error text kept on a signal; tool output can be arbitrarily long. */
export const SIGNAL_TEXT_CHARS = 1024;

const CLAUDE_REJECTED_PREFIX = "The user doesn't want to proceed with this tool use";
const CLAUDE_REJECTION_REASON = /the user said:\s*([\s\S]*)$/;
const CLAUDE_INTERRUPT_PREFIX = '[Request interrupted by user';
const CLAUDE_TOOL_USE_INTERRUPT = '[Request interrupted by user for tool use]';

export function createSessionRecordExtractor(
  provider: PromptHistoryProvider,
  include: SessionRecordInclude,
): SessionRecordExtractor {
  return provider === 'claude-code'
    ? new ClaudeRecordExtractor(include)
    : new CodexRecordExtractor(include);
}

/** Timestamps, signal bookkeeping, and reply slots shared by both providers. */
abstract class RecordExtractor implements SessionRecordExtractor {
  private firstMs = Infinity;
  private lastMs = -Infinity;
  private firstTimestamp: string | undefined;
  private lastTimestamp: string | undefined;
  protected readonly signals: PromptHistorySignal[] = [];
  protected readonly replies = new Map<number, PromptHistoryReply>();

  constructor(protected readonly include: SessionRecordInclude) {}

  observe(record: Record<string, unknown>, info: { ordinal: number; lineOffset: number }): void {
    const timestamp = validTimestamp(record.timestamp);
    if (timestamp) {
      const ms = Date.parse(timestamp);
      if (ms < this.firstMs) {
        this.firstMs = ms;
        this.firstTimestamp = timestamp;
      }
      if (ms > this.lastMs) {
        this.lastMs = ms;
        this.lastTimestamp = timestamp;
      }
    }
    this.accept(record, timestamp, info.ordinal, info.lineOffset);
  }

  protected abstract accept(
    record: Record<string, unknown>,
    timestamp: string | undefined,
    ordinal: number,
    lineOffset: number,
  ): void;

  result(): SessionRecordExtraction {
    return {
      ...(this.firstTimestamp ? { firstTimestamp: this.firstTimestamp } : {}),
      ...(this.lastTimestamp ? { lastTimestamp: this.lastTimestamp } : {}),
      signals: [...this.signals],
      replies: new Map(this.replies),
    };
  }

  protected signal(
    kind: PromptHistorySignalKind,
    timestamp: string | undefined,
    ordinal: number,
    detail: { tool?: string; text?: string; fullText?: string } = {},
  ): void {
    if (!this.include.signals || !timestamp) return;
    const signal: PromptHistorySignal = { kind, timestamp, afterOrdinal: ordinal };
    if (detail.tool) signal.tool = detail.tool;
    if (detail.fullText) {
      signal.text = detail.fullText;
    } else if (detail.text?.trim()) {
      const text = detail.text.trim();
      if (text.length > SIGNAL_TEXT_CHARS) {
        signal.text = detachedPrefix(text, SIGNAL_TEXT_CHARS);
        signal.textTruncated = true;
      } else {
        signal.text = text;
      }
    }
    this.signals.push(signal);
  }
}

class ClaudeRecordExtractor extends RecordExtractor {
  private readonly toolNames = new Map<string, string>();
  /** The reply being assembled: split records of one message share an id. */
  private reply: { ordinal: number; id: string; parts: string[]; timestamp: string } | null = null;
  /**
   * A rejection without a reason is always followed by a
   * `[Request interrupted by user for tool use]` record; it is one action.
   */
  private rejectionAwaitingInterrupt = false;
  private lastOrdinal = -1;

  protected accept(
    record: Record<string, unknown>,
    timestamp: string | undefined,
    ordinal: number,
    lineOffset: number,
  ): void {
    if (record.isSidechain === true) return;
    if (ordinal !== this.lastOrdinal) {
      this.lastOrdinal = ordinal;
      this.rejectionAwaitingInterrupt = false;
    }
    if (record.type === 'system') {
      if (record.subtype === 'compact_boundary') this.signal('compaction', timestamp, ordinal);
      return;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (typeof message !== 'object' || message === null) return;
    const blocks = contentBlocks(message.content);

    if (record.type === 'assistant') {
      this.rejectionAwaitingInterrupt = false;
      for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = stringValue(block.name);
          if (name) this.toolNames.set(block.id, name);
        }
      }
      if (record.isApiErrorMessage === true) {
        this.signal('apiError', timestamp, ordinal, { text: blockText(blocks) });
        return;
      }
      if (message.model === '<synthetic>') return;
      this.recordReply(blocks, stringValue(message.id) ?? `line:${lineOffset}`, timestamp, ordinal);
      return;
    }

    if (record.type !== 'user') return;
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (!text.startsWith(CLAUDE_INTERRUPT_PREFIX)) continue;
        const paired =
          text.startsWith(CLAUDE_TOOL_USE_INTERRUPT) && this.rejectionAwaitingInterrupt;
        this.rejectionAwaitingInterrupt = false;
        if (!paired) this.signal('interrupt', timestamp, ordinal);
      } else if (block.type === 'tool_result' && block.is_error === true) {
        const text = toolResultText(block.content);
        const tool =
          typeof block.tool_use_id === 'string' ? this.toolNames.get(block.tool_use_id) : undefined;
        if (text.startsWith(CLAUDE_REJECTED_PREFIX)) {
          const reason = text.match(CLAUDE_REJECTION_REASON)?.[1].trim();
          this.signal('toolRejected', timestamp, ordinal, { tool, fullText: reason || undefined });
          this.rejectionAwaitingInterrupt = !reason;
        } else {
          this.signal('toolError', timestamp, ordinal, { tool, text });
        }
      }
    }
  }

  private recordReply(
    blocks: Record<string, unknown>[],
    id: string,
    timestamp: string | undefined,
    ordinal: number,
  ): void {
    if (!this.include.replies || ordinal < 0 || !timestamp) return;
    const text = blockText(blocks);
    if (!text.trim()) return;
    const current = this.reply;
    if (current && current.ordinal === ordinal && current.id === id) {
      current.parts.push(text);
    } else {
      this.reply = { ordinal, id, parts: [text], timestamp };
    }
    const reply = this.reply!;
    this.replies.set(ordinal, { text: reply.parts.join('\n'), timestamp: reply.timestamp });
  }
}

class CodexRecordExtractor extends RecordExtractor {
  /** Ordinals whose reply came from `task_complete`, which later fallbacks do not replace. */
  private readonly finalReplies = new Set<number>();

  protected accept(
    record: Record<string, unknown>,
    timestamp: string | undefined,
    ordinal: number,
  ): void {
    // Every compaction writes one top-level `compacted` record; the matching
    // event or item exists only in some Codex versions, so it is not counted.
    if (record.type === 'compacted') {
      this.signal('compaction', timestamp, ordinal);
      return;
    }
    const payload = record.payload as Record<string, unknown> | undefined;
    if (typeof payload !== 'object' || payload === null) return;

    if (record.type === 'response_item') {
      if (payload.type === 'message' && payload.role === 'assistant') {
        this.fallbackReply(blockText(contentBlocks(payload.content)), timestamp, ordinal);
      }
      return;
    }
    if (record.type !== 'event_msg') return;

    switch (payload.type) {
      case 'turn_aborted':
        this.signal('interrupt', timestamp, ordinal);
        break;
      case 'thread_rolled_back':
        this.signal('rollback', timestamp, ordinal);
        break;
      case 'task_complete': {
        const last = stringValue(payload.last_agent_message);
        if (last?.trim() && this.include.replies && ordinal >= 0 && timestamp) {
          this.replies.set(ordinal, { text: last, timestamp });
          this.finalReplies.add(ordinal);
        }
        if (payload.error !== undefined && payload.error !== null) {
          this.signal('apiError', timestamp, ordinal, { text: errorText(payload.error) });
        }
        break;
      }
      case 'error':
        this.signal('apiError', timestamp, ordinal, { text: errorText(payload) });
        break;
      case 'agent_message':
        this.fallbackReply(stringValue(payload.message) ?? '', timestamp, ordinal);
        break;
      case 'exec_command_end':
        if (payload.status === 'failed' || nonZero(payload.exit_code)) {
          this.signal('toolError', timestamp, ordinal, {
            tool: 'exec_command',
            text: commandText(payload),
          });
        }
        break;
      case 'patch_apply_end':
        if (payload.success === false) {
          this.signal('toolError', timestamp, ordinal, {
            tool: 'apply_patch',
            text: stringValue(payload.stderr) || stringValue(payload.stdout),
          });
        }
        break;
      case 'mcp_tool_call_end': {
        const invocation = payload.invocation as Record<string, unknown> | undefined;
        const failure = mcpFailure(payload.result);
        if (failure !== null) {
          this.signal('toolError', timestamp, ordinal, {
            tool: invocation ? stringValue(invocation.tool) : undefined,
            text: failure,
          });
        }
        break;
      }
      case 'item_completed':
        this.acceptItem(payload.item, timestamp, ordinal);
        break;
    }
  }

  private acceptItem(item: unknown, timestamp: string | undefined, ordinal: number): void {
    if (typeof item !== 'object' || item === null) return;
    const row = item as Record<string, unknown>;
    const failed = row.status === 'failed';
    switch (row.type) {
      case 'AgentMessage':
        this.fallbackReply(blockText(contentBlocks(row.content)), timestamp, ordinal);
        break;
      case 'CommandExecution':
        if (failed) {
          this.signal('toolError', timestamp, ordinal, {
            tool: 'exec_command',
            text: commandText(row),
          });
        }
        break;
      case 'FileChange':
        if (failed) {
          this.signal('toolError', timestamp, ordinal, {
            tool: 'apply_patch',
            text: stringValue(row.stderr) || stringValue(row.stdout),
          });
        }
        break;
      case 'McpToolCall':
        if (failed) {
          this.signal('toolError', timestamp, ordinal, {
            tool: stringValue(row.tool),
            text:
              row.error !== undefined && row.error !== null
                ? errorText(row.error)
                : (mcpFailure(row.result) ?? undefined),
          });
        }
        break;
    }
  }

  /** The latest agent text of the turn, until `task_complete` settles it. */
  private fallbackReply(text: string, timestamp: string | undefined, ordinal: number): void {
    if (!this.include.replies || ordinal < 0 || !timestamp || !text.trim()) return;
    if (this.finalReplies.has(ordinal)) return;
    this.replies.set(ordinal, { text, timestamp });
  }
}

/**
 * The first `chars` UTF-16 units of `text` as a new string. A plain slice can
 * keep the whole source string alive (V8 sliced strings), which for a tool's
 * output may be megabytes per signal. A surrogate pair is never split.
 */
function detachedPrefix(text: string, chars: number): string {
  const end = /[\uD800-\uDBFF]/.test(text.charAt(chars - 1)) ? chars - 1 : chars;
  return Buffer.from(text.slice(0, end), 'utf8').toString('utf8');
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
  );
}

/** Text of text-like blocks: Claude `text`, Codex `output_text`, Codex item `Text`. */
function blockText(blocks: Record<string, unknown>[]): string {
  return blocks
    .filter(
      (block) =>
        (block.type === 'text' || block.type === 'output_text' || block.type === 'Text') &&
        typeof block.text === 'string',
    )
    .map((block) => block.text as string)
    .join('\n');
}

function toolResultText(content: unknown): string {
  return blockText(contentBlocks(content)).trim();
}

function nonZero(value: unknown): boolean {
  return typeof value === 'number' && value !== 0;
}

/** A failed command as `$ <command>` plus its output. */
function commandText(row: Record<string, unknown>): string {
  const command = Array.isArray(row.command)
    ? row.command.filter((part): part is string => typeof part === 'string').at(-1)
    : stringValue(row.command);
  const output =
    stringValue(row.aggregated_output) ?? stringValue(row.stderr) ?? stringValue(row.stdout) ?? '';
  return command ? `$ ${command}\n${output}` : output;
}

function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return undefined;
  return stringValue((error as Record<string, unknown>).message);
}

/** The failure text of an MCP call result, or null when it succeeded. */
function mcpFailure(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const row = result as Record<string, unknown>;
  if ('Err' in row) return typeof row.Err === 'string' ? row.Err : (errorText(row.Err) ?? '');
  const ok = (row.Ok ?? row) as Record<string, unknown>;
  if (typeof ok !== 'object' || ok === null || ok.isError !== true) return null;
  return blockText(contentBlocks(ok.content));
}
