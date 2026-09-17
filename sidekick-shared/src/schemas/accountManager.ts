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
import { ACCOUNT_PROVIDER_IDS } from '../providerIds';
import type { AccountHealth, AccountHealthSidecar, AccountView } from '../accountHealth';
import type { LastSwitchRecord, SwitchAccountResult } from '../accountSwitch';
import type { ProviderSyncReport, SyncReport } from '../accountSyncTypes';
import type { AccountLaunchEnv } from '../accountLaunch';
import type { RunningAccountConsumer, RunningProcess } from '../processDetection';

// ── AccountProviderId ──

export const accountProviderIdSchema = z.enum(
  ACCOUNT_PROVIDER_IDS,
) satisfies z.ZodType<AccountProviderId>;

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
  envUnset: z.array(z.string()).optional(),
  configDir: z.string().optional(),
  existingAccountId: z.string().optional(),
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
  origin: z.enum(['login', 'manual', 'live-sync', 'migration']).optional(),
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

// ── Account health ──

export const accountHealthStateSchema = z.enum([
  'fresh',
  'expiring',
  'expired',
  'unknown',
  'missing',
]);

export const accountHealthSourceSchema = z.enum([
  'live-sync',
  'login',
  'switch',
  'keepalive',
  'migration',
]);

export const accountHealthSidecarSchema = z.object({
  version: z.literal(1),
  capturedAt: z.number(),
  accessExpiresAt: z.number().optional(),
  refreshExpiresAt: z.number().optional(),
  refreshExpiryEstimated: z.boolean().optional(),
  lastRefreshAt: z.number().optional(),
  hasRefreshToken: z.boolean().optional(),
  authMode: z.enum(['chatgpt', 'api-key', 'oauth']).optional(),
  source: accountHealthSourceSchema,
}) satisfies z.ZodType<AccountHealthSidecar>;

export const accountHealthSchema = z.object({
  providerId: accountProviderIdSchema,
  accountId: z.string(),
  state: accountHealthStateSchema,
  accessExpiresAt: z.number().optional(),
  refreshExpiresAt: z.number().optional(),
  refreshExpiryEstimated: z.boolean().optional(),
  lastRefreshAt: z.number().optional(),
  checkedAt: z.number(),
  isLive: z.boolean(),
  reason: z.string().optional(),
}) satisfies z.ZodType<AccountHealth>;

export const accountViewSchema = z.object({
  id: z.string(),
  providerId: accountProviderIdSchema,
  label: z.string().optional(),
  email: z.string().optional(),
  planType: z.string().optional(),
  isActive: z.boolean(),
  health: accountHealthSchema,
  source: z.enum(['registered', 'learned']),
  addedAt: z.string(),
}) satisfies z.ZodType<AccountView>;

// ── Running consumers / switch result ──

export const runningProcessSchema = z.object({
  pid: z.number(),
  name: z.string(),
  command: z.string(),
}) satisfies z.ZodType<RunningProcess>;

export const accountConsumerKindSchema = z.enum([
  'claude-cli',
  'claude-desktop',
  'codex-cli',
  'codex-app',
  'vscode-extension-host',
]);

export const runningAccountConsumerSchema = z.object({
  kind: accountConsumerKindSchema,
  pids: z.array(z.number()),
  switched: z.boolean(),
  reachability: z.string(),
}) satisfies z.ZodType<RunningAccountConsumer>;

export const switchAccountResultSchema = accountManagerResultSchema.extend({
  provider: accountProviderIdSchema,
  accountId: z.string(),
  previousAccountId: z.string().nullable(),
  verified: z.boolean(),
  verification: z.enum(['store', 'cli', 'none', 'failed']),
  health: accountHealthSchema.optional(),
  warnings: z.array(z.string()),
  hints: z.array(z.string()),
  runningConsumers: z.array(runningAccountConsumerSchema),
  undoToken: z.string().optional(),
  alreadyActive: z.boolean().optional(),
  email: z.string().optional(),
}) satisfies z.ZodType<SwitchAccountResult>;

export const lastSwitchRecordSchema = z.object({
  token: z.string(),
  provider: accountProviderIdSchema,
  from: z.string().nullable(),
  to: z.string(),
  at: z.string(),
}) satisfies z.ZodType<LastSwitchRecord>;

// ── Sync report ──

export const providerSyncReportSchema = z.object({
  registered: z.object({ id: z.string(), email: z.string().optional() }).optional(),
  folded: z.string().optional(),
  repointed: z.string().optional(),
  merged: z.array(z.string()).optional(),
  skipped: z.string().optional(),
  warnings: z.array(z.string()),
}) satisfies z.ZodType<ProviderSyncReport>;

export const syncReportSchema = z.object({
  claude: providerSyncReportSchema,
  codex: providerSyncReportSchema,
  ranAt: z.number(),
  reason: z.enum(['startup', 'watch', 'poll', 'pre-switch', 'manual']),
}) satisfies z.ZodType<SyncReport>;

// ── Launch env ──

export const accountLaunchEnvSchema = z.object({
  provider: accountProviderIdSchema,
  accountId: z.string(),
  label: z.string().optional(),
  email: z.string().optional(),
  home: z.string(),
  env: z.record(z.string(), z.string()),
  envUnset: z.array(z.string()),
  command: z.enum(['claude', 'codex']),
  health: accountHealthSchema,
  warnings: z.array(z.string()),
  error: z.string().optional(),
}) satisfies z.ZodType<AccountLaunchEnv>;
