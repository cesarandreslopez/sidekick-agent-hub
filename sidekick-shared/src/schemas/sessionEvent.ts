/**
 * Zod schemas for runtime validation of session events.
 *
 * These schemas mirror the TypeScript interfaces in `types/sessionEvent.ts`
 * and can be used to validate raw JSONL data before processing.
 *
 * @module schemas/sessionEvent
 */

import * as z from 'zod';
import type {
  MessageUsage,
  SessionMessage,
  SessionEvent,
  SessionEventBase,
  SummarySessionEvent,
  PermissionMode,
} from '../types/sessionEvent';
import { normalizedUsageSchema } from './usageNormalization';
import {
  TASK_STATUS_BLOCK_TYPE,
  TASK_STATUS_ORIGIN_KIND,
  isFinalTaskStatus,
  taskNotificationPromptFromAttachment,
  taskStatusFromAttachment,
} from '../subagentSpawn';
import {
  HOOK_ACTIVITY_BLOCK_TYPE,
  HOOK_ACTIVITY_ORIGIN_KIND,
  hookActivityFromAttachment,
} from '../hookActivity';
import {
  MEMORY_ATTACHMENT_BLOCK_TYPE,
  MEMORY_ATTACHMENT_ORIGIN_KIND,
  memoryAttachmentFromAttachment,
} from '../memoryAttachment';

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
  usageKind: z.enum(['call', 'correction']).optional(),
  content: z.unknown().optional(),
  // Streaming lines can carry `stop_reason: null`; rejecting it dropped the
  // whole event (text, tools, and usage), so normalize it to absent.
  stop_reason: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
}) satisfies z.ZodType<SessionMessage>;

// ── PermissionMode ──

export const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
  'dontAsk',
]) satisfies z.ZodType<PermissionMode>;

// ── SessionEvent ──

const compactionTriggerSchema = z.enum(['auto', 'manual']).optional().catch(undefined);

const eventBaseShape = {
  timestamp: z.string(),
  entrypoint: z.string().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  origin: z.object({ kind: z.string().optional() }).optional(),
  promptSource: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  // A mode this release doesn't know is dropped rather than rejecting the
  // whole line with its prompt or tool results.
  permissionMode: permissionModeSchema.optional().catch(undefined),
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
      trigger: compactionTriggerSchema,
    })
    .optional(),
  // A malformed agent id is dropped rather than rejecting the line.
  agentId: z.string().min(1).max(128).optional().catch(undefined),
  // Only decision, source and reasonType are kept; Claude Code's other
  // fields (ruleSource, grantScope, reasonCode, …) are stripped.
  permissionDecision: z
    .object({
      decision: z.string().min(1).max(32),
      source: z.string().max(64).optional().catch(undefined),
      reasonType: z.string().max(64).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
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
      contextWindowTokens: z.number().int().positive().optional().catch(undefined),
    })
    .optional(),
} as const;

const compactionSchema = z
  .object({
    tokensBefore: z.number().finite().int().nonnegative(),
    tokensAfter: z.number().finite().int().nonnegative(),
    trigger: compactionTriggerSchema,
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
  // Claude Code's system-line subtype (`agents_killed`, `turn_duration`, …);
  // a malformed one is dropped rather than rejecting the line.
  subtype: z.string().optional().catch(undefined),
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

/** Options for {@link extractSessionEvents}. */
export interface ExtractSessionEventsOptions {
  /**
   * Also turn Claude Code's mid-turn task-notification attachments
   * (`{ type: 'attachment', attachment: { type: 'queued_command',
   * commandMode: 'task-notification', prompt } }`) into one `system` event
   * with `origin: { kind: 'task-notification' }`, `message: { role: 'user',
   * sourceLabel: 'task notification', content: <prompt> }`, and the line's
   * timestamp. They report background agents finishing (or, as plain text,
   * the user stopping them: see `parseAgentsStoppedNotice`).
   *
   * Also turns a background agent's `task_status` attachment with a final
   * status (`{ type: 'attachment', attachment: { type: 'task_status',
   * taskType: 'local_agent', taskId, status: 'completed', … } }`) into a
   * `system` event with `origin: { kind: 'task-status' }` and `message: {
   * role: 'system', sourceLabel: 'task status', content: [{ type:
   * 'task_status', taskId, taskType, status, description }] }` (read it with
   * `taskStatusFromEvent`). Default `false`: attachment lines yield no events.
   *
   * System lines (`agents_killed` among them) parse either way and keep
   * their `subtype`.
   */
  includeTaskNotifications?: boolean;
  /**
   * Also turn Claude Code's hook attachments (`hook_success`,
   * `hook_non_blocking_error`, `hook_additional_context`, …) into `system`
   * events with `origin: { kind: 'hook' }` (read them with
   * `hookActivityFromEvent`), and its `nested_memory` attachments into
   * `system` events with `origin: { kind: 'memory-attachment' }` (read them
   * with `memoryAttachmentFromEvent`). Both are content-free: a hook's
   * command, output and added text, and a memory file's text, are never
   * kept. Default `false`.
   */
  includeActivitySignals?: boolean;
}

/**
 * Extracts canonical SessionEvents from a raw JSONL value.
 *
 * Claude Code wraps subagent/SDK events as
 * `{ type: 'progress', data: { message: <SessionEvent> } }`, which
 * `sessionEventSchema` alone rejects. This helper tries a direct parse,
 * then unwraps progress envelopes (recursively, in case of nesting).
 * Returns zero events for unrecognized input — never throws.
 *
 * The second argument is either the starting progress depth (the original
 * signature) or an options object.
 */
export function extractSessionEvents(raw: unknown, depth?: number): SessionEvent[];
export function extractSessionEvents(
  raw: unknown,
  options?: ExtractSessionEventsOptions,
): SessionEvent[];
export function extractSessionEvents(
  raw: unknown,
  depthOrOptions: number | ExtractSessionEventsOptions = 0,
): SessionEvent[] {
  if (typeof depthOrOptions === 'number') {
    return extractSessionEventsWithProvenance(raw, depthOrOptions, {}, {});
  }
  return extractSessionEventsWithProvenance(raw, 0, {}, depthOrOptions ?? {});
}

type ProgressProvenance = Pick<
  SessionEventBase,
  'entrypoint' | 'isMeta' | 'isSidechain' | 'cwd' | 'gitBranch' | 'agentId'
>;

/**
 * A Claude Code `compact_boundary` system line with its counts copied into
 * `compaction`: `compactMetadata.preTokens` / `postTokens` (finite integers,
 * post ≤ pre) and the `trigger`. The raw metadata is stripped by the schema;
 * a boundary without both counts parses as before.
 */
function withCompactBoundaryCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const line = raw as Record<string, unknown>;
  if (line.type !== 'system' || line.subtype !== 'compact_boundary' || line.compaction) {
    return raw;
  }
  const metadata = line.compactMetadata;
  if (typeof metadata !== 'object' || metadata === null) return raw;
  const { preTokens, postTokens, trigger } = metadata as Record<string, unknown>;
  if (
    !Number.isInteger(preTokens) ||
    !Number.isInteger(postTokens) ||
    (postTokens as number) < 0 ||
    (postTokens as number) > (preTokens as number)
  ) {
    return raw;
  }
  return {
    ...line,
    compaction: {
      tokensBefore: preTokens,
      tokensAfter: postTokens,
      ...(trigger === 'auto' || trigger === 'manual' ? { trigger } : {}),
    },
  };
}

function extractSessionEventsWithProvenance(
  raw: unknown,
  depth: number,
  inherited: ProgressProvenance,
  options: ExtractSessionEventsOptions,
): SessionEvent[] {
  const direct = sessionEventSchema.safeParse(withCompactBoundaryCounts(raw));
  if (direct.success) return [{ ...inherited, ...direct.data }];

  if (options.includeTaskNotifications) {
    const notification = taskNotificationAttachmentEvent(raw) ?? taskStatusAttachmentEvent(raw);
    if (notification) return [{ ...inherited, ...notification }];
  }

  if (options.includeActivitySignals) {
    const signal = hookAttachmentEvent(raw) ?? memoryAttachmentEvent(raw);
    if (signal) return [{ ...inherited, ...signal }];
  }

  if (depth >= MAX_PROGRESS_DEPTH) return [];
  if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'progress') {
    const provenance = { ...inherited, ...progressProvenance(raw) };
    const data = (raw as { data?: unknown }).data;
    if (typeof data === 'object' && data !== null) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === 'object' && message !== null) {
        return extractSessionEventsWithProvenance(message, depth + 1, provenance, options);
      }
    }
  }
  return [];
}

/** The `system` event for a task-notification attachment line, or `null`. */
function taskNotificationAttachmentEvent(raw: unknown): SessionEvent | null {
  const prompt = taskNotificationPromptFromAttachment(raw);
  if (prompt === null) return null;
  const line = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> = {
    type: 'system',
    timestamp: line.timestamp,
    origin: { kind: 'task-notification' },
    message: { role: 'user', sourceLabel: 'task notification', content: prompt },
  };
  for (const key of ['entrypoint', 'isSidechain', 'cwd', 'gitBranch']) {
    if (line[key] !== undefined) candidate[key] = line[key];
  }
  const parsed = systemSessionEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The `system` event for a background agent's final `task_status` attachment, or `null`. */
function taskStatusAttachmentEvent(raw: unknown): SessionEvent | null {
  const status = taskStatusFromAttachment(raw);
  if (!status || !isFinalTaskStatus(status.status)) return null;
  const line = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> = {
    type: 'system',
    timestamp: line.timestamp,
    origin: { kind: TASK_STATUS_ORIGIN_KIND },
    message: {
      role: 'system',
      sourceLabel: 'task status',
      content: [{ type: TASK_STATUS_BLOCK_TYPE, ...status }],
    },
  };
  for (const key of ['entrypoint', 'isSidechain', 'cwd', 'gitBranch']) {
    if (line[key] !== undefined) candidate[key] = line[key];
  }
  const parsed = systemSessionEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Line fields every attachment-derived `system` event keeps. */
const ATTACHMENT_PROVENANCE_KEYS = ['entrypoint', 'isSidechain', 'cwd', 'gitBranch', 'agentId'];

/** The content-free `system` event for a hook attachment line, or `null`. */
function hookAttachmentEvent(raw: unknown): SessionEvent | null {
  const activity = hookActivityFromAttachment(raw);
  if (!activity) return null;
  const line = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> = {
    type: 'system',
    timestamp: line.timestamp,
    origin: { kind: HOOK_ACTIVITY_ORIGIN_KIND },
    message: {
      role: 'system',
      sourceLabel: 'hook',
      content: [{ type: HOOK_ACTIVITY_BLOCK_TYPE, ...activity }],
    },
  };
  for (const key of ATTACHMENT_PROVENANCE_KEYS) {
    if (line[key] !== undefined) candidate[key] = line[key];
  }
  const parsed = systemSessionEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The content-free `system` event for a memory attachment line, or `null`. */
function memoryAttachmentEvent(raw: unknown): SessionEvent | null {
  const memory = memoryAttachmentFromAttachment(raw);
  if (!memory) return null;
  const line = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> = {
    type: 'system',
    timestamp: line.timestamp,
    origin: { kind: MEMORY_ATTACHMENT_ORIGIN_KIND },
    message: {
      role: 'system',
      sourceLabel: 'memory',
      content: [{ type: MEMORY_ATTACHMENT_BLOCK_TYPE, ...memory }],
    },
  };
  for (const key of ATTACHMENT_PROVENANCE_KEYS) {
    if (line[key] !== undefined) candidate[key] = line[key];
  }
  const parsed = systemSessionEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function progressProvenance(raw: object): ProgressProvenance {
  const value = raw as Record<string, unknown>;
  const provenance: ProgressProvenance = {};
  if (typeof value.entrypoint === 'string') provenance.entrypoint = value.entrypoint;
  if (typeof value.isMeta === 'boolean') provenance.isMeta = value.isMeta;
  if (typeof value.isSidechain === 'boolean') provenance.isSidechain = value.isSidechain;
  if (typeof value.cwd === 'string') provenance.cwd = value.cwd;
  if (typeof value.gitBranch === 'string') provenance.gitBranch = value.gitBranch;
  if (typeof value.agentId === 'string' && value.agentId) provenance.agentId = value.agentId;
  return provenance;
}
