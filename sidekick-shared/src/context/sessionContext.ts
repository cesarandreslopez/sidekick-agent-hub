/**
 * Provider-neutral session context evidence projection.
 *
 * Converts canonical SessionEvent streams into a compact manifest suitable for
 * UI surfaces that need to explain what an assistant/provider has seen.
 */

import { EventAggregator } from '../aggregation/EventAggregator';
import type { AggregatedMetrics } from '../aggregation/types';
import { getModelContextWindowSize } from '../modelContext';
import type { ProviderId, SessionProviderBase } from '../providers/types';
import type {
  CompactionEvent,
  ContextAttribution,
  MessageUsage,
  PermissionMode,
  SessionEvent,
  TokenUsage,
  TruncationEvent,
} from '../types/sessionEvent';

export type SessionContextPressure = 'low' | 'medium' | 'high';

export type SessionContextSourceType =
  | 'system'
  | 'runtime'
  | 'rate_limit'
  | 'user_prompt'
  | 'assistant_response'
  | 'thinking'
  | 'tool_input'
  | 'tool_output'
  | 'summary'
  | 'error'
  | 'other';

export interface SessionContextLayerBreakdown {
  layer: string;
  tokenEstimate: number;
  sourceCount: number;
}

export interface SessionContextSource {
  id: string;
  providerId?: ProviderId;
  sessionId?: string;
  sessionPath?: string;
  eventType: SessionEvent['type'];
  timestamp: string;
  layer: string;
  sourceType: SessionContextSourceType;
  title: string;
  sourceRef?: string;
  sourceFile?: string;
  toolName?: string;
  score?: number;
  tokenEstimate: number;
  snippet: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionContextCapabilities {
  providerId?: ProviderId;
  providerLabel?: string;
  model?: string;
  observedTools: string[];
  mcpServers: string[];
  permissionMode?: PermissionMode;
  rateLimits?: SessionEvent['rateLimits'];
}

export interface SessionContextSnapshot {
  schemaVersion: 1;
  providerId?: ProviderId;
  sessionId?: string;
  sessionPath?: string;
  model?: string;
  contextWindow: number;
  contextTokens: number;
  pressure: SessionContextPressure;
  pressureRatio: number;
  layers: string[];
  breakdown: SessionContextLayerBreakdown[];
  sources: SessionContextSource[];
  capabilities: SessionContextCapabilities;
  attribution: ContextAttribution;
  tokens: AggregatedMetrics['tokens'];
  compactionCount: number;
  compactionEvents: CompactionEvent[];
  truncationCount: number;
  truncationEvents: TruncationEvent[];
}

export interface BuildSessionContextSnapshotOptions {
  providerId?: ProviderId;
  providerLabel?: string;
  sessionId?: string;
  sessionPath?: string;
  model?: string;
  contextWindow?: number;
  contextWindowForModel?: (modelId?: string) => number;
  computeContextSize?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    reasoningTokens?: number;
  }) => number;
  includeBodies?: boolean;
  bodyMaxChars?: number;
  snippetMaxChars?: number;
  sourceLimit?: number;
}

export type ReadSessionContextSnapshotOptions = Omit<
  BuildSessionContextSnapshotOptions,
  'providerId' | 'providerLabel' | 'sessionId' | 'sessionPath' | 'contextWindowForModel' | 'computeContextSize'
>;

export interface SessionContextProjector {
  processEvent(event: SessionEvent): SessionContextSnapshot;
  processEvents(events: readonly SessionEvent[]): SessionContextSnapshot;
  getSnapshot(): SessionContextSnapshot;
  reset(): void;
}

const DEFAULT_CONTEXT_SOURCE_LIMIT = 200;
const DEFAULT_SNIPPET_MAX_CHARS = 240;
const DEFAULT_BODY_MAX_CHARS = 5000;
const MEDIUM_PRESSURE_RATIO = 0.6;
const HIGH_PRESSURE_RATIO = 0.8;

const EMPTY_ATTRIBUTION: ContextAttribution = {
  systemPrompt: 0,
  userMessages: 0,
  assistantResponses: 0,
  toolInputs: 0,
  toolOutputs: 0,
  thinking: 0,
  other: 0,
};

export function calculateSessionContextPressure(
  contextTokens: number,
  contextWindow: number,
): { pressure: SessionContextPressure; ratio: number } {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return { pressure: 'low', ratio: 0 };
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { pressure: 'low', ratio: 0 };
  }

  const ratio = Math.max(0, Math.min(1, contextTokens / contextWindow));
  if (ratio >= HIGH_PRESSURE_RATIO) return { pressure: 'high', ratio };
  if (ratio >= MEDIUM_PRESSURE_RATIO) return { pressure: 'medium', ratio };
  return { pressure: 'low', ratio };
}

export function buildSessionContextSnapshot(
  events: readonly SessionEvent[],
  options: BuildSessionContextSnapshotOptions = {},
): SessionContextSnapshot {
  const providerId = options.providerId;
  const aggregator = new EventAggregator({
    providerId,
    computeContextSize: options.computeContextSize,
  });

  const sourceState = createSourceExtractionState(options);
  let lastPermissionMode: PermissionMode | undefined;
  let lastRateLimits: SessionEvent['rateLimits'] | undefined;

  for (const event of events) {
    aggregator.processEvent(event);
    extractSourcesFromEvent(event, sourceState);
    if (event.permissionMode) lastPermissionMode = event.permissionMode;
    if (event.rateLimits) lastRateLimits = event.rateLimits;
  }

  const metrics = aggregator.getMetrics();
  const model = options.model ?? metrics.currentModel ?? metrics.modelStats[0]?.model;
  const contextWindow =
    options.contextWindow ??
    options.contextWindowForModel?.(model) ??
    getModelContextWindowSize(model);

  const allSources = sourceState.sources;
  const limitedSources = limitSources(allSources, options.sourceLimit ?? DEFAULT_CONTEXT_SOURCE_LIMIT);
  const breakdown = buildLayerBreakdown(limitedSources);
  const layers = breakdown.map(row => row.layer);
  const sourceTokenTotal = allSources.reduce((sum, source) => sum + source.tokenEstimate, 0);
  const contextTokens = metrics.currentContextSize > 0 ? metrics.currentContextSize : sourceTokenTotal;
  const { pressure, ratio } = calculateSessionContextPressure(contextTokens, contextWindow);

  return {
    schemaVersion: 1,
    providerId,
    sessionId: options.sessionId,
    sessionPath: options.sessionPath,
    model,
    contextWindow,
    contextTokens,
    pressure,
    pressureRatio: ratio,
    layers,
    breakdown,
    sources: limitedSources,
    capabilities: {
      providerId,
      providerLabel: options.providerLabel ?? providerLabel(providerId),
      model,
      observedTools: [...sourceState.observedTools].sort((a, b) => a.localeCompare(b)),
      mcpServers: [...sourceState.mcpServers].sort((a, b) => a.localeCompare(b)),
      permissionMode: lastPermissionMode,
      rateLimits: lastRateLimits,
    },
    attribution: metrics.contextAttribution ?? { ...EMPTY_ATTRIBUTION },
    tokens: metrics.tokens,
    compactionCount: metrics.compactionCount,
    compactionEvents: metrics.compactionEvents,
    truncationCount: metrics.truncationCount,
    truncationEvents: metrics.truncationEvents,
  };
}

export function createSessionContextProjector(
  options: BuildSessionContextSnapshotOptions = {},
): SessionContextProjector {
  let events: SessionEvent[] = [];

  return {
    processEvent(event: SessionEvent): SessionContextSnapshot {
      events.push(event);
      return buildSessionContextSnapshot(events, options);
    },

    processEvents(newEvents: readonly SessionEvent[]): SessionContextSnapshot {
      events.push(...newEvents);
      return buildSessionContextSnapshot(events, options);
    },

    getSnapshot(): SessionContextSnapshot {
      return buildSessionContextSnapshot(events, options);
    },

    reset(): void {
      events = [];
    },
  };
}

export function readSessionContextSnapshot(
  provider: SessionProviderBase,
  sessionPath: string,
  options: ReadSessionContextSnapshotOptions = {},
): SessionContextSnapshot {
  const reader = provider.createReader(sessionPath);
  const events = reader.readAll();
  const model = options.model ?? latestModel(events);
  return buildSessionContextSnapshot(events, {
    ...options,
    providerId: provider.id,
    providerLabel: provider.displayName,
    sessionId: provider.getSessionId(sessionPath),
    sessionPath,
    model,
    contextWindow: options.contextWindow ?? provider.getContextWindowLimit?.(model),
    computeContextSize: provider.computeContextSize
      ? (usage) => provider.computeContextSize!(usage as TokenUsage)
      : undefined,
  });
}

interface SourceExtractionState {
  readonly options: BuildSessionContextSnapshotOptions;
  readonly sources: SessionContextSource[];
  readonly observedTools: Set<string>;
  readonly mcpServers: Set<string>;
  counter: number;
}

interface SourceSeed {
  event: SessionEvent;
  layer: string;
  sourceType: SessionContextSourceType;
  title: string;
  text: string;
  sourceRef?: string;
  sourceFile?: string;
  toolName?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

function createSourceExtractionState(options: BuildSessionContextSnapshotOptions): SourceExtractionState {
  return {
    options,
    sources: [],
    observedTools: new Set<string>(),
    mcpServers: new Set<string>(),
    counter: 0,
  };
}

function extractSourcesFromEvent(event: SessionEvent, state: SourceExtractionState): void {
  switch (event.type) {
    case 'system':
      extractSystemSource(event, state);
      break;
    case 'user':
      extractUserSources(event, state);
      break;
    case 'assistant':
      extractAssistantSources(event, state);
      break;
    case 'tool_use':
      if (event.tool) {
        addToolInputSource(event, state, event.tool.name, event.tool.input, undefined);
      }
      break;
    case 'tool_result':
      addSource(state, {
        event,
        layer: 'tool outputs',
        sourceType: event.result?.is_error ? 'error' : 'tool_output',
        title: event.result?.is_error ? 'Tool error' : 'Tool result',
        sourceRef: event.result?.tool_use_id,
        text: stringifyValue(event.result?.output),
        metadata: { toolUseId: event.result?.tool_use_id },
      });
      break;
    case 'summary':
      addSource(state, {
        event,
        layer: 'summary',
        sourceType: 'summary',
        title: 'Context summary',
        text: extractText(event.message.content) || 'Context compacted',
      });
      break;
  }
}

function extractSystemSource(event: SessionEvent, state: SourceExtractionState): void {
  const text = extractText(event.message.content);
  const label = event.message.sourceLabel ?? event.message.role ?? 'system';
  const usage = event.message.usage;

  if (text) {
    addSource(state, {
      event,
      layer: 'system',
      sourceType: 'system',
      title: label,
      sourceRef: event.message.id,
      text,
    });
  }

  if (usage || event.rateLimits) {
    addSource(state, {
      event,
      layer: 'runtime',
      sourceType: event.rateLimits ? 'rate_limit' : 'runtime',
      title: event.rateLimits ? 'Runtime usage and rate limits' : 'Runtime usage',
      sourceRef: event.message.id,
      text: describeUsage(usage, event.rateLimits),
      metadata: {
        usage,
        rateLimits: event.rateLimits,
      },
    });
  }
}

function extractUserSources(event: SessionEvent, state: SourceExtractionState): void {
  const content = event.message.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result') {
        const isError = block.is_error === true;
        addSource(state, {
          event,
          layer: 'tool outputs',
          sourceType: isError ? 'error' : 'tool_output',
          title: isError ? 'Tool error' : 'Tool result',
          sourceRef: stringValue(block.tool_use_id),
          text: stringifyValue(block.content),
          metadata: {
            toolUseId: block.tool_use_id,
            duration: block.duration,
          },
        });
        continue;
      }

      const text = blockText(block);
      if (text) {
        addSource(state, {
          event,
          layer: 'user',
          sourceType: 'user_prompt',
          title: event.message.sourceLabel ?? 'User prompt',
          sourceRef: event.message.id,
          text,
        });
      }
    }
    return;
  }

  const text = extractText(content);
  if (text) {
    addSource(state, {
      event,
      layer: 'user',
      sourceType: 'user_prompt',
      title: event.message.sourceLabel ?? 'User prompt',
      sourceRef: event.message.id,
      text,
    });
  }
}

function extractAssistantSources(event: SessionEvent, state: SourceExtractionState): void {
  const content = event.message.content;
  if (!Array.isArray(content)) {
    const text = extractText(content);
    if (text) {
      addSource(state, {
        event,
        layer: 'assistant',
        sourceType: 'assistant_response',
        title: 'Assistant response',
        sourceRef: event.message.id,
        text,
      });
    }
    return;
  }

  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      addToolInputSource(
        event,
        state,
        block.name,
        isRecord(block.input) ? block.input : {},
        stringValue(block.id),
      );
      continue;
    }

    if (block.type === 'thinking' || block.type === 'reasoning') {
      const text = blockText(block);
      if (text) {
        addSource(state, {
          event,
          layer: 'thinking',
          sourceType: 'thinking',
          title: 'Reasoning',
          sourceRef: event.message.id,
          text,
        });
      }
      continue;
    }

    const text = blockText(block);
    if (text) {
      addSource(state, {
        event,
        layer: 'assistant',
        sourceType: 'assistant_response',
        title: 'Assistant response',
        sourceRef: event.message.id,
        text,
      });
    }
  }
}

function addToolInputSource(
  event: SessionEvent,
  state: SourceExtractionState,
  toolName: string,
  input: Record<string, unknown>,
  sourceRef: string | undefined,
): void {
  state.observedTools.add(toolName);
  const mcpServer = inferMcpServer(toolName, input);
  if (mcpServer) state.mcpServers.add(mcpServer);

  const sourceFile = inferSourceFile(input);
  const command = inferCommand(input);
  addSource(state, {
    event,
    layer: 'tool inputs',
    sourceType: 'tool_input',
    title: sourceFile ? `${toolName}: ${sourceFile}` : toolName,
    sourceRef: sourceRef ?? command,
    sourceFile,
    toolName,
    text: stringifyValue(input),
    metadata: {
      rawToolName: input._sidekickRawToolName,
      mcpServer,
    },
  });
}

function addSource(state: SourceExtractionState, seed: SourceSeed): void {
  const cleanText = clean(seed.text);
  if (!cleanText) return;
  const bodyText = seed.text.trim();

  const snippetMaxChars = state.options.snippetMaxChars ?? DEFAULT_SNIPPET_MAX_CHARS;
  const bodyMaxChars = state.options.bodyMaxChars ?? DEFAULT_BODY_MAX_CHARS;
  const bodyInfo = state.options.includeBodies
    ? truncateWithInfo(bodyText, bodyMaxChars)
    : undefined;

  const tokenEstimate = estimateTokens(cleanText);
  const metadata = {
    ...(seed.metadata ?? {}),
    ...(bodyInfo?.truncated ? { bodyTruncated: true, originalChars: bodyText.length } : {}),
  };

  state.sources.push({
    id: `${state.options.sessionId ?? state.options.sessionPath ?? 'session'}:${state.counter++}`,
    providerId: state.options.providerId,
    sessionId: state.options.sessionId,
    sessionPath: state.options.sessionPath,
    eventType: seed.event.type,
    timestamp: seed.event.timestamp,
    layer: seed.layer,
    sourceType: seed.sourceType,
    title: seed.title,
    sourceRef: seed.sourceRef,
    sourceFile: seed.sourceFile,
    toolName: seed.toolName,
    score: seed.score,
    tokenEstimate,
    snippet: truncateClean(cleanText, snippetMaxChars),
    body: bodyInfo?.text,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

function buildLayerBreakdown(sources: readonly SessionContextSource[]): SessionContextLayerBreakdown[] {
  const byLayer = new Map<string, SessionContextLayerBreakdown>();
  for (const source of sources) {
    const row = byLayer.get(source.layer) ?? {
      layer: source.layer,
      tokenEstimate: 0,
      sourceCount: 0,
    };
    row.tokenEstimate += source.tokenEstimate;
    row.sourceCount++;
    byLayer.set(source.layer, row);
  }
  return [...byLayer.values()].sort((a, b) => b.tokenEstimate - a.tokenEstimate);
}

function limitSources(
  sources: readonly SessionContextSource[],
  limit: number,
): SessionContextSource[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  if (sources.length <= limit) return [...sources];

  const pinned = sources.filter(source =>
    source.sourceType === 'system' ||
    source.sourceType === 'runtime' ||
    source.sourceType === 'rate_limit'
  );
  const pinnedLimit = Math.min(pinned.length, Math.max(1, Math.floor(limit / 4)));
  const pinnedKept = pinned.slice(0, pinnedLimit);
  const pinnedIds = new Set(pinnedKept.map(source => source.id));
  const remaining = sources.filter(source => !pinnedIds.has(source.id));
  const latest = remaining.slice(-(limit - pinnedKept.length));
  const keepIds = new Set([...pinnedKept, ...latest].map(source => source.id));
  return sources.filter(source => keepIds.has(source.id));
}

function latestModel(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const model = events[i].message.model;
    if (model) return model;
  }
  return undefined;
}

function providerLabel(providerId: ProviderId | undefined): string | undefined {
  switch (providerId) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    default:
      return undefined;
  }
}

function describeUsage(
  usage: MessageUsage | undefined,
  rateLimits: SessionEvent['rateLimits'],
): string {
  const parts: string[] = [];
  if (usage) {
    parts.push(`Input tokens: ${usage.input_tokens || 0}`);
    parts.push(`Output tokens: ${usage.output_tokens || 0}`);
    if (usage.cache_read_input_tokens) parts.push(`Cache read: ${usage.cache_read_input_tokens}`);
    if (usage.cache_creation_input_tokens) parts.push(`Cache write: ${usage.cache_creation_input_tokens}`);
    if (usage.reasoning_tokens) parts.push(`Reasoning tokens: ${usage.reasoning_tokens}`);
  }
  if (rateLimits?.primary) {
    parts.push(`Primary limit: ${rateLimits.primary.usedPercent}% used`);
  }
  if (rateLimits?.secondary) {
    parts.push(`Secondary limit: ${rateLimits.secondary.usedPercent}% used`);
  }
  return parts.join('\n') || 'Runtime metadata';
}

function inferSourceFile(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'filename', 'notebook_path', 'target_file']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const files = input.files;
  if (Array.isArray(files)) {
    const first = files.find(value => typeof value === 'string' && value.trim());
    if (typeof first === 'string') return first.trim();
  }
  return undefined;
}

function inferCommand(input: Record<string, unknown>): string | undefined {
  const command = input.command ?? input.cmd;
  if (typeof command === 'string' && command.trim()) return command.trim();
  if (Array.isArray(command)) {
    return command.map(part => String(part)).join(' ').trim() || undefined;
  }
  return undefined;
}

function inferMcpServer(toolName: string, input: Record<string, unknown>): string | undefined {
  const explicit = input._sidekickMcpServerName ?? input.server_name ?? input.serverName;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();

  const match = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName);
  if (match) return match[1];
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => isRecord(block) ? blockText(block) : '')
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return stringifyValue(content);
}

function blockText(block: Record<string, unknown>): string {
  for (const key of ['text', 'thinking', 'content']) {
    const value = block[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateClean(text: string, maxChars: number): string {
  return truncateWithInfo(text, maxChars).text;
}

function truncateWithInfo(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= 3) return { text: text.slice(0, maxChars), truncated: true };
  return { text: `${text.slice(0, maxChars - 3)}...`, truncated: true };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
