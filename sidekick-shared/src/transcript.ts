import type { ProviderId } from './providers/types';
import type { SessionEvent } from './types/sessionEvent';
import {
  calculateNormalizedUsageCost,
  extractNormalizedUsage,
  type NormalizedUsage,
  type NormalizedUsageCost,
} from './usageNormalization';
import { isTaskNotificationSystemEvent } from './subagentSpawn';

export type TranscriptFidelity = 'snippet' | 'full';

export interface TranscriptSourceProvenance {
  provider?: ProviderId | string;
  sessionId?: string;
  sourcePath?: string;
  source?: string;
  entrypoint?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  /** Claude Code compaction/continuation summary flag. */
  isCompactSummary?: boolean;
  /** Claude Code `origin.kind` (e.g. `human`, `task-notification`, `coordinator`). */
  originKind?: string;
  /** Claude Code `promptSource` (e.g. `typed`, `queued`, `system`). */
  promptSource?: string;
  originalRole?: string;
  eventIndex: number;
  eventType: SessionEvent['type'];
  eventId?: string;
}

export interface CanonicalTranscriptBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'unknown';
  text?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  command?: string;
  truncated?: boolean;
  raw?: unknown;
  /**
   * The provider's own tool name before normalization (for example Codex
   * `exec_command` behind `Bash`), when the parser recorded one.
   */
  rawToolName?: string;
  /** The MCP server that served this tool call, when the parser recorded one. */
  mcpServerName?: string;
}

export interface CanonicalTranscriptMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'summary' | 'tool';
  timestamp: string;
  model?: string;
  sourceLabel?: string;
  content: CanonicalTranscriptBlock[];
  text: string;
  usage?: NormalizedUsage;
  cost?: NormalizedUsageCost;
  tools: CanonicalToolCall[];
  commands: string[];
  source: TranscriptSourceProvenance;
}

export interface CanonicalToolCall {
  id?: string;
  name: string;
  timestamp: string;
  /** Tool input without the parsers' internal `_sidekick*` bookkeeping keys. */
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  command?: string;
  /** The provider's own tool name before normalization, when recorded. */
  rawToolName?: string;
  /** The MCP server that served this tool call, when recorded. */
  mcpServerName?: string;
  source: TranscriptSourceProvenance;
}

export interface CanonicalTranscriptUsageTotals {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheInclusiveInputTokens: number;
  billableOutputTokens: number;
  totalTokens: number;
}

export interface CanonicalSessionTranscript {
  provider?: ProviderId | string;
  sessionId?: string;
  sourcePath?: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: string;
  endedAt?: string;
  models: string[];
  messages: CanonicalTranscriptMessage[];
  tools: CanonicalToolCall[];
  commands: string[];
  usage: {
    events: NormalizedUsage[];
    costs: NormalizedUsageCost[];
    totals: CanonicalTranscriptUsageTotals;
    /** Strict total: `null` unless every usage event could be priced. */
    totalCostUsd: number | null;
    /** Sum of the events that could be priced; pair with `unpricedEvents`. */
    pricedCostUsd: number;
    /** Usage events with neither a reported cost nor a catalog price. */
    unpricedEvents: number;
  };
  provenance: { source: 'session-events'; fidelity: TranscriptFidelity; eventCount: number };
}

export interface ProjectSessionTranscriptOptions {
  provider?: ProviderId | string;
  sessionId?: string;
  sourcePath?: string;
  fidelity?: TranscriptFidelity;
  /** Maximum characters per text/serialized block in snippet mode. Default 2000. */
  maxContentChars?: number;
  includeUnknownBlocks?: boolean;
}

const EMPTY_TOTALS: CanonicalTranscriptUsageTotals = {
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheInclusiveInputTokens: 0,
  billableOutputTokens: 0,
  totalTokens: 0,
};

/** Project canonical provider events into a bounded or full-fidelity transcript. */
export function projectSessionTranscript(
  events: SessionEvent[],
  options: ProjectSessionTranscriptOptions = {},
): CanonicalSessionTranscript {
  const fidelity = options.fidelity ?? 'snippet';
  const requestedMax = options.maxContentChars ?? 2_000;
  const maxContentChars = Number.isFinite(requestedMax) ? Math.max(0, requestedMax) : 2_000;
  const messages: CanonicalTranscriptMessage[] = [];
  const tools: CanonicalToolCall[] = [];
  const commands: string[] = [];
  const models = new Set<string>();
  const usageEvents: NormalizedUsage[] = [];
  const usageCosts: NormalizedUsageCost[] = [];
  const totals = { ...EMPTY_TOTALS };
  const toolsById = new Map<string, CanonicalToolCall>();
  let cwd: string | undefined;
  let gitBranch: string | undefined;

  events.forEach((event, eventIndex) => {
    // A reader's synthetic notice that a background task finished, not a message.
    if (isTaskNotificationSystemEvent(event)) return;
    if (nonEmpty(event.cwd)) cwd = event.cwd;
    if (nonEmpty(event.gitBranch)) gitBranch = event.gitBranch;
    const message = event.message;
    const source: TranscriptSourceProvenance = {
      provider: options.provider ?? event.providerMetadata?.providerId,
      sessionId: options.sessionId,
      sourcePath: options.sourcePath,
      source: event.providerMetadata?.source,
      entrypoint: event.entrypoint,
      isMeta: event.isMeta,
      isSidechain: event.isSidechain,
      ...(event.isCompactSummary !== undefined ? { isCompactSummary: event.isCompactSummary } : {}),
      ...(event.origin?.kind !== undefined ? { originKind: event.origin.kind } : {}),
      ...(event.promptSource !== undefined ? { promptSource: event.promptSource } : {}),
      originalRole: message?.role,
      eventIndex,
      eventType: event.type,
      eventId: message?.id,
    };
    const usage = extractNormalizedUsage(event) ?? undefined;
    if (usage) {
      usageEvents.push(usage);
      addUsage(totals, usage);
    }
    const cost = usage
      ? calculateNormalizedUsageCost({ usage, modelId: message?.model })
      : undefined;
    if (cost) usageCosts.push(cost);
    if (message?.model) models.add(message.model);

    const blocks = contentBlocks(
      message?.content,
      fidelity,
      maxContentChars,
      options.includeUnknownBlocks,
    );
    if (event.type === 'summary' && event.summary && blocks.length === 0) {
      blocks.push({ type: 'text', ...boundedText(event.summary, fidelity, maxContentChars) });
    }
    if (event.type === 'tool_use') {
      const projected = projectToolInput(event.tool.input);
      blocks.push({
        type: 'tool_use',
        toolName: event.tool.name,
        input: boundedValue(projected.input, fidelity, maxContentChars),
        ...toolIdentity(projected),
      });
    }
    if (event.type === 'tool_result') {
      blocks.push({
        type: 'tool_result',
        toolUseId: event.result.tool_use_id,
        output: boundedValue(event.result.output, fidelity, maxContentChars),
        isError: event.result.is_error,
      });
    }

    const messageTools: CanonicalToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.toolName) {
        const command = block.command ?? commandFromTool(block.toolName, block.input);
        const call: CanonicalToolCall = {
          id: block.toolUseId,
          name: block.toolName,
          timestamp: event.timestamp,
          input: block.input,
          command,
          ...toolIdentity(block),
          source,
        };
        tools.push(call);
        messageTools.push(call);
        if (call.id) toolsById.set(call.id, call);
        if (command) commands.push(command);
      } else if (block.type === 'tool_result' && block.toolUseId) {
        const call = toolsById.get(block.toolUseId);
        if (call) {
          call.output = block.output;
          call.isError = block.isError;
        }
      }
    }

    if (blocks.length === 0 && !usage && event.type !== 'summary') return;
    messages.push({
      id: message?.id,
      role: roleForEvent(event),
      timestamp: event.timestamp,
      model: message?.model,
      sourceLabel: message?.sourceLabel,
      content: blocks,
      text: blocks
        .filter((block) => block.type === 'text' || block.type === 'thinking')
        .map((block) => block.text ?? '')
        .filter(Boolean)
        .join('\n'),
      usage,
      cost,
      tools: messageTools,
      commands: messageTools.flatMap((tool) => (tool.command ? [tool.command] : [])),
      source,
    });
  });

  return {
    provider: options.provider,
    sessionId: options.sessionId,
    sourcePath: options.sourcePath,
    cwd,
    gitBranch,
    startedAt: events[0]?.timestamp,
    endedAt: events.at(-1)?.timestamp,
    models: [...models],
    messages,
    tools,
    commands: [...new Set(commands)],
    usage: {
      events: usageEvents,
      costs: usageCosts,
      totals,
      totalCostUsd:
        usageCosts.length > 0 && usageCosts.every((cost) => cost.costUsd !== null)
          ? usageCosts.reduce((sum, cost) => sum + (cost.costUsd ?? 0), 0)
          : null,
      pricedCostUsd: usageCosts.reduce((sum, cost) => sum + (cost.costUsd ?? 0), 0),
      unpricedEvents: usageCosts.filter((cost) => cost.costUsd === null).length,
    },
    provenance: { source: 'session-events', fidelity, eventCount: events.length },
  };
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function roleForEvent(event: SessionEvent): CanonicalTranscriptMessage['role'] {
  if (event.type === 'summary') return 'summary';
  if (event.type === 'system') return 'system';
  if (event.type === 'tool_use' || event.type === 'tool_result') return 'tool';
  return event.type;
}

function contentBlocks(
  content: unknown,
  fidelity: TranscriptFidelity,
  maxChars: number,
  includeUnknown = false,
): CanonicalTranscriptBlock[] {
  if (typeof content === 'string')
    return [{ type: 'text', ...boundedText(content, fidelity, maxChars) }];
  if (!Array.isArray(content)) return [];
  const result: CanonicalTranscriptBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      result.push({ type: 'text', ...boundedText(block.text, fidelity, maxChars) });
    } else if (
      (block.type === 'thinking' || block.type === 'reasoning') &&
      (typeof block.thinking === 'string' || typeof block.text === 'string')
    ) {
      result.push({
        type: 'thinking',
        ...boundedText(String(block.thinking ?? block.text), fidelity, maxChars),
      });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      const projected = projectToolInput(block.input);
      result.push({
        type: 'tool_use',
        toolName: block.name,
        toolUseId: typeof block.id === 'string' ? block.id : undefined,
        input: boundedValue(projected.input, fidelity, maxChars),
        command: commandFromTool(block.name, projected.input),
        ...toolIdentity(projected),
      });
    } else if (block.type === 'tool_result') {
      result.push({
        type: 'tool_result',
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        output: boundedValue(block.content, fidelity, maxChars),
        isError: block.is_error === true,
      });
    } else if (block.type === 'image') {
      result.push({
        type: 'image',
        text: '[Image content]',
        ...(fidelity === 'full' ? { raw } : {}),
      });
    } else if (includeUnknown) {
      result.push({ type: 'unknown', raw: boundedValue(raw, fidelity, maxChars) });
    }
  }
  return result;
}

/** Prefix of the bookkeeping keys session parsers stash inside tool inputs. */
const SIDEKICK_INPUT_KEY_PREFIX = '_sidekick';

interface ProjectedToolInput {
  input: unknown;
  rawToolName?: string;
  mcpServerName?: string;
}

/**
 * Lifts the parsers' `_sidekickRawToolName` / `_sidekickMcpServerName` out of
 * a tool input and drops every other top-level `_sidekick*` key. Returns a
 * copy when anything is removed; the source event is never modified.
 */
function projectToolInput(input: unknown): ProjectedToolInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input };
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source);
  if (!keys.some((key) => key.startsWith(SIDEKICK_INPUT_KEY_PREFIX))) return { input };
  const clean: Record<string, unknown> = {};
  for (const key of keys) {
    if (!key.startsWith(SIDEKICK_INPUT_KEY_PREFIX)) clean[key] = source[key];
  }
  return {
    input: clean,
    rawToolName: nonEmptyString(source._sidekickRawToolName),
    mcpServerName: nonEmptyString(source._sidekickMcpServerName),
  };
}

function toolIdentity(value: {
  rawToolName?: string;
  mcpServerName?: string;
}): Pick<CanonicalToolCall, 'rawToolName' | 'mcpServerName'> {
  return {
    ...(value.rawToolName ? { rawToolName: value.rawToolName } : {}),
    ...(value.mcpServerName ? { mcpServerName: value.mcpServerName } : {}),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function boundedText(text: string, fidelity: TranscriptFidelity, maxChars: number) {
  if (fidelity === 'full' || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function boundedValue(value: unknown, fidelity: TranscriptFidelity, maxChars: number): unknown {
  if (fidelity === 'full' || value === undefined) return value;
  if (typeof value === 'string') return boundedText(value, fidelity, maxChars).text;
  try {
    const json = JSON.stringify(value);
    return json.length <= maxChars ? value : json.slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}

function commandFromTool(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  if (
    !['bash', 'shell', 'execcommand', 'exec_command', 'local_shell'].includes(name.toLowerCase())
  ) {
    return undefined;
  }
  if (typeof value.command === 'string') return value.command;
  if (Array.isArray(value.command)) return value.command.map(String).join(' ');
  if (typeof value.cmd === 'string') return value.cmd;
  return undefined;
}

function addUsage(total: CanonicalTranscriptUsageTotals, usage: NormalizedUsage): void {
  total.uncachedInputTokens += usage.uncachedInputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.outputTokens += usage.outputTokens;
  total.reasoningTokens += usage.reasoningTokens;
  total.cacheInclusiveInputTokens += usage.cacheInclusiveInputTokens;
  total.billableOutputTokens += usage.billableOutputTokens;
  total.totalTokens += usage.totalTokens;
}
