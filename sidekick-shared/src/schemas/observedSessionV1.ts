import { z } from 'zod';
import { SESSION_PROVIDER_IDS } from '../providerIds';

export const observationProvenanceV1Schema = z.enum(['reported', 'estimated', 'inferred']);
export const sessionEvidenceRefV1Schema = z.object({
  schemaVersion: z.literal(1),
  provider: z.enum(SESSION_PROVIDER_IDS),
  sessionId: z.string().min(1),
  sourcePath: z.string().optional(),
  eventIndex: z.number().int().nonnegative().optional(),
  eventId: z.string().optional(),
  timestamp: z.string().optional(),
});
export const observedValueV1Schema = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    provenance: observationProvenanceV1Schema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(sessionEvidenceRefV1Schema),
  });
export const pendingUserRequestV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  provider: z.enum(SESSION_PROVIDER_IDS),
  sessionId: z.string().min(1),
  kind: observedValueV1Schema(z.enum(['prompt_response', 'tool_approval', 'question'])),
  requestedAt: observedValueV1Schema(z.string()),
  prompt: observedValueV1Schema(z.string().nullable()),
});
export const observedAgentSessionV1Schema = z.object({
  schemaVersion: z.literal(1),
  identity: z.object({
    provider: z.enum(SESSION_PROVIDER_IDS),
    sessionId: z.string().min(1),
    sourcePath: z.string(),
  }),
  cwd: observedValueV1Schema(z.string()),
  model: observedValueV1Schema(z.string().nullable()),
  activity: observedValueV1Schema(z.enum(['active', 'idle', 'ended', 'unknown'])),
  usage: z.object({
    inputTokens: observedValueV1Schema(z.number().nonnegative()),
    outputTokens: observedValueV1Schema(z.number().nonnegative()),
    cacheReadTokens: observedValueV1Schema(z.number().nonnegative()),
    cacheWriteTokens: observedValueV1Schema(z.number().nonnegative()),
    normalized: observedValueV1Schema(
      z.object({
        uncachedInputTokens: z.number().finite().nonnegative(),
        cacheReadTokens: z.number().finite().nonnegative(),
        cacheWriteTokens: z.number().finite().nonnegative(),
        outputTokens: z.number().finite().nonnegative(),
        reasoningTokens: z.number().finite().nonnegative(),
        cacheInclusiveInputTokens: z.number().finite().nonnegative(),
        billableOutputTokens: z.number().finite().nonnegative(),
        totalTokens: z.number().finite().nonnegative(),
      }),
    ).optional(),
    costUsd: observedValueV1Schema(z.number().nonnegative().nullable()),
  }),
  pendingUserRequest: pendingUserRequestV1Schema.nullable(),
  contentObservedAt: z.string().optional(),
  observedAt: z.string(),
});
export const providerCapabilitiesV1Schema = z.object({
  schemaVersion: z.literal(1),
  provider: z.enum(SESSION_PROVIDER_IDS),
  resume: observedValueV1Schema(z.boolean()),
  forkLineage: observedValueV1Schema(z.boolean()),
  quotaSource: observedValueV1Schema(z.enum(['api', 'session', 'mixed', 'none'])),
  assetExtraction: observedValueV1Schema(z.boolean()),
});
export const providerSessionAdapterV1Schema = z.custom<
  import('../types/observedSessionV1').ProviderSessionAdapterV1
>(
  (value) => {
    if (!value || typeof value !== 'object') return false;
    const adapter = value as Record<string, unknown>;
    return (
      adapter.schemaVersion === 1 &&
      typeof adapter.discover === 'function' &&
      typeof adapter.read === 'function' &&
      typeof adapter.watch === 'function' &&
      typeof adapter.dispose === 'function' &&
      providerCapabilitiesV1Schema.safeParse(adapter.capabilities).success
    );
  },
  { message: 'Invalid ProviderSessionAdapterV1 contract' },
);
