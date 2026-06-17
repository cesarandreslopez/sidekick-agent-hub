/**
 * Zod schemas for runtime validation of quota state.
 *
 * These schemas mirror the TypeScript interfaces in `quota.ts`,
 * `peakHours.ts`, `quotaPresentation.ts`, and `providerQuota.ts` (keep in
 * sync when those change). They let consumers validate quota payloads at
 * process/IPC boundaries without hand-mirroring the interfaces.
 *
 * @module schemas/quota
 */

import { z } from 'zod';
import type { QuotaWindow, QuotaState } from '../quota';
import type { PeakHoursState } from '../peakHours';
import type { QuotaFailureDescriptor } from '../quotaPresentation';
import type {
  ProviderQuotaState,
  ProviderQuotaMap,
  RuntimeQuotaProvider,
} from '../providerQuota';

// ── QuotaWindow ──

export const quotaWindowSchema = z.object({
  utilization: z.number(),
  resetsAt: z.string(),
}) satisfies z.ZodType<QuotaWindow>;

// ── QuotaState ──

export const quotaFailureKindSchema = z.enum([
  'auth',
  'network',
  'rate_limit',
  'server',
  'unknown',
]) satisfies z.ZodType<NonNullable<QuotaState['failureKind']>>;

export const quotaProviderIdSchema = z.enum([
  'claude-code',
  'codex',
]) satisfies z.ZodType<NonNullable<QuotaState['providerId']>>;

export const quotaSourceSchema = z.enum([
  'api',
  'session',
  'cache',
]) satisfies z.ZodType<NonNullable<QuotaState['source']>>;

export const quotaStateSchema = z.object({
  fiveHour: quotaWindowSchema,
  sevenDay: quotaWindowSchema,
  available: z.boolean(),
  error: z.string().optional(),
  failureKind: quotaFailureKindSchema.optional(),
  httpStatus: z.number().optional(),
  retryAfterMs: z.number().optional(),
  projectedFiveHour: z.number().optional(),
  projectedSevenDay: z.number().optional(),
  providerId: quotaProviderIdSchema.optional(),
  source: quotaSourceSchema.optional(),
  capturedAt: z.string().optional(),
  stale: z.boolean().optional(),
  fiveHourLabel: z.string().optional(),
  sevenDayLabel: z.string().optional(),
  limitId: z.string().optional(),
  limitName: z.string().optional(),
  credits: z.unknown().optional(),
  planType: z.string().optional(),
  rateLimitReachedType: z.string().optional(),
}) satisfies z.ZodType<QuotaState>;

// ── PeakHoursState ──

export const peakHoursStateSchema = z.object({
  status: z.enum(['peak', 'off_peak', 'unknown']),
  isPeak: z.boolean(),
  sessionLimitSpeed: z.enum(['normal', 'faster', 'unknown']),
  label: z.string(),
  peakHoursDescription: z.string(),
  nextChange: z.string().nullable(),
  minutesUntilChange: z.number().nullable(),
  note: z.string(),
  updatedAt: z.string(),
  unavailable: z.boolean(),
  notApplicable: z.boolean().optional(),
}) satisfies z.ZodType<PeakHoursState>;

// ── QuotaFailureDescriptor ──

export const quotaFailureDescriptorSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  title: z.string(),
  message: z.string(),
  detail: z.string().optional(),
  alertKey: z.string(),
  isRetryable: z.boolean(),
}) satisfies z.ZodType<QuotaFailureDescriptor>;

// ── ProviderQuotaState / ProviderQuotaMap ──

export const runtimeQuotaProviderSchema = z.enum([
  'claude',
  'codex',
]) satisfies z.ZodType<RuntimeQuotaProvider>;

/** Fields ProviderQuotaState adds on top of QuotaState, minus the provider tag. */
const providerQuotaExtensionShape = {
  accountLabel: z.string().optional(),
  accountDetail: z.string().optional(),
  peakHours: peakHoursStateSchema.nullable().optional(),
  failure: quotaFailureDescriptorSchema.nullable().optional(),
};

export const providerQuotaStateSchema = quotaStateSchema.extend({
  runtimeProvider: runtimeQuotaProviderSchema,
  ...providerQuotaExtensionShape,
}) satisfies z.ZodType<ProviderQuotaState>;

export const claudeProviderQuotaStateSchema = quotaStateSchema.extend({
  runtimeProvider: z.literal('claude'),
  ...providerQuotaExtensionShape,
}) satisfies z.ZodType<ProviderQuotaState<'claude'>>;

export const codexProviderQuotaStateSchema = quotaStateSchema.extend({
  runtimeProvider: z.literal('codex'),
  ...providerQuotaExtensionShape,
}) satisfies z.ZodType<ProviderQuotaState<'codex'>>;

export const providerQuotaMapSchema = z.object({
  claude: claudeProviderQuotaStateSchema.optional(),
  codex: codexProviderQuotaStateSchema.optional(),
}) satisfies z.ZodType<ProviderQuotaMap>;
