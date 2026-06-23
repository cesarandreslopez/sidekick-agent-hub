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
  sourceLabel: z.string().optional(),
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
  type: z.enum(['user', 'assistant', 'tool_use', 'tool_result', 'summary', 'system']),
  message: sessionMessageSchema,
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  permissionMode: permissionModeSchema.optional(),
  rateLimits: z
    .object({
      primary: z
        .object({
          usedPercent: z.number(),
          windowMinutes: z.number(),
          resetsAt: z.number(),
        })
        .optional(),
      secondary: z
        .object({
          usedPercent: z.number(),
          windowMinutes: z.number(),
          resetsAt: z.number(),
        })
        .optional(),
    })
    .optional(),
  tool: z
    .object({
      name: z.string(),
      input: z.record(z.string(), z.unknown()),
    })
    .optional(),
  result: z
    .object({
      tool_use_id: z.string(),
      output: z.unknown().optional(),
      is_error: z.boolean().optional(),
    })
    .optional(),
}) satisfies z.ZodType<SessionEvent>;

// ── Progress unwrapping ──

/** Recursion bound for nested progress envelopes; real data nests 1 level. */
const MAX_PROGRESS_DEPTH = 8;

/**
 * Extracts canonical SessionEvents from a raw JSONL value.
 *
 * Claude Code wraps subagent/SDK events as
 * `{ type: 'progress', data: { message: <SessionEvent> } }`, which
 * `sessionEventSchema` alone rejects. This helper tries a direct parse,
 * then unwraps progress envelopes (recursively, in case of nesting).
 * Returns zero events for unrecognized input — never throws.
 */
export function extractSessionEvents(raw: unknown, depth = 0): SessionEvent[] {
  const direct = sessionEventSchema.safeParse(raw);
  if (direct.success) return [direct.data];

  if (depth >= MAX_PROGRESS_DEPTH) return [];
  if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'progress') {
    const data = (raw as { data?: unknown }).data;
    if (typeof data === 'object' && data !== null) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === 'object' && message !== null) {
        return extractSessionEvents(message, depth + 1);
      }
    }
  }
  return [];
}
