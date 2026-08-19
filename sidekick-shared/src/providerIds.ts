/** Browser-safe provider ID catalogs. Types are derived from these values. */
export const SESSION_PROVIDER_IDS = ['claude-code', 'opencode', 'codex'] as const;
export type SessionProviderId = (typeof SESSION_PROVIDER_IDS)[number];

export const ACCOUNT_PROVIDER_IDS = ['claude-code', 'codex'] as const;
export type AccountProviderId = (typeof ACCOUNT_PROVIDER_IDS)[number];

export const QUOTA_PROVIDER_IDS = ['claude-code', 'codex', 'zai'] as const;
export type QuotaProviderId = (typeof QUOTA_PROVIDER_IDS)[number];

export const RUNTIME_QUOTA_PROVIDER_IDS = ['claude', 'codex', 'zai'] as const;
export type RuntimeQuotaProviderId = (typeof RUNTIME_QUOTA_PROVIDER_IDS)[number];

export const MODEL_PROVIDER_IDS = ['anthropic', 'openai', 'google', 'unknown'] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];
