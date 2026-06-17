/**
 * Zod schemas for browser-safe assistant turn projections.
 *
 * These schemas mirror `turns/assistantTurn.ts` and validate the compact
 * process/answer shape used at UI and IPC boundaries.
 */

import { z } from 'zod';
import type {
  AssistantTurnEvent,
  AssistantTurnEventType,
  AssistantTurnProcess,
  AssistantTurnProcessStep,
  AssistantTurnProjection,
  AssistantTurnSubagent,
  AssistantTurnSubagentStatus,
  AssistantTurnTimelineItem,
  AssistantTurnToolRef,
} from '../turns/assistantTurn';

export const assistantTurnEventTypeSchema = z.enum([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'status',
  'error',
  'delta',
  'progress',
]) satisfies z.ZodType<AssistantTurnEventType>;

export const assistantTurnEventSchema = z.object({
  eventType: assistantTurnEventTypeSchema,
  content: z.string(),
  deltaKind: z.enum(['text', 'thinking', 'tool_input']).optional(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolUseId: z.string().optional(),
}) satisfies z.ZodType<AssistantTurnEvent>;

export const assistantTurnToolRefSchema = z.object({
  toolName: z.string(),
  toolInput: z.string().optional(),
  toolUseId: z.string().optional(),
}) satisfies z.ZodType<AssistantTurnToolRef>;

export const assistantTurnNarrationStepSchema = z.object({
  kind: z.literal('narration'),
  text: z.string(),
}) satisfies z.ZodType<Extract<AssistantTurnProcessStep, { kind: 'narration' }>>;

export const assistantTurnToolGroupStepSchema = z.object({
  kind: z.literal('toolGroup'),
  tools: z.array(assistantTurnToolRefSchema),
}) satisfies z.ZodType<Extract<AssistantTurnProcessStep, { kind: 'toolGroup' }>>;

export const assistantTurnProcessStepSchema = z.discriminatedUnion('kind', [
  assistantTurnNarrationStepSchema,
  assistantTurnToolGroupStepSchema,
]) satisfies z.ZodType<AssistantTurnProcessStep>;

export const assistantTurnReasoningTimelineItemSchema = z.object({
  kind: z.literal('reasoning'),
  text: z.string(),
}) satisfies z.ZodType<Extract<AssistantTurnTimelineItem, { kind: 'reasoning' }>>;

export const assistantTurnTimelineItemSchema = z.discriminatedUnion('kind', [
  assistantTurnReasoningTimelineItemSchema,
  assistantTurnNarrationStepSchema,
  assistantTurnToolGroupStepSchema,
]) satisfies z.ZodType<AssistantTurnTimelineItem>;

export const assistantTurnProcessSchema = z.object({
  steps: z.array(assistantTurnProcessStepSchema),
}) satisfies z.ZodType<AssistantTurnProcess>;

export const assistantTurnSubagentStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
]) satisfies z.ZodType<AssistantTurnSubagentStatus>;

export const assistantTurnSubagentSchema = z.object({
  id: z.string(),
  label: z.string(),
  agentType: z.string().optional(),
  status: assistantTurnSubagentStatusSchema,
}) satisfies z.ZodType<AssistantTurnSubagent>;

export const assistantTurnProjectionSchema = z.object({
  schemaVersion: z.literal(2),
  answer: z.string(),
  reasoning: z.string(),
  reasoningBlocks: z.array(z.string()),
  process: assistantTurnProcessSchema,
  timeline: z.array(assistantTurnTimelineItemSchema),
  subagents: z.array(assistantTurnSubagentSchema),
}) satisfies z.ZodType<AssistantTurnProjection>;
