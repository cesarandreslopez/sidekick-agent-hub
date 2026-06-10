/**
 * Zod schemas for runtime validation of quota history records.
 *
 * These schemas mirror the TypeScript interfaces in `quotaHistory.ts`
 * (keep in sync when those change). They let consumers validate quota
 * history payloads at process/IPC boundaries without hand-mirroring
 * the interfaces.
 *
 * @module schemas/quotaHistory
 */

import { z } from 'zod';
import type {
  QuotaHistoryRuntimeProvider,
  QuotaHistorySample,
  QuotaHistoryDailyBucket,
} from '../quotaHistory';

// ── QuotaHistoryRuntimeProvider ──

export const quotaHistoryRuntimeProviderSchema = z.enum([
  'claude',
  'codex',
]) satisfies z.ZodType<QuotaHistoryRuntimeProvider>;

// ── QuotaHistorySample ──

export const quotaHistorySampleSchema = z.object({
  timestamp: z.string(),
  runtimeProvider: quotaHistoryRuntimeProviderSchema,
  providerId: z.string(),
  workspaceId: z.string(),
  fiveHour: z.object({ utilization: z.number(), resetsAt: z.string() }),
  sevenDay: z.object({ utilization: z.number(), resetsAt: z.string() }),
  available: z.boolean(),
  error: z.string().optional(),
  source: z.enum(['session', 'cache', 'api']).optional(),
  stale: z.boolean().optional(),
}) satisfies z.ZodType<QuotaHistorySample>;

// ── QuotaHistoryDailyBucket ──

export const quotaHistoryDailyBucketSchema = z.object({
  date: z.string(),
  samples: z.number(),
  maxUtilizationFiveHour: z.number(),
  maxUtilizationSevenDay: z.number(),
  avgUtilizationFiveHour: z.number(),
  avgUtilizationSevenDay: z.number(),
  anyUnavailable: z.boolean(),
}) satisfies z.ZodType<QuotaHistoryDailyBucket>;
