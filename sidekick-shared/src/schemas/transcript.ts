import { z } from 'zod';
import type {
  CanonicalSessionTranscript,
  CanonicalTranscriptMessage,
  CanonicalToolCall,
  TranscriptSourceProvenance,
} from '../transcript';
import { normalizedUsageCostSchema, normalizedUsageSchema } from './usageNormalization';

export const transcriptSourceProvenanceSchema: z.ZodType<TranscriptSourceProvenance> = z.object({
  provider: z.string().optional(),
  sessionId: z.string().optional(),
  sourcePath: z.string().optional(),
  source: z.string().optional(),
  entrypoint: z.string().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  originalRole: z.string().optional(),
  eventIndex: z.number().int().nonnegative(),
  eventType: z.enum(['user', 'assistant', 'tool_use', 'tool_result', 'summary', 'system']),
  eventId: z.string().optional(),
});

export const canonicalTranscriptBlockSchema = z.object({
  type: z.enum(['text', 'thinking', 'tool_use', 'tool_result', 'image', 'unknown']),
  text: z.string().optional(),
  toolName: z.string().optional(),
  toolUseId: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  isError: z.boolean().optional(),
  command: z.string().optional(),
  truncated: z.boolean().optional(),
  raw: z.unknown().optional(),
});

export const canonicalToolCallSchema: z.ZodType<CanonicalToolCall> = z.object({
  id: z.string().optional(),
  name: z.string(),
  timestamp: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  isError: z.boolean().optional(),
  command: z.string().optional(),
  source: transcriptSourceProvenanceSchema,
});

export const canonicalTranscriptMessageSchema: z.ZodType<CanonicalTranscriptMessage> = z.object({
  id: z.string().optional(),
  role: z.enum(['user', 'assistant', 'system', 'summary', 'tool']),
  timestamp: z.string(),
  model: z.string().optional(),
  sourceLabel: z.string().optional(),
  content: z.array(canonicalTranscriptBlockSchema),
  text: z.string(),
  usage: normalizedUsageSchema.optional(),
  cost: normalizedUsageCostSchema.optional(),
  tools: z.array(canonicalToolCallSchema),
  commands: z.array(z.string()),
  source: transcriptSourceProvenanceSchema,
});

export const canonicalSessionTranscriptSchema: z.ZodType<CanonicalSessionTranscript> = z.object({
  provider: z.string().optional(),
  sessionId: z.string().optional(),
  sourcePath: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  models: z.array(z.string()),
  messages: z.array(canonicalTranscriptMessageSchema),
  tools: z.array(canonicalToolCallSchema),
  commands: z.array(z.string()),
  usage: z.object({
    events: z.array(normalizedUsageSchema),
    costs: z.array(normalizedUsageCostSchema),
    totals: z.object({
      uncachedInputTokens: z.number().finite().nonnegative(),
      cacheReadTokens: z.number().finite().nonnegative(),
      cacheWriteTokens: z.number().finite().nonnegative(),
      outputTokens: z.number().finite().nonnegative(),
      reasoningTokens: z.number().finite().nonnegative(),
      cacheInclusiveInputTokens: z.number().finite().nonnegative(),
      billableOutputTokens: z.number().finite().nonnegative(),
      totalTokens: z.number().finite().nonnegative(),
    }),
    totalCostUsd: z.number().finite().nonnegative().nullable(),
    pricedCostUsd: z.number().finite().nonnegative(),
    unpricedEvents: z.number().int().nonnegative(),
  }),
  provenance: z.object({
    source: z.literal('session-events'),
    fidelity: z.enum(['snippet', 'full']),
    eventCount: z.number().int().nonnegative(),
  }),
});
