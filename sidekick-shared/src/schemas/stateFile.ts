/**
 * Zod schema for the public `state.json` contract (`schemaVersion: 1`).
 *
 * Mirrors the interfaces in `stateFile.ts` (keep in sync when those change;
 * fields are only ever added). Consumers validating the file from another
 * process import this from `sidekick-shared/schemas`.
 *
 * @module schemas/stateFile
 */

import { z } from 'zod';
import type {
  SidekickStateFile,
  StateFileAccount,
  StateFileBillingBlock,
  StateFileContext,
  StateFileQuota,
  StateFileQuotaWindow,
  StateFileSession,
  StateFileWriter,
} from '../stateFile';

export const stateFileWriterSchema = z.enum([
  'statusline',
  'cli-dashboard',
  'vscode-dashboard',
]) satisfies z.ZodType<StateFileWriter>;

export const stateFileQuotaWindowSchema = z.object({
  utilization: z.number(),
  resetsAt: z.string(),
}) satisfies z.ZodType<StateFileQuotaWindow>;

export const stateFileQuotaSchema = z.object({
  fiveHour: stateFileQuotaWindowSchema,
  sevenDay: stateFileQuotaWindowSchema,
  source: z.enum(['api', 'session', 'cache', 'statusline']).nullable(),
  capturedSource: z.enum(['api', 'session', 'statusline']).nullable(),
  capturedAt: z.string().nullable(),
  ageMs: z.number().nullable(),
  freshness: z.enum(['fresh', 'aging', 'stale']).nullable(),
}) satisfies z.ZodType<StateFileQuota>;

export const stateFileAccountSchema = z.object({
  providerId: z.enum(['claude-code', 'codex']),
  id: z.string().nullable(),
  label: z.string().nullable(),
}) satisfies z.ZodType<StateFileAccount>;

export const stateFileContextSchema = z.object({
  usedPercentage: z.number().nullable(),
  contextWindowSize: z.number().nullable(),
  totalInputTokens: z.number().nullable(),
  totalOutputTokens: z.number().nullable(),
}) satisfies z.ZodType<StateFileContext>;

export const stateFileSessionSchema = z.object({
  sessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  linesAdded: z.number().nullable(),
  linesRemoved: z.number().nullable(),
  promptCacheHitRatio: z.number().nullable(),
}) satisfies z.ZodType<StateFileSession>;

export const stateFileBillingBlockSchema = z.object({
  start: z.string(),
  end: z.string(),
  isActive: z.boolean(),
  tokens: z.number(),
  costUsd: z.number(),
  costProvenance: z.enum(['reported', 'estimated', 'mixed', 'unpriced', 'none']),
  burnRatePerMinute: z.number(),
  projectedTokens: z.number(),
  projectedCostUsd: z.number(),
  remainingMs: z.number(),
}) satisfies z.ZodType<StateFileBillingBlock>;

export const sidekickStateFileSchema = z.object({
  schemaVersion: z.literal(1),
  writtenAt: z.string(),
  writer: stateFileWriterSchema,
  account: stateFileAccountSchema.nullable(),
  quota: z.object({
    claude: stateFileQuotaSchema.nullable(),
    codex: stateFileQuotaSchema.nullable(),
  }),
  context: stateFileContextSchema.nullable(),
  session: stateFileSessionSchema.nullable(),
  billingBlock: stateFileBillingBlockSchema.nullable(),
}) satisfies z.ZodType<SidekickStateFile>;
