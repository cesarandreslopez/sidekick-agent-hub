/**
 * Zod schemas for runtime validation of active account status.
 *
 * These schemas mirror the TypeScript interfaces in `accountStatus.ts`
 * (keep in sync when those change). They let consumers validate account
 * status payloads at process/IPC boundaries without hand-mirroring the
 * interfaces.
 *
 * @module schemas/accountStatus
 */

import { z } from 'zod';
import type { ActiveProviderAccountStatus, ActiveAccountStatus } from '../accountStatus';

// ── ActiveProviderAccountStatus ──

export const activeProviderAccountStatusSchema = z.object({
  present: z.boolean(),
  email: z.string().optional(),
  label: z.string().optional(),
}) satisfies z.ZodType<ActiveProviderAccountStatus>;

// ── ActiveAccountStatus ──

export const activeAccountStatusSchema = z.object({
  ok: z.boolean(),
  claude: activeProviderAccountStatusSchema,
  codex: activeProviderAccountStatusSchema,
  error: z.string().optional(),
}) satisfies z.ZodType<ActiveAccountStatus>;
