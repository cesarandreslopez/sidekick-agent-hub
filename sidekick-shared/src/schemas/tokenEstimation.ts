import { z } from 'zod';
import type { TokenEstimate } from '../tokenEstimation';

export const tokenEstimateSchema = z.object({
  count: z.number().finite().nonnegative(),
  method: z.enum(['exact', 'sidekick-fallback-v1']),
  confidence: z.enum(['exact', 'medium', 'low']),
  provenance: z.string(),
}) satisfies z.ZodType<TokenEstimate>;
