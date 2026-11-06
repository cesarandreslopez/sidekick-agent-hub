/**
 * Zod schema for runtime validation of provider-failure diagnoses.
 *
 * The enums are built from the same `as const` arrays that define the
 * TypeScript unions in `providerFailure.ts`, so a new failure code or recovery
 * action reaches the schema without a second edit.
 *
 * @module schemas/providerFailure
 */

import * as z from 'zod';
import { ACCOUNT_PROVIDER_IDS } from '../providerIds';
import {
  CODEX_ERROR_INFO_KINDS,
  PROVIDER_AUTHENTICATION_SOURCES,
  PROVIDER_AUTHENTICATION_STATES,
  PROVIDER_CREDENTIAL_KINDS,
  PROVIDER_FAILURE_CODES,
  PROVIDER_FAILURE_EVIDENCE_SOURCES,
  PROVIDER_RECOVERY_ACTIONS,
} from '../providerFailure';
import type {
  ProviderAuthenticationEvidence,
  ProviderFailureDiagnosis,
  ProviderFailureEvidence,
  ProviderRetryAfter,
} from '../providerFailure';

export const providerAuthenticationEvidenceSchema = z.object({
  credentialKind: z.enum(PROVIDER_CREDENTIAL_KINDS),
  state: z.enum(PROVIDER_AUTHENTICATION_STATES),
  checkedAt: z.string(),
  source: z.enum(PROVIDER_AUTHENTICATION_SOURCES),
}) satisfies z.ZodType<ProviderAuthenticationEvidence>;

export const providerFailureEvidenceSchema = z.object({
  source: z.enum(PROVIDER_FAILURE_EVIDENCE_SOURCES),
  rule: z.enum(PROVIDER_FAILURE_CODES),
  checkedAt: z.string().optional(),
  codexErrorInfo: z.enum(CODEX_ERROR_INFO_KINDS).optional(),
}) satisfies z.ZodType<ProviderFailureEvidence>;

export const providerRetryAfterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delay'), delayMs: z.number() }),
  z.object({ kind: z.literal('date'), at: z.string() }),
]) satisfies z.ZodType<ProviderRetryAfter>;

export const providerFailureDiagnosisSchema = z.object({
  provider: z.enum(ACCOUNT_PROVIDER_IDS),
  credentialKind: z.enum(PROVIDER_CREDENTIAL_KINDS),
  diagnosis: z.enum(PROVIDER_FAILURE_CODES),
  recovery: z.enum(PROVIDER_RECOVERY_ACTIONS),
  retryable: z.boolean().optional(),
  evidence: z.array(providerFailureEvidenceSchema),
  authentication: providerAuthenticationEvidenceSchema.optional(),
  httpStatus: z.number().optional(),
  retryAfter: providerRetryAfterSchema.optional(),
}) satisfies z.ZodType<ProviderFailureDiagnosis>;

/**
 * Size and range limits enforced by `boundedProviderFailureDiagnosisSchema`.
 * Every value `diagnoseProviderFailure()` returns is well inside them.
 */
export const PROVIDER_FAILURE_DIAGNOSIS_BOUNDS = {
  /** `checkedAt` and `retryAfter.at` length; an ISO timestamp is 24 characters. */
  timestampMinChars: 1,
  timestampMaxChars: 32,
  /** `httpStatus`, an integer. */
  httpStatusMin: 100,
  httpStatusMax: 599,
  /** `retryAfter.delayMs`, finite. */
  delayMsMin: 0,
  delayMsMax: Number.MAX_SAFE_INTEGER,
  /** Entries in `evidence`; the classifier returns at most one. */
  maxEvidence: 8,
} as const;

const bounds = PROVIDER_FAILURE_DIAGNOSIS_BOUNDS;

const boundedTimestampSchema = z
  .string()
  .min(bounds.timestampMinChars)
  .max(bounds.timestampMaxChars)
  .refine((value) => Number.isFinite(Date.parse(value)), { message: 'Invalid timestamp' });

const boundedAuthenticationEvidenceSchema = providerAuthenticationEvidenceSchema.extend({
  checkedAt: boundedTimestampSchema,
}) satisfies z.ZodType<ProviderAuthenticationEvidence>;

const boundedEvidenceSchema = providerFailureEvidenceSchema.extend({
  checkedAt: boundedTimestampSchema.optional(),
  // A newer producer may name a Codex variant this release does not know;
  // drop the label rather than reject the whole diagnosis.
  codexErrorInfo: z.enum(CODEX_ERROR_INFO_KINDS).optional().catch(undefined),
}) satisfies z.ZodType<ProviderFailureEvidence>;

const boundedRetryAfterSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('delay'),
    delayMs: z.number().min(bounds.delayMsMin).max(bounds.delayMsMax),
  }),
  z.object({ kind: z.literal('date'), at: boundedTimestampSchema }),
]) satisfies z.ZodType<ProviderRetryAfter>;

/**
 * `providerFailureDiagnosisSchema` with size and range limits, for diagnoses
 * that cross a trust boundary (sent by another process, or stored by an older
 * or newer producer): timestamps of 1–32 characters that `Date.parse`
 * accepts, an integer `httpStatus` in 100–599, a finite nonnegative
 * `retryAfter.delayMs`, and at most 8 evidence entries. Unknown keys are
 * stripped, and an unknown `evidence[].codexErrorInfo` is dropped instead of
 * failing the parse.
 */
export const boundedProviderFailureDiagnosisSchema = providerFailureDiagnosisSchema.extend({
  evidence: z.array(boundedEvidenceSchema).max(bounds.maxEvidence),
  authentication: boundedAuthenticationEvidenceSchema.optional(),
  httpStatus: z.number().int().min(bounds.httpStatusMin).max(bounds.httpStatusMax).optional(),
  retryAfter: boundedRetryAfterSchema.optional(),
}) satisfies z.ZodType<ProviderFailureDiagnosis>;
