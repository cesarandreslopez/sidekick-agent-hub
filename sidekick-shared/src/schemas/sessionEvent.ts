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
  SummarySessionEvent,
  PermissionMode,
} from '../types/sessionEvent';
import { normalizedUsageSchema } from './usageNormalization';

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
  normalizedUsage: normalizedUsageSchema.optional(),
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

const eventBaseShape = {
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
  compaction: z
    .object({
      tokensBefore: z.number().nonnegative(),
      tokensAfter: z.number().nonnegative(),
    })
    .optional(),
  providerMetadata: z
    .object({
      providerId: z.string().optional(),
      source: z.string().optional(),
      retryAttempts: z.array(z.number()).optional(),
      finishReasons: z.array(z.string()).optional(),
      providerError: z
        .object({
          type: z.string().optional(),
          message: z.string().optional(),
          code: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
    })
    .optional(),
} as const;

const compactionSchema = z
  .object({
    tokensBefore: z.number().finite().int().nonnegative(),
    tokensAfter: z.number().finite().int().nonnegative(),
  })
  .refine((value) => value.tokensAfter <= value.tokensBefore, {
    message: 'tokensAfter must not exceed tokensBefore',
  });

export const userSessionEventSchema = z.object({
  type: z.literal('user'),
  message: sessionMessageSchema,
  ...eventBaseShape,
});

export const assistantSessionEventSchema = z.object({
  type: z.literal('assistant'),
  message: sessionMessageSchema,
  ...eventBaseShape,
});

const summaryWithMessageSchema = z.object({
  type: z.literal('summary'),
  message: sessionMessageSchema,
  summary: z.string().min(1).optional(),
  ...eventBaseShape,
  compaction: compactionSchema.optional(),
});

const summaryWithTextSchema = z.object({
  type: z.literal('summary'),
  message: sessionMessageSchema.optional(),
  summary: z.string().min(1),
  ...eventBaseShape,
  compaction: compactionSchema.optional(),
});

const summaryWithCompactionSchema = z.object({
  type: z.literal('summary'),
  message: sessionMessageSchema.optional(),
  summary: z.string().min(1).optional(),
  ...eventBaseShape,
  compaction: compactionSchema,
});

export const summarySessionEventSchema: z.ZodType<SummarySessionEvent> = z.union([
  summaryWithMessageSchema,
  summaryWithTextSchema,
  summaryWithCompactionSchema,
]);

export const systemSessionEventSchema = z.object({
  type: z.literal('system'),
  message: sessionMessageSchema.optional(),
  ...eventBaseShape,
});

export const toolUseSessionEventSchema = z.object({
  type: z.literal('tool_use'),
  message: sessionMessageSchema.optional(),
  ...eventBaseShape,
  tool: z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }),
});

export const toolResultSessionEventSchema = z.object({
  type: z.literal('tool_result'),
  message: sessionMessageSchema.optional(),
  ...eventBaseShape,
  result: z.object({
    tool_use_id: z.string(),
    output: z.unknown().optional(),
    is_error: z.boolean().optional(),
  }),
});

export const sessionEventSchema: z.ZodType<SessionEvent> = z.union([
  userSessionEventSchema,
  assistantSessionEventSchema,
  summarySessionEventSchema,
  systemSessionEventSchema,
  toolUseSessionEventSchema,
  toolResultSessionEventSchema,
]);

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
