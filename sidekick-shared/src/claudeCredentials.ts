/**
 * Pure helpers over the Claude Code credential blob (`claudeAiOauth`). No I/O.
 */

export interface ClaudeOauthCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Access token expiry, ms since epoch (~8 h after issue). */
  expiresAt?: number;
  /** Refresh token expiry, ms since epoch (~3 weeks after issue on current builds). */
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** Lifetime of a Claude Code access token. */
export const CLAUDE_ACCESS_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;
/**
 * Refresh-token lifetime observed on Claude Code 2.1.x. Used only to estimate
 * the refresh expiry of snapshots captured before the CLI recorded it.
 */
export const CLAUDE_REFRESH_TOKEN_LIFETIME_ESTIMATE_MS = 21 * 24 * 60 * 60 * 1000;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Parse the stored blob, tolerating the `mcpOAuth` sibling and unknown keys. */
export function parseClaudeCredentialBlob(blob: unknown): ClaudeOauthCredentials | null {
  if (!blob || typeof blob !== 'object') return null;
  const oauth = (blob as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return null;
  const record = oauth as Record<string, unknown>;
  if (typeof record.accessToken !== 'string' || !record.accessToken) return null;
  return {
    accessToken: record.accessToken,
    refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : undefined,
    expiresAt: finiteNumber(record.expiresAt),
    refreshTokenExpiresAt: finiteNumber(record.refreshTokenExpiresAt),
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === 'string')
      : undefined,
    subscriptionType:
      typeof record.subscriptionType === 'string' ? record.subscriptionType : undefined,
    rateLimitTier: typeof record.rateLimitTier === 'string' ? record.rateLimitTier : undefined,
  };
}

/**
 * Monotonic freshness clock: every refresh issues a new access token with a
 * later `expiresAt`, so the larger value is the newer credential.
 */
export function claudeCredentialFreshness(credentials: ClaudeOauthCredentials | null): number {
  if (!credentials) return 0;
  return credentials.expiresAt ?? credentials.refreshTokenExpiresAt ?? 0;
}

/** True when `candidate` is strictly newer than `existing`. */
export function isNewerClaudeCredential(
  candidate: ClaudeOauthCredentials | null,
  existing: ClaudeOauthCredentials | null,
): boolean {
  return claudeCredentialFreshness(candidate) > claudeCredentialFreshness(existing);
}

/**
 * When the refresh-token expiry was recorded, use it; otherwise estimate it
 * from the access-token issue time. Returns `estimated: true` for the latter.
 */
export function resolveClaudeRefreshExpiry(
  credentials: ClaudeOauthCredentials | null,
): { refreshExpiresAt: number; estimated: boolean } | null {
  if (!credentials) return null;
  if (credentials.refreshTokenExpiresAt !== undefined) {
    return { refreshExpiresAt: credentials.refreshTokenExpiresAt, estimated: false };
  }
  if (credentials.expiresAt !== undefined) {
    const issuedAt = credentials.expiresAt - CLAUDE_ACCESS_TOKEN_LIFETIME_MS;
    return {
      refreshExpiresAt: issuedAt + CLAUDE_REFRESH_TOKEN_LIFETIME_ESTIMATE_MS,
      estimated: true,
    };
  }
  return null;
}
