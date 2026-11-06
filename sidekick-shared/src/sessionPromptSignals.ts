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

import { parseMcpToolName } from './parsers/mcpToolName';
import type { PromptHistoryProvider } from './promptHistory';
import { classifyTool, type ToolCategory } from './toolCategory';

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
  /** What `tool` does (`shell`, `file_edit`, `mcp`, …), from `classifyTool()`. */
  toolCategory?: ToolCategory;
  /**
   * The MCP server of an MCP tool call: from `mcp__<server>__<tool>` names
   * (Claude Code) or the call's own server field (Codex, whose `tool` is the
   * bare tool name).
   */
  mcpServer?: string;
  /**
   * `toolRejected`: the reason the person typed, untruncated (unless
   * `signalLimits.maxBytes` caps it). `toolError` and `apiError`: the error
   * text, cut to `signalLimits.textChars` (default 1024) characters
   * (`textTruncated`). For a failed command it is
   * `$ <command head>[ …]\n[… ]<output tail>`: the start of the command and
   * the end of its output, where the error usually is.
   */
  text?: string;
  textTruncated?: true;
  /**
   * The command a failed or declined Codex command call ran: a shell
   * wrapper's script (`bash -lc <script>`, `pwsh -Command …`, `cmd /c …`),
   * else the argv joined with shell quoting. Its start is kept, up to
   * `signalLimits.commandChars` (default 1024) characters.
   */
  command?: string;
  commandTruncated?: true;
  /**
   * The failed command's output (`aggregated_output`, else stderr, else
   * stdout). Its end is kept, up to `signalLimits.outputChars` (default
   * 1024) characters.
   */
  output?: string;
  outputTruncated?: true;
  /** The failed command's exit code, when the log records an integer one. */
  exitCode?: number;
  /**
   * The tool call the signal is about: Claude Code's `tool_use_id`, Codex's
   * `call_id` or completed-item id (the ids `findToolCallOrigins()` takes).
   */
  toolUseId?: string;
}

/**
 * Size limits for the text a signal keeps. Character limits count UTF-16
 * units; `maxBytes` additionally caps each of `text`, `command`, and
 * `output` at that many UTF-8 bytes (off by default). Cuts never split a
 * surrogate pair, and kept text is copied so a signal never pins a large
 * source string in memory.
 */
export interface SessionPromptSignalLimits {
  /** Default `SIGNAL_TEXT_CHARS` (1024). */
  textChars?: number;
  /** Default `SIGNAL_COMMAND_CHARS` (1024). */
  commandChars?: number;
  /** Default `SIGNAL_OUTPUT_CHARS` (1024). */
  outputChars?: number;
  /** UTF-8 byte cap per text field. Default: none. */
  maxBytes?: number;
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

/** Error text kept on a signal by default; tool output can be arbitrarily long. */
export const SIGNAL_TEXT_CHARS = 1024;
/** Characters of a failed command kept on a signal by default (its start). */
export const SIGNAL_COMMAND_CHARS = 1024;
/** Characters of a failed command's output kept on a signal by default (its end). */
export const SIGNAL_OUTPUT_CHARS = 1024;

/** Longest command head inside a command-backed signal's `text`. */
const TEXT_COMMAND_CHARS = 256;
/** Marks a cut: after a command head, before an output tail. */
const ELLIPSIS = '\u2026';

interface ResolvedSignalLimits {
  textChars: number;
  commandChars: number;
  outputChars: number;
  maxBytes: number;
}

function resolveSignalLimits(limits: SessionPromptSignalLimits | undefined): ResolvedSignalLimits {
  const size = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && value >= 1 ? Math.floor(value) : fallback;
  return {
    textChars: size(limits?.textChars, SIGNAL_TEXT_CHARS),
    commandChars: size(limits?.commandChars, SIGNAL_COMMAND_CHARS),
    outputChars: size(limits?.outputChars, SIGNAL_OUTPUT_CHARS),
    maxBytes: size(limits?.maxBytes, Infinity),
  };
}

const CLAUDE_REJECTED_PREFIX = "The user doesn't want to proceed with this tool use";
const CLAUDE_REJECTION_REASON = /the user said:\s*([\s\S]*)$/;
const CLAUDE_INTERRUPT_PREFIX = '[Request interrupted by user';
const CLAUDE_TOOL_USE_INTERRUPT = '[Request interrupted by user for tool use]';

export function createSessionRecordExtractor(
  provider: PromptHistoryProvider,
  include: SessionRecordInclude,
  limits?: SessionPromptSignalLimits,
): SessionRecordExtractor {
  const resolved = resolveSignalLimits(limits);
  return provider === 'claude-code'
    ? new ClaudeRecordExtractor(include, resolved)
    : new CodexRecordExtractor(include, resolved);
}

/** Timestamps, signal bookkeeping, and reply slots shared by both providers. */
abstract class RecordExtractor implements SessionRecordExtractor {
  private firstMs = Infinity;
  private lastMs = -Infinity;
  private firstTimestamp: string | undefined;
  private lastTimestamp: string | undefined;
  protected readonly signals: PromptHistorySignal[] = [];
  protected readonly replies = new Map<number, PromptHistoryReply>();

  constructor(
    protected readonly include: SessionRecordInclude,
    private readonly limits: ResolvedSignalLimits,
  ) {}

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
    detail: {
      tool?: string;
      /** The log records this as an MCP call, with or without a server name. */
      mcp?: boolean;
      mcpServer?: string;
      text?: string;
      fullText?: string;
      /** A command call: `text` is built from its command and output. */
      execution?: CommandExecution;
      toolUseId?: string;
    } = {},
  ): void {
    if (!this.include.signals || !timestamp) return;
    const signal: PromptHistorySignal = { kind, timestamp, afterOrdinal: ordinal };
    if (detail.tool) signal.tool = detail.tool;
    if (detail.tool || detail.mcp) {
      const mcpServer =
        detail.mcpServer || (detail.tool ? parseMcpToolName(detail.tool)?.serverName : undefined);
      signal.toolCategory =
        detail.mcp || !detail.tool ? 'mcp' : classifyTool(detail.tool, { mcpServer });
      if (mcpServer) signal.mcpServer = mcpServer;
    }
    const { textChars, maxBytes } = this.limits;
    if (detail.execution) {
      this.describeExecution(signal, detail.execution);
    } else if (detail.fullText) {
      setText(signal, clipHead(detail.fullText, Infinity, maxBytes));
    } else if (detail.text?.trim()) {
      setText(signal, clipHead(detail.text.trim(), textChars, maxBytes));
    }
    if (detail.toolUseId) signal.toolUseId = detail.toolUseId;
    this.signals.push(signal);
  }

  /** `command`, `output`, `exitCode`, and the combined `text` of a command call. */
  private describeExecution(signal: PromptHistorySignal, execution: CommandExecution): void {
    const { textChars, commandChars, outputChars, maxBytes } = this.limits;
    const command = execution.command;
    const output = execution.output?.trim() || undefined;
    if (command) {
      const kept = clipHead(command, commandChars, maxBytes);
      signal.command = kept.value;
      if (kept.truncated) signal.commandTruncated = true;
    }
    if (output) {
      const kept = clipTail(output, outputChars, maxBytes);
      signal.output = kept.value;
      if (kept.truncated) signal.outputTruncated = true;
    }
    if (execution.exitCode !== undefined) signal.exitCode = execution.exitCode;
    const text = executionText(command, output, textChars, maxBytes);
    if (text) setText(signal, text);
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
        const toolUseId = stringValue(block.tool_use_id);
        const tool = toolUseId ? this.toolNames.get(toolUseId) : undefined;
        if (text.startsWith(CLAUDE_REJECTED_PREFIX)) {
          const reason = text.match(CLAUDE_REJECTION_REASON)?.[1].trim();
          this.signal('toolRejected', timestamp, ordinal, {
            tool,
            fullText: reason || undefined,
            toolUseId,
          });
          this.rejectionAwaitingInterrupt = !reason;
        } else {
          this.signal('toolError', timestamp, ordinal, { tool, text, toolUseId });
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
        this.acceptExecution(payload, stringValue(payload.call_id), timestamp, ordinal);
        break;
      case 'patch_apply_end':
        if (payload.status === 'declined') {
          this.signal('toolRejected', timestamp, ordinal, {
            tool: 'apply_patch',
            toolUseId: stringValue(payload.call_id),
          });
        } else if (payload.success === false) {
          this.signal('toolError', timestamp, ordinal, {
            tool: 'apply_patch',
            text: stringValue(payload.stderr) || stringValue(payload.stdout),
            toolUseId: stringValue(payload.call_id),
          });
        }
        break;
      case 'mcp_tool_call_end': {
        const invocation = payload.invocation as Record<string, unknown> | undefined;
        const failure = mcpFailure(payload.result);
        if (failure !== null) {
          this.signal('toolError', timestamp, ordinal, {
            tool: invocation ? stringValue(invocation.tool) : undefined,
            mcp: true,
            mcpServer: invocation ? stringValue(invocation.server) : undefined,
            text: failure,
            toolUseId: stringValue(payload.call_id),
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
    const toolUseId = stringValue(row.id);
    switch (row.type) {
      case 'AgentMessage':
        this.fallbackReply(blockText(contentBlocks(row.content)), timestamp, ordinal);
        break;
      case 'CommandExecution':
        if (failed || row.status === 'declined') {
          this.acceptExecution(row, toolUseId, timestamp, ordinal);
        }
        break;
      case 'FileChange':
        if (row.status === 'declined') {
          this.signal('toolRejected', timestamp, ordinal, { tool: 'apply_patch', toolUseId });
        } else if (failed) {
          this.signal('toolError', timestamp, ordinal, {
            tool: 'apply_patch',
            text: stringValue(row.stderr) || stringValue(row.stdout),
            toolUseId,
          });
        }
        break;
      case 'McpToolCall':
        if (failed) {
          this.signal('toolError', timestamp, ordinal, {
            tool: stringValue(row.tool),
            mcp: true,
            mcpServer: stringValue(row.server),
            text:
              row.error !== undefined && row.error !== null
                ? errorText(row.error)
                : (mcpFailure(row.result) ?? undefined),
            toolUseId,
          });
        }
        break;
    }
  }

  /**
   * A finished command call (`exec_command_end` event or `CommandExecution`
   * item): one the person declined is `toolRejected`; one that failed or
   * exited non-zero is `toolError`.
   */
  private acceptExecution(
    row: Record<string, unknown>,
    toolUseId: string | undefined,
    timestamp: string | undefined,
    ordinal: number,
  ): void {
    const command = commandOf(row.command);
    if (row.status === 'declined') {
      this.signal('toolRejected', timestamp, ordinal, {
        tool: 'exec_command',
        execution: { command },
        toolUseId,
      });
      return;
    }
    if (row.status !== 'failed' && !nonZero(row.exit_code)) return;
    this.signal('toolError', timestamp, ordinal, {
      tool: 'exec_command',
      execution: {
        command,
        output:
          stringValue(row.aggregated_output) ?? stringValue(row.stderr) ?? stringValue(row.stdout),
        exitCode: Number.isInteger(row.exit_code) ? (row.exit_code as number) : undefined,
      },
      toolUseId,
    });
  }

  /** The latest agent text of the turn, until `task_complete` settles it. */
  private fallbackReply(text: string, timestamp: string | undefined, ordinal: number): void {
    if (!this.include.replies || ordinal < 0 || !timestamp || !text.trim()) return;
    if (this.finalReplies.has(ordinal)) return;
    this.replies.set(ordinal, { text, timestamp });
  }
}

/** What a command call ran and printed, before any limit is applied. */
interface CommandExecution {
  command?: string;
  output?: string;
  exitCode?: number;
}

interface Clipped {
  value: string;
  truncated: boolean;
}

function setText(signal: PromptHistorySignal, text: Clipped): void {
  signal.text = text.value;
  if (text.truncated) signal.textTruncated = true;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 width of the BMP unit `code` (a lone surrogate encodes as U+FFFD). */
function unitBytes(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
}

/**
 * How many UTF-16 units from the start of `text` fit in `chars` units and
 * `bytes` UTF-8 bytes without splitting a surrogate pair. Looks at no more
 * than `min(chars, bytes)` units.
 */
function headLength(text: string, chars: number, bytes: number): number {
  const limit = Math.min(text.length, Math.max(0, chars));
  if (bytes === Infinity) {
    if (limit >= text.length) return text.length;
    return limit > 0 && isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
  }
  let used = 0;
  let index = 0;
  while (index < limit) {
    const code = text.charCodeAt(index);
    const pair =
      isHighSurrogate(code) &&
      index + 1 < text.length &&
      isLowSurrogate(text.charCodeAt(index + 1));
    const units = pair ? 2 : 1;
    const width = pair ? 4 : unitBytes(code);
    if (index + units > limit || used + width > bytes) break;
    used += width;
    index += units;
  }
  return index;
}

/** Where the longest suffix of `text` that fits `chars` units and `bytes` bytes starts. */
function tailStart(text: string, chars: number, bytes: number): number {
  const limit = Math.min(text.length, Math.max(0, chars));
  if (bytes === Infinity) {
    if (limit >= text.length) return 0;
    const start = text.length - limit;
    return limit > 0 && isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
  }
  let used = 0;
  let kept = 0;
  let index = text.length;
  while (kept < limit) {
    const code = text.charCodeAt(index - 1);
    const pair = isLowSurrogate(code) && index >= 2 && isHighSurrogate(text.charCodeAt(index - 2));
    const units = pair ? 2 : 1;
    const width = pair ? 4 : unitBytes(code);
    if (kept + units > limit || used + width > bytes) break;
    used += width;
    kept += units;
    index -= units;
  }
  return index;
}

/**
 * A copy of `text`. A plain slice can keep the whole source string alive
 * (V8 sliced strings), which for a tool's output may be megabytes per signal.
 */
function detached(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8');
}

/** The start of `text` within the limits, copied when cut. */
function clipHead(text: string, chars: number, bytes: number): Clipped {
  const end = headLength(text, chars, bytes);
  return end >= text.length
    ? { value: text, truncated: false }
    : { value: detached(text.slice(0, end)), truncated: true };
}

/** The end of `text` within the limits, copied when cut. */
function clipTail(text: string, chars: number, bytes: number): Clipped {
  const start = tailStart(text, chars, bytes);
  return start <= 0
    ? { value: text, truncated: false }
    : { value: detached(text.slice(start)), truncated: true };
}

/**
 * The last `chars` UTF-16 units of `text` (fewer rather than split a
 * surrogate pair), copied out of the source string when cut.
 */
export function detachedSuffix(text: string, chars: number): string {
  return clipTail(text, chars, Infinity).value;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * `$ <command head>[ …]\n[… ]<output tail>` within `chars` and `bytes`: the
 * command keeps at most `min(256, chars / 4)` characters (and a quarter of
 * the bytes), the output tail the rest.
 */
function executionText(
  command: string | undefined,
  output: string | undefined,
  chars: number,
  bytes: number,
): Clipped | undefined {
  if (!command) return output ? markedTail(output, chars, bytes) : undefined;
  const commandChars = Math.min(TEXT_COMMAND_CHARS, Math.floor(chars / 4));
  const commandBytes = bytes === Infinity ? Infinity : Math.floor(bytes / 4);
  let head = command;
  let truncated = false;
  if (headLength(command, commandChars, commandBytes) < command.length) {
    const marker = ` ${ELLIPSIS}`;
    const end = headLength(
      command,
      commandChars - marker.length,
      commandBytes - utf8Length(marker),
    );
    head = detached(command.slice(0, end)) + marker;
    truncated = true;
  }
  if (!output) return { value: `$ ${head}`, truncated };
  const prefix = `$ ${head}\n`;
  const tail = markedTail(
    output,
    chars - prefix.length,
    bytes === Infinity ? Infinity : bytes - utf8Length(prefix),
  );
  return { value: prefix + tail.value, truncated: truncated || tail.truncated };
}

/** The end of `text` within the limits, prefixed with `… ` when cut. */
function markedTail(text: string, chars: number, bytes: number): Clipped {
  if (tailStart(text, chars, bytes) <= 0) return { value: text, truncated: false };
  const marker = `${ELLIPSIS} `;
  const start = tailStart(text, chars - marker.length, bytes - utf8Length(marker));
  return { value: marker + detached(text.slice(start)), truncated: true };
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

const POSIX_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);
const POWERSHELLS: ReadonlySet<string> = new Set(['pwsh', 'powershell']);

/** `/usr/bin/zsh` → `zsh`, `C:\Windows\System32\cmd.exe` → `cmd`. */
function programName(argv0: string): string {
  return (argv0.split(/[\\/]/).pop() ?? argv0).toLowerCase().replace(/\.exe$/, '');
}

/** An argv element as a POSIX shell would need it written. */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a call ran, as a person would type it: a string as is; for an
 * argv, the script of a shell wrapper (`bash -lc <script>`, `pwsh -Command
 * …`, `cmd /c …`), else the arguments joined with shell quoting.
 */
function commandOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const argv = value.filter((part): part is string => typeof part === 'string');
  if (argv.length === 0) return undefined;
  const program = programName(argv[0]);
  if (POSIX_SHELLS.has(program) && argv.length >= 3 && /^-[a-z]*c$/.test(argv[1])) {
    return argv[2];
  }
  if (POWERSHELLS.has(program)) {
    const flag = argv.findIndex((arg, index) => index > 0 && /^-(?:command|c)$/i.test(arg));
    if (flag > 0 && flag + 1 < argv.length) return argv.slice(flag + 1).join(' ');
  }
  if (program === 'cmd') {
    const flag = argv.findIndex((arg, index) => index > 0 && /^\/c$/i.test(arg));
    if (flag > 0 && flag + 1 < argv.length) return argv.slice(flag + 1).join(' ');
  }
  return argv.map(shellQuote).join(' ');
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
