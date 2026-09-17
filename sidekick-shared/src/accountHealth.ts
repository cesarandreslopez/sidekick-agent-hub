/**
 * Per-account credential health. Health is derived from a secret-free sidecar
 * (`health.json`) next to each profile, written whenever sidekick stores a
 * credential, so reading health never spawns `security` or the provider CLI.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  getClaudeProfileDir,
  getClaudeProfileHome,
  readLiveClaudeIdentity,
} from './claudeProfiles';
import {
  parseClaudeCredentialBlob,
  resolveClaudeRefreshExpiry,
  type ClaudeOauthCredentials,
} from './claudeCredentials';
import { readActiveCredentials } from './credentialIO';
import {
  identitiesMatch,
  readAccessTokenExpiry,
  readAuthIdentityFromRaw,
  readLastRefresh,
  STALE_AUTH_THRESHOLD_MS,
} from './codexAuth';
import {
  getCodexProfileDir,
  getCodexProfileHome,
  getSystemCodexHome,
  readFileOrNull,
} from './codexPaths';
import {
  getAccountsDir,
  getActiveSavedAccount,
  listSavedAccountProfiles,
  type AccountProviderId,
  type SavedAccountProfile,
} from './accountRegistry';
import { atomicWriteJsonSync } from './writers/atomic';

export type AccountHealthState = 'fresh' | 'expiring' | 'expired' | 'unknown' | 'missing';

export type AccountHealthSource = 'live-sync' | 'login' | 'switch' | 'keepalive' | 'migration';

export interface AccountHealthSidecar {
  version: 1;
  capturedAt: number;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  /** True when `refreshExpiresAt` was estimated rather than recorded by the CLI. */
  refreshExpiryEstimated?: boolean;
  lastRefreshAt?: number;
  hasRefreshToken?: boolean;
  authMode?: 'chatgpt' | 'api-key' | 'oauth';
  source: AccountHealthSource;
}

export interface AccountHealth {
  providerId: AccountProviderId;
  accountId: string;
  state: AccountHealthState;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  refreshExpiryEstimated?: boolean;
  lastRefreshAt?: number;
  checkedAt: number;
  /** True when this profile is the account the live home is logged in to. */
  isLive: boolean;
  reason?: string;
}

export interface AccountView {
  id: string;
  providerId: AccountProviderId;
  label?: string;
  email?: string;
  planType?: string;
  isActive: boolean;
  health: AccountHealth;
  /** `learned` = registered automatically from a login sidekick observed. */
  source: 'registered' | 'learned';
  addedAt: string;
}

export interface AccountHealthOptions {
  /**
   * `cache` (default for {@link getAccountHealth}) reads only the sidecar;
   * `store` re-reads the stored credential (a bounded Keychain call on macOS)
   * and rewrites the sidecar; `auto` (default for {@link listAccountsWithHealth})
   * probes the store only for profiles that have no sidecar yet, so the cost
   * is paid once per profile and never on a hot path that opts into `cache`.
   */
  probe?: 'cache' | 'store' | 'auto';
  now?: number;
}

/** Refresh tokens that expire within this window count as `expiring`. */
const REFRESH_EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000;

export function getHealthSidecarPath(provider: AccountProviderId, accountId: string): string {
  const dir = provider === 'codex' ? getCodexProfileDir(accountId) : getClaudeProfileDir(accountId);
  return path.join(dir, 'health.json');
}

export function readHealthSidecar(
  provider: AccountProviderId,
  accountId: string,
): AccountHealthSidecar | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getHealthSidecarPath(provider, accountId), 'utf8'),
    ) as AccountHealthSidecar;
    return parsed?.version === 1 && typeof parsed.capturedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSidecar(
  provider: AccountProviderId,
  accountId: string,
  sidecar: AccountHealthSidecar,
): void {
  try {
    atomicWriteJsonSync(getHealthSidecarPath(provider, accountId), sidecar);
  } catch {
    // Health is advisory; a failed sidecar write must not fail the credential write.
  }
}

/** Build the sidecar for a Claude credential blob. */
export function claudeHealthSidecarFromBlob(
  blob: unknown,
  source: AccountHealthSource,
  now: number = Date.now(),
): AccountHealthSidecar | null {
  const credentials = parseClaudeCredentialBlob(blob);
  if (!credentials) return null;
  const refresh = resolveClaudeRefreshExpiry(credentials);
  return {
    version: 1,
    capturedAt: now,
    accessExpiresAt: credentials.expiresAt,
    refreshExpiresAt: refresh?.refreshExpiresAt,
    refreshExpiryEstimated: refresh?.estimated,
    hasRefreshToken: Boolean(credentials.refreshToken),
    authMode: 'oauth',
    source,
  };
}

/** Record the health of a Claude profile from the credential just stored. */
export function writeClaudeHealthSidecar(
  accountId: string,
  blob: unknown,
  source: AccountHealthSource,
  now: number = Date.now(),
): AccountHealthSidecar | null {
  const sidecar = claudeHealthSidecarFromBlob(blob, source, now);
  if (sidecar) writeSidecar('claude-code', accountId, sidecar);
  return sidecar;
}

/** Build the sidecar for a raw Codex `auth.json`. */
export function codexHealthSidecarFromAuth(
  authRaw: string | null,
  source: AccountHealthSource,
  now: number = Date.now(),
  fallbackPath?: string,
): AccountHealthSidecar | null {
  const identity = readAuthIdentityFromRaw(authRaw);
  if (!identity) return null;
  const lastRefreshAt = readLastRefresh(authRaw, fallbackPath) ?? undefined;
  return {
    version: 1,
    capturedAt: now,
    accessExpiresAt: readAccessTokenExpiry(authRaw) ?? undefined,
    lastRefreshAt,
    hasRefreshToken: identity.authMode === 'chatgpt',
    authMode: identity.authMode,
    source,
  };
}

/** Record the health of a Codex profile from the auth file just stored. */
export function writeCodexHealthSidecar(
  accountId: string,
  authRaw: string | null,
  source: AccountHealthSource,
  now: number = Date.now(),
): AccountHealthSidecar | null {
  const sidecar = codexHealthSidecarFromAuth(authRaw, source, now);
  if (sidecar) writeSidecar('codex', accountId, sidecar);
  return sidecar;
}

function stateFromClaudeSidecar(
  sidecar: AccountHealthSidecar,
  now: number,
): Pick<AccountHealth, 'state' | 'reason'> {
  const accessKnown = sidecar.accessExpiresAt !== undefined;
  const accessExpired = accessKnown && sidecar.accessExpiresAt! <= now;
  if (sidecar.refreshExpiresAt !== undefined) {
    if (sidecar.refreshExpiresAt <= now) {
      return {
        state: 'expired',
        reason: sidecar.refreshExpiryEstimated
          ? 'Refresh token has most likely expired (estimated from the snapshot age).'
          : 'Refresh token expired; sign in again.',
      };
    }
    if (sidecar.refreshExpiresAt - now <= REFRESH_EXPIRY_WARNING_MS) {
      return { state: 'expiring', reason: 'Refresh token expires within 3 days.' };
    }
  }
  if (sidecar.hasRefreshToken === false && accessExpired) {
    return { state: 'expired', reason: 'Access token expired and no refresh token is stored.' };
  }
  if (accessExpired) {
    return { state: 'expiring', reason: 'Access token expired; the CLI refreshes it on next use.' };
  }
  if (!accessKnown && sidecar.refreshExpiresAt === undefined) {
    return { state: 'unknown', reason: 'The stored credential carries no expiry.' };
  }
  return { state: 'fresh' };
}

function stateFromCodexSidecar(
  sidecar: AccountHealthSidecar,
  now: number,
): Pick<AccountHealth, 'state' | 'reason'> {
  if (sidecar.authMode === 'api-key') {
    return { state: 'unknown', reason: 'API-key login; expiry is not observable locally.' };
  }
  if (sidecar.accessExpiresAt !== undefined && sidecar.accessExpiresAt > now) {
    return { state: 'fresh' };
  }
  if (
    sidecar.lastRefreshAt !== undefined &&
    now - sidecar.lastRefreshAt > STALE_AUTH_THRESHOLD_MS
  ) {
    const days = Math.floor((now - sidecar.lastRefreshAt) / (24 * 60 * 60 * 1000));
    return {
      state: 'expiring',
      reason: `Not refreshed in ${days} days; codex may ask you to log in again.`,
    };
  }
  if (sidecar.accessExpiresAt !== undefined) {
    return { state: 'expiring', reason: 'Access token expired; codex refreshes it on next use.' };
  }
  return { state: 'unknown', reason: 'The stored credential carries no expiry.' };
}

function isLiveClaudeAccount(accountId: string): boolean {
  return readLiveClaudeIdentity()?.uuid === accountId;
}

function isLiveCodexAccount(profile: SavedAccountProfile): boolean {
  const live = readAuthIdentityFromRaw(
    readFileOrNull(path.join(getSystemCodexHome(), 'auth.json')),
  );
  if (!live) return false;
  return identitiesMatch(live, {
    email: profile.email ?? profile.metadata?.email,
    workspaceId: profile.metadata?.workspaceId,
  });
}

function probeClaudeStore(accountId: string, now: number): AccountHealthSidecar | null {
  const blob = readActiveCredentials(getClaudeProfileHome(accountId));
  return blob ? writeClaudeHealthSidecar(accountId, blob, 'switch', now) : null;
}

function probeCodexStore(accountId: string, now: number): AccountHealthSidecar | null {
  const authPath = path.join(getCodexProfileHome(accountId), 'auth.json');
  const raw = readFileOrNull(authPath);
  const sidecar = codexHealthSidecarFromAuth(raw, 'switch', now, authPath);
  if (sidecar) writeSidecar('codex', accountId, sidecar);
  return sidecar;
}

function hasStoredClaudeCredential(accountId: string): boolean {
  const home = getClaudeProfileHome(accountId);
  return (
    fs.existsSync(path.join(home, '.credentials.json')) ||
    fs.existsSync(path.join(getClaudeProfileDir(accountId), 'health.json')) ||
    fs.existsSync(path.join(getAccountsDir(), 'credentials', `${accountId}.credentials.json`)) ||
    (process.platform === 'darwin' && fs.existsSync(path.join(home, '.claude.json')))
  );
}

function hasStoredCodexCredential(accountId: string): boolean {
  const home = getCodexProfileHome(accountId);
  return (
    fs.existsSync(path.join(home, 'auth.json')) ||
    fs.existsSync(path.join(home, '.credentials.json'))
  );
}

/**
 * Health of one saved account. `probe: 'cache'` never spawns anything; a
 * missing sidecar on a profile that has credentials is reported as `unknown`
 * (never `expired`) until a store probe or the next sync rewrites it.
 */
export function getAccountHealth(
  provider: AccountProviderId,
  accountId: string,
  options: AccountHealthOptions = {},
): AccountHealth {
  const now = options.now ?? Date.now();
  const probe = options.probe ?? 'cache';
  const profile = listSavedAccountProfiles(provider).find((p) => p.id === accountId);
  const isLive =
    provider === 'codex'
      ? profile !== undefined && isLiveCodexAccount(profile)
      : isLiveClaudeAccount(accountId);

  let sidecar: AccountHealthSidecar | null = null;
  if (probe === 'store') {
    sidecar =
      provider === 'codex' ? probeCodexStore(accountId, now) : probeClaudeStore(accountId, now);
  }
  sidecar ??= readHealthSidecar(provider, accountId);
  if (!sidecar && provider === 'codex') {
    // Codex sidecars are cheap to derive from the plaintext file.
    sidecar = probeCodexStore(accountId, now);
  }
  if (!sidecar && probe === 'auto' && hasStoredClaudeCredential(accountId)) {
    // First look at a profile that predates the health model: read its store
    // once and record the sidecar so later reads are cache hits.
    sidecar = probeClaudeStore(accountId, now);
  }

  const base = { providerId: provider, accountId, checkedAt: now, isLive };
  if (!sidecar) {
    const stored =
      provider === 'codex'
        ? hasStoredCodexCredential(accountId)
        : hasStoredClaudeCredential(accountId);
    return stored
      ? { ...base, state: 'unknown', reason: 'Credential health has not been recorded yet.' }
      : { ...base, state: 'missing', reason: 'No stored credentials; sign in again.' };
  }

  const verdict =
    provider === 'codex'
      ? stateFromCodexSidecar(sidecar, now)
      : stateFromClaudeSidecar(sidecar, now);
  return {
    ...base,
    ...verdict,
    accessExpiresAt: sidecar.accessExpiresAt,
    refreshExpiresAt: sidecar.refreshExpiresAt,
    refreshExpiryEstimated: sidecar.refreshExpiryEstimated,
    lastRefreshAt: sidecar.lastRefreshAt,
  };
}

/** Saved accounts with their health, in registry order, grouped by provider. */
export function listAccountsWithHealth(
  provider?: AccountProviderId,
  options: AccountHealthOptions = {},
): AccountView[] {
  const resolved: AccountHealthOptions = { probe: 'auto', ...options };
  const providers: AccountProviderId[] = provider ? [provider] : ['claude-code', 'codex'];
  const views: AccountView[] = [];
  for (const providerId of providers) {
    const active = getActiveSavedAccount(providerId);
    for (const profile of listSavedAccountProfiles(providerId)) {
      views.push({
        id: profile.id,
        providerId,
        label: profile.label,
        email: profile.email ?? profile.metadata?.email,
        planType: profile.metadata?.planType,
        isActive: active?.id === profile.id,
        health: getAccountHealth(providerId, profile.id, resolved),
        source: profile.metadata?.origin === 'live-sync' ? 'learned' : 'registered',
        addedAt: profile.addedAt,
      });
    }
  }
  return views;
}

/** Sidecar helper shared by the credential chokepoints: extracts the Claude credential shape. */
export function describeClaudeCredential(blob: unknown): ClaudeOauthCredentials | null {
  return parseClaudeCredentialBlob(blob);
}
