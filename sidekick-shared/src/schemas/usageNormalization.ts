import { z } from 'zod';
import type { NormalizedUsage, NormalizedUsageCost } from '../usageNormalization';

const normalizedUsageObjectSchema = z.object({
  uncachedInputTokens: z.number().finite().nonnegative(),
  cacheReadTokens: z.number().finite().nonnegative(),
  cacheWriteTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  reasoningTokens: z.number().finite().nonnegative(),
  reasoningIncludedInOutput: z.boolean(),
  cacheInclusiveInputTokens: z.number().finite().nonnegative(),
  billableOutputTokens: z.number().finite().nonnegative(),
  totalTokens: z.number().finite().nonnegative(),
  model: z.string().optional(),
  reportedCostUsd: z.number().finite().nonnegative().optional(),
  provenance: z.object({
    provider: z.string().optional(),
    semantics: z.enum(['anthropic-additive-cache', 'openai-inclusive-cache', 'sidekick-disjoint']),
    source: z.string().optional(),
  }),
});

export const normalizedUsageSchema = normalizedUsageObjectSchema.superRefine((usage, context) => {
  const expectedInput = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const expectedOutput =
    usage.outputTokens + (usage.reasoningIncludedInOutput ? 0 : usage.reasoningTokens);
  if (usage.cacheInclusiveInputTokens !== expectedInput) {
    context.addIssue({ code: 'custom', message: 'cacheInclusiveInputTokens is inconsistent' });
  }
  if (usage.billableOutputTokens !== expectedOutput) {
    context.addIssue({ code: 'custom', message: 'billableOutputTokens is inconsistent' });
  }
  if (usage.totalTokens !== expectedInput + expectedOutput) {
    context.addIssue({ code: 'custom', message: 'totalTokens is inconsistent' });
  }
}) satisfies z.ZodType<NormalizedUsage>;

export const normalizedUsageCostSchema = z.object({
  costUsd: z.number().finite().nonnegative().nullable(),
  source: z.enum(['provider-reported', 'explicit-pricing', 'model-catalog', 'unpriced']),
  modelId: z.string().optional(),
  usage: normalizedUsageSchema,
}) satisfies z.ZodType<NormalizedUsageCost>;
