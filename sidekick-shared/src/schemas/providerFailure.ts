/**
 * Zod schema for runtime validation of provider-failure diagnoses.
 *
 * The enums are built from the same `as const` arrays that define the
 * TypeScript unions in `providerFailure.ts`, so a new failure code or recovery
 * action reaches the schema without a second edit.
 *
 * @module schemas/providerFailure
 */

import { z } from 'zod';
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
