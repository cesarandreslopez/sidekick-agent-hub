import { formatToolSummary, truncate } from '../formatters/toolSummary';
import type { SessionEvent } from '../types/sessionEvent';

export type AssistantTurnEventType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'status'
  | 'error'
  | 'delta'
  | 'progress';

export interface AssistantTurnEvent {
  eventType: AssistantTurnEventType;
  content: string;
  deltaKind?: 'text' | 'thinking' | 'tool_input';
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
}

export interface AssistantTurnToolRef {
  toolName: string;
  toolInput?: string;
  toolUseId?: string;
}

export type AssistantTurnProcessStep =
  | { kind: 'narration'; text: string }
  | { kind: 'toolGroup'; tools: AssistantTurnToolRef[] };

export type AssistantTurnTimelineItem =
  | { kind: 'reasoning'; text: string }
  | { kind: 'narration'; text: string }
  | { kind: 'toolGroup'; tools: AssistantTurnToolRef[] };

export interface AssistantTurnProcess {
  steps: AssistantTurnProcessStep[];
}

export type AssistantTurnSubagentStatus = 'running' | 'completed' | 'failed';

export interface AssistantTurnSubagent {
  id: string;
  label: string;
  agentType?: string;
  status: AssistantTurnSubagentStatus;
}

export interface AssistantTurnProjection {
  schemaVersion: 2;
  answer: string;
  reasoning: string;
  reasoningBlocks: string[];
  process: AssistantTurnProcess;
  timeline: AssistantTurnTimelineItem[];
  subagents: AssistantTurnSubagent[];
}

export interface SegmentAssistantTurnOptions {
  maxNarrationChars?: number;
  maxReasoningChars?: number;
  maxProcessSteps?: number;
  maxReasoningBlocks?: number;
  toolInputMaxChars?: number;
  subagentStatus?: AssistantTurnSubagentStatus;
  sanitizeToolInput?: (tool: {
    toolName: string;
    toolInput: unknown;
    toolUseId?: string;
  }) => string | undefined;
}

export interface ExtractTurnSubagentsOptions {
  status: AssistantTurnSubagentStatus;
}

const DEFAULT_NARRATION_CHARS = 4000;
const DEFAULT_REASONING_CHARS = 8000;
const DEFAULT_PROCESS_STEPS = 60;
const DEFAULT_REASONING_BLOCKS = 24;
const DEFAULT_TOOL_INPUT_CHARS = 200;
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Task']);
const LABEL_MAX = 80;
const TITLE_RE = /^\s*\*\*([^*\n]+)\*\*[ \t]*(?:\n+([\s\S]*))?$/;
const TITLE_MAX = 100;

export interface ReasoningSummary {
  title: string | null;
  body: string;
}

type AssistantTurnToolGroupStep = Extract<AssistantTurnProcessStep, { kind: 'toolGroup' }>;

type InternalTimelineItem =
  | { kind: 'reasoning'; text: string; reasoningIndex: number }
  | { kind: 'narration'; text: string; processStepIndex: number }
  | { kind: 'toolGroup'; tools: AssistantTurnToolRef[]; processStepIndex: number };

interface CappedProcessSteps {
  steps: AssistantTurnProcessStep[];
  retainedIndexes: Set<number>;
  omittedMarker?: string;
}

interface CappedReasoningBlocks {
  blocks: string[];
  retainedIndexes: Set<number>;
  omittedMarker?: string;
}

export function reasoningSummary(text: string): ReasoningSummary {
  const normalized = text.replace(/\r\n/g, '\n');
  const trimmed = normalized.trim();
  if (trimmed === '') return { title: null, body: '' };

  const match = TITLE_RE.exec(normalized);
  if (match) {
    const title = match[1].trim();
    if (title !== '' && title.length <= TITLE_MAX) {
      return { title, body: (match[2] ?? '').trim() };
    }
  }
  return { title: null, body: trimmed };
}

export function isAssistantTurnSubagentTool(toolName: string | undefined): boolean {
  return toolName != null && SUBAGENT_TOOL_NAMES.has(toolName);
}

export function segmentAssistantTurn(
  events: readonly AssistantTurnEvent[],
  options: SegmentAssistantTurnOptions = {},
): AssistantTurnProjection {
  const maxNarrationChars = options.maxNarrationChars ?? DEFAULT_NARRATION_CHARS;
  const maxReasoningChars = options.maxReasoningChars ?? DEFAULT_REASONING_CHARS;
  const maxProcessSteps = options.maxProcessSteps ?? DEFAULT_PROCESS_STEPS;
  const maxReasoningBlocks = options.maxReasoningBlocks ?? DEFAULT_REASONING_BLOCKS;
  const subagentStatus = options.subagentStatus ?? 'completed';

  const reasoningParts: string[] = [];
  const steps: AssistantTurnProcessStep[] = [];
  const timelineItems: InternalTimelineItem[] = [];
  let textBuffer: string[] = [];
  let toolGroup: AssistantTurnToolGroupStep | null = null;

  function closeToolGroup(): void {
    if (toolGroup != null && toolGroup.tools.length > 0) {
      const processStepIndex = steps.length;
      steps.push(toolGroup);
      timelineItems.push({ kind: 'toolGroup', tools: toolGroup.tools, processStepIndex });
    }
    toolGroup = null;
  }

  function sealTextAsNarration(): void {
    const text = joinText(textBuffer);
    if (text !== '') {
      const processStepIndex = steps.length;
      const step = { kind: 'narration' as const, text: capText(text, maxNarrationChars) };
      steps.push(step);
      timelineItems.push({ kind: 'narration', text: step.text, processStepIndex });
    }
    textBuffer = [];
  }

  for (const event of events) {
    switch (event.eventType) {
      case 'text': {
        if (event.content.trim() === '') break;
        closeToolGroup();
        textBuffer.push(event.content);
        break;
      }
      case 'thinking': {
        if (event.content.trim() === '') break;
        sealTextAsNarration();
        closeToolGroup();
        const reasoningIndex = reasoningParts.length;
        reasoningParts.push(event.content);
        timelineItems.push({
          kind: 'reasoning',
          text: capText(event.content, maxReasoningChars),
          reasoningIndex,
        });
        break;
      }
      case 'tool_use': {
        sealTextAsNarration();
        if (toolGroup == null) toolGroup = { kind: 'toolGroup', tools: [] };
        const toolName = event.toolName ?? 'tool';
        const tool: AssistantTurnToolRef = { toolName };
        const toolInput = formatTurnToolInput(toolName, event.toolInput, event.toolUseId, options);
        if (toolInput != null && toolInput !== '') tool.toolInput = toolInput;
        if (event.toolUseId != null && event.toolUseId !== '') tool.toolUseId = event.toolUseId;
        toolGroup.tools.push(tool);
        break;
      }
      default:
        break;
    }
  }

  const answer = joinText(textBuffer);
  closeToolGroup();

  const cappedReasoning = capReasoningBlocks(
    reasoningParts.map((part) => capText(part, maxReasoningChars)),
    maxReasoningBlocks,
  );
  const cappedProcess = capProcessSteps(steps, maxProcessSteps);
  const process = { steps: cappedProcess.steps };

  return {
    schemaVersion: 2,
    answer,
    reasoning: capText(joinText(reasoningParts), maxReasoningChars),
    reasoningBlocks: cappedReasoning.blocks,
    process,
    timeline: capTimelineItems(timelineItems, cappedReasoning, cappedProcess),
    subagents: extractTurnSubagents(flattenProcessTools(process), { status: subagentStatus }),
  };
}

export function assistantTurnEventsFromSessionEvents(
  events: readonly SessionEvent[],
): AssistantTurnEvent[] {
  const result: AssistantTurnEvent[] = [];
  for (const event of events) {
    if (event.type === 'assistant') {
      appendMessageContentEvents(result, event.message.content);
      continue;
    }
    if (event.type === 'tool_use' && event.tool != null) {
      result.push({
        eventType: 'tool_use',
        content: '',
        toolName: event.tool.name,
        toolInput: event.tool.input,
      });
      continue;
    }
    if (event.type === 'tool_result') {
      result.push({
        eventType: 'tool_result',
        content: stringifyValue(event.result?.output),
        toolUseId: event.result?.tool_use_id,
      });
    }
  }
  return result;
}

export function extractTurnSubagents(
  tools: ReadonlyArray<{ toolName?: string; toolInput?: unknown; toolUseId?: string }>,
  options: ExtractTurnSubagentsOptions,
): AssistantTurnSubagent[] {
  const result: AssistantTurnSubagent[] = [];
  for (const tool of tools) {
    if (!isAssistantTurnSubagentTool(tool.toolName)) continue;
    const input = parseSubagentInput(tool.toolInput);
    const index = result.length;
    const label = capLabel(input.description ?? input.agentType ?? `Agent ${index + 1}`);
    const ref: AssistantTurnSubagent = {
      id: tool.toolUseId && tool.toolUseId !== '' ? tool.toolUseId : `subagent-${index}`,
      label,
      status: options.status,
    };
    if (input.agentType != null) ref.agentType = input.agentType;
    result.push(ref);
  }
  return result;
}

function appendMessageContentEvents(result: AssistantTurnEvent[], content: unknown): void {
  if (typeof content === 'string') {
    if (content !== '') result.push({ eventType: 'text', content });
    return;
  }
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = stringValue(block.type);
    if (type === 'text') {
      const text = stringValue(block.text) ?? stringValue(block.content);
      if (text != null) result.push({ eventType: 'text', content: text });
      continue;
    }
    if (type === 'thinking' || type === 'reasoning') {
      const text = stringValue(block.thinking) ?? stringValue(block.text) ?? stringValue(block.content);
      if (text != null) result.push({ eventType: 'thinking', content: text });
      continue;
    }
    if (type === 'tool_use') {
      const toolName = stringValue(block.name) ?? 'tool';
      const event: AssistantTurnEvent = {
        eventType: 'tool_use',
        content: '',
        toolName,
        toolInput: block.input,
      };
      const toolUseId = stringValue(block.id);
      if (toolUseId != null) event.toolUseId = toolUseId;
      result.push(event);
      continue;
    }
    if (type === 'tool_result') {
      const event: AssistantTurnEvent = {
        eventType: 'tool_result',
        content: stringifyValue(block.content),
      };
      const toolUseId = stringValue(block.tool_use_id);
      if (toolUseId != null) event.toolUseId = toolUseId;
      result.push(event);
    }
  }
}

function formatTurnToolInput(
  toolName: string,
  toolInput: unknown,
  toolUseId: string | undefined,
  options: SegmentAssistantTurnOptions,
): string | undefined {
  if (options.sanitizeToolInput != null) {
    return options.sanitizeToolInput({ toolName, toolInput, toolUseId });
  }
  if (toolInput == null) return undefined;

  const maxChars = options.toolInputMaxChars ?? DEFAULT_TOOL_INPUT_CHARS;
  if (isAssistantTurnSubagentTool(toolName)) {
    const input = parseSubagentInput(toolInput);
    const projection: Record<string, string> = {};
    if (input.agentType != null) projection.subagent_type = truncate(input.agentType, LABEL_MAX);
    if (input.description != null) projection.description = truncate(input.description, maxChars);
    return JSON.stringify(projection);
  }

  const record = coerceRecord(toolInput);
  if (record != null) {
    const summary = formatToolSummary(toolName, record);
    return summary === '' ? undefined : truncate(summary, maxChars);
  }
  if (typeof toolInput === 'string') {
    return truncate(toolInput, maxChars);
  }
  return truncate(stringifyValue(toolInput), maxChars);
}

function flattenProcessTools(process: AssistantTurnProcess): AssistantTurnToolRef[] {
  const result: AssistantTurnToolRef[] = [];
  for (const step of process.steps) {
    if (step.kind === 'toolGroup') result.push(...step.tools);
  }
  return result;
}

function capProcessSteps(
  steps: AssistantTurnProcessStep[],
  maxRetainedSteps: number,
): CappedProcessSteps {
  const retainedIndexes = new Set<number>();
  if (!Number.isFinite(maxRetainedSteps) || maxRetainedSteps < 0) return { steps: [], retainedIndexes };
  const retainedCount = Math.floor(maxRetainedSteps);
  if (steps.length <= retainedCount) {
    steps.forEach((_step, index) => retainedIndexes.add(index));
    return { steps, retainedIndexes };
  }
  const firstKeptIndex = Math.max(steps.length - retainedCount, 0);
  const kept = retainedCount > 0 ? steps.slice(firstKeptIndex) : [];
  for (let index = firstKeptIndex; index < steps.length; index += 1) {
    retainedIndexes.add(index);
  }
  const omitted = steps.length - kept.length;
  const omittedMarker = `... ${omitted} earlier process step${omitted === 1 ? '' : 's'} omitted`;
  return { steps: [{ kind: 'narration', text: omittedMarker }, ...kept], retainedIndexes, omittedMarker };
}

function capReasoningBlocks(blocks: string[], maxRetainedBlocks: number): CappedReasoningBlocks {
  const retainedIndexes = new Set<number>();
  if (!Number.isFinite(maxRetainedBlocks) || maxRetainedBlocks < 0) return { blocks: [], retainedIndexes };
  const retainedCount = Math.floor(maxRetainedBlocks);
  if (blocks.length <= retainedCount) {
    blocks.forEach((_block, index) => retainedIndexes.add(index));
    return { blocks, retainedIndexes };
  }
  const kept = retainedCount > 0 ? blocks.slice(0, retainedCount) : [];
  for (let index = 0; index < kept.length; index += 1) {
    retainedIndexes.add(index);
  }
  const omitted = blocks.length - kept.length;
  const omittedMarker = `... ${omitted} more reasoning block${omitted === 1 ? '' : 's'} omitted`;
  return { blocks: [...kept, omittedMarker], retainedIndexes, omittedMarker };
}

function capTimelineItems(
  items: InternalTimelineItem[],
  reasoning: CappedReasoningBlocks,
  process: CappedProcessSteps,
): AssistantTurnTimelineItem[] {
  const result: AssistantTurnTimelineItem[] = [];
  let insertedReasoningOmission = false;
  let insertedProcessOmission = false;

  for (const item of items) {
    if (item.kind === 'reasoning') {
      if (reasoning.retainedIndexes.has(item.reasoningIndex)) {
        result.push({ kind: 'reasoning', text: item.text });
      } else if (reasoning.omittedMarker != null && !insertedReasoningOmission) {
        result.push({ kind: 'reasoning', text: reasoning.omittedMarker });
        insertedReasoningOmission = true;
      }
      continue;
    }

    if (!process.retainedIndexes.has(item.processStepIndex)) {
      if (process.omittedMarker != null && !insertedProcessOmission) {
        result.push({ kind: 'narration', text: process.omittedMarker });
        insertedProcessOmission = true;
      }
      continue;
    }

    if (process.omittedMarker != null && !insertedProcessOmission) {
      result.push({ kind: 'narration', text: process.omittedMarker });
      insertedProcessOmission = true;
    }

    if (item.kind === 'narration') {
      result.push({ kind: 'narration', text: item.text });
    } else {
      result.push({ kind: 'toolGroup', tools: item.tools });
    }
  }

  return result;
}

function parseSubagentInput(input: unknown): { description?: string; agentType?: string } {
  const record = coerceRecord(input);
  if (record == null) return {};
  const description = stringValue(record.description)?.trim();
  const agentType = (stringValue(record.subagent_type) ?? stringValue(record.subagentType))?.trim();
  return {
    ...(description != null && description !== '' ? { description } : {}),
    ...(agentType != null && agentType !== '' ? { agentType } : {}),
  };
}

function coerceRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function capLabel(label: string): string {
  return label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 3).trimEnd()}...`;
}

function capText(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars < 0) return '';
  const limit = Math.floor(maxChars);
  if (text.length <= limit) return text;
  if (limit <= 3) return '.'.repeat(limit);
  return `${text.slice(0, limit - 3).trimEnd()}...`;
}

function joinText(parts: readonly string[]): string {
  return parts.filter((part) => part.trim() !== '').join('\n\n');
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
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
