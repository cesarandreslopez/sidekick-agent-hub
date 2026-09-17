/**
 * Pure helpers over the Codex CLI `auth.json` payload. No filesystem access
 * beyond an optional mtime fallback, no child processes.
 */
import * as fs from 'fs';

export interface CodexAuthJsonFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  last_refresh?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

export interface CodexAuthIdentity {
  email?: string;
  workspaceId?: string;
  planType?: string;
  authMode: 'chatgpt' | 'api-key';
}

// Codex refreshes OAuth tokens at most every 8 days; a stored refresh token
// older than that may already be rejected by the auth server.
export const STALE_AUTH_THRESHOLD_MS = 8 * 24 * 60 * 60 * 1000;

export function parseJwtPayload<T>(jwt: string): T | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

export function parseAuthJson(raw: string | null): CodexAuthJsonFile | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CodexAuthJsonFile;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function readAuthIdentityFromRaw(raw: string | null): CodexAuthIdentity | null {
  const parsed = parseAuthJson(raw);
  if (!parsed) return null;

  const idToken = parsed.tokens?.id_token;
  const claims = idToken ? parseJwtPayload<Record<string, unknown>>(idToken) : null;
  const profileClaims = claims?.['https://api.openai.com/profile'] as
    | Record<string, unknown>
    | undefined;
  const authClaims = claims?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;

  const email =
    typeof claims?.email === 'string'
      ? claims.email
      : typeof profileClaims?.email === 'string'
        ? profileClaims.email
        : undefined;

  const workspaceId =
    typeof authClaims?.chatgpt_account_id === 'string'
      ? authClaims.chatgpt_account_id
      : parsed.tokens?.account_id;

  const planType =
    typeof authClaims?.chatgpt_plan_type === 'string' ? authClaims.chatgpt_plan_type : undefined;

  const authMode = parsed.OPENAI_API_KEY || parsed.auth_mode === 'api_key' ? 'api-key' : 'chatgpt';

  return { email, workspaceId, planType, authMode };
}

export function readLastRefresh(raw: string | null, fallbackPath?: string): number | null {
  const parsed = parseAuthJson(raw);
  if (parsed?.last_refresh) {
    const ts = Date.parse(parsed.last_refresh);
    if (!Number.isNaN(ts)) return ts;
  }
  if (fallbackPath) {
    try {
      return fs.statSync(fallbackPath).mtimeMs;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Expiry (ms since epoch) of the access token JWT, when it carries `exp`. */
export function readAccessTokenExpiry(raw: string | null): number | null {
  const parsed = parseAuthJson(raw);
  const accessToken = parsed?.tokens?.access_token;
  if (!accessToken) return null;
  const claims = parseJwtPayload<{ exp?: unknown }>(accessToken);
  return typeof claims?.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
}

/** Workspace id first (a ChatGPT workspace is one seat), then email. */
export function identitiesMatch(
  a: { email?: string; workspaceId?: string } | null | undefined,
  b: { email?: string; workspaceId?: string } | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.workspaceId && b.workspaceId) return a.workspaceId === b.workspaceId;
  return Boolean(a.email && b.email && a.email === b.email);
}
