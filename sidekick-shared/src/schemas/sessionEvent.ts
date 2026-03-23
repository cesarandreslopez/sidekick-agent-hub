/**
 * Zod schemas for runtime validation of session events.
 *
 * These schemas mirror the TypeScript interfaces in `types/sessionEvent.ts`
 * and can be used to validate raw JSONL data before processing.
 *
 * @module schemas/sessionEvent
 */

import { z } from 'zod';
import type {
  MessageUsage,
  SessionMessage,
  SessionEvent,
  PermissionMode,
} from '../types/sessionEvent';

// ── MessageUsage ──

export const messageUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  reported_cost: z.number().optional(),
  reasoning_tokens: z.number().optional(),
}) satisfies z.ZodType<MessageUsage>;

// ── SessionMessage ──

export const sessionMessageSchema = z.object({
  role: z.string(),
  id: z.string().optional(),
  model: z.string().optional(),
  usage: messageUsageSchema.optional(),
  content: z.unknown().optional(),
}) satisfies z.ZodType<SessionMessage>;

// ── PermissionMode ──

export const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]) satisfies z.ZodType<PermissionMode>;

// ── SessionEvent ──

export const sessionEventSchema = z.object({
  type: z.enum(['user', 'assistant', 'tool_use', 'tool_result', 'summary']),
  message: sessionMessageSchema,
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  permissionMode: permissionModeSchema.optional(),
  tool: z.object({
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }).optional(),
  result: z.object({
    tool_use_id: z.string(),
    output: z.unknown().optional(),
    is_error: z.boolean().optional(),
  }).optional(),
}) satisfies z.ZodType<SessionEvent>;
