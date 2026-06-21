/**
 * Zod schemas for runtime validation of account management payloads.
 *
 * These schemas mirror the TypeScript interfaces in `accounts.ts`,
 * `accountRegistry.ts`, and `accountManager.ts` (keep in sync when those
 * change). They let consumers validate account-management IPC payloads
 * without hand-mirroring the interfaces.
 *
 * @module schemas/accountManager
 */

import { z } from 'zod';
import type { AccountEntry, AccountManagerResult } from '../accounts';
import type {
  AccountIdentityMetadata,
  AccountProviderId,
  SavedAccountProfile,
} from '../accountRegistry';
import type {
  AccountLoginStatus,
  BeginAccountLoginResult,
  ListAllAccountsResult,
} from '../accountManager';

// ── AccountProviderId ──

export const accountProviderIdSchema = z.enum([
  'claude-code',
  'codex',
]) satisfies z.ZodType<AccountProviderId>;

// ── AccountManagerResult ──

export const accountManagerResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  warning: z.string().optional(),
  needsLogin: z.boolean().optional(),
  profileId: z.string().optional(),
  codexHome: z.string().optional(),
}) satisfies z.ZodType<AccountManagerResult>;

// ── BeginAccountLoginResult ──

const beginAccountLoginSuccessSchema = z.object({
  success: z.literal(true),
  loginId: z.string(),
  alreadyComplete: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  configDir: z.string().optional(),
});

const beginAccountLoginFailureSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

export const beginAccountLoginResultSchema = z.union([
  beginAccountLoginSuccessSchema,
  beginAccountLoginFailureSchema,
]) satisfies z.ZodType<BeginAccountLoginResult>;

// ── AccountLoginStatus ──

export const accountLoginStatusSchema = z.object({
  state: z.enum(['pending', 'authenticated', 'failed']),
  email: z.string().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<AccountLoginStatus>;

// ── AccountEntry ──

export const accountEntrySchema = z.object({
  uuid: z.string(),
  email: z.string(),
  label: z.string().optional(),
  addedAt: z.string(),
}) satisfies z.ZodType<AccountEntry>;

// ── SavedAccountProfile ──

const accountIdentityMetadataSchema = z.object({
  email: z.string().optional(),
  workspaceId: z.string().optional(),
  planType: z.string().optional(),
  authMode: z.enum(['chatgpt', 'api-key', 'unknown']).optional(),
}) satisfies z.ZodType<AccountIdentityMetadata>;

export const savedAccountProfileSchema = z.object({
  id: z.string(),
  providerId: accountProviderIdSchema,
  addedAt: z.string(),
  label: z.string().optional(),
  email: z.string().optional(),
  providerAccountId: z.string().optional(),
  metadata: accountIdentityMetadataSchema.optional(),
}) satisfies z.ZodType<SavedAccountProfile>;

// ── ListAllAccountsResult ──

export const listAllAccountsResultSchema = z.object({
  claude: z.array(accountEntrySchema),
  codex: z.array(savedAccountProfileSchema),
  activeByProvider: z.object({
    'claude-code': z.string().nullable(),
    codex: z.string().nullable(),
  }),
}) satisfies z.ZodType<ListAllAccountsResult>;
