import * as fs from 'fs';
import * as path from 'path';
import { getActiveCodexAccount, resolveSidekickCodexHome } from './codexProfiles';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import type { QuotaState } from './quota';
import { CodexProvider } from './providers/codex';
import type { ProviderQuotaState } from './providerQuota';
import type { SavedAccountProfile } from './accountRegistry';
import type { CodexRateLimits } from './types/codex';

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SESSION_FILES = 50;
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

type SnapshotReader = (providerId: 'codex', accountId: string) => QuotaState | null;
type SnapshotWriter = (providerId: 'codex', accountId: string, quota: QuotaState) => void;

export type CodexQuotaResolveSource = 'local' | 'api' | 'auto';

export interface CodexQuotaCreditsSnapshot {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
}

export interface CodexQuotaResolveOptions {
  workspacePath?: string;
  source?: CodexQuotaResolveSource;
  codexHome?: string;
  provider?: CodexProvider;
  activeAccount?: SavedAccountProfile | null;
  readSnapshot?: SnapshotReader;
  writeSnapshot?: SnapshotWriter;
  maxTailBytes?: number;
  maxSessionFiles?: number;
  fetchImpl?: typeof fetch;
  accessToken?: string;
}

export interface CodexQuotaApiOptions {
  codexHome?: string;
  accessToken?: string;
  fetchImpl?: typeof fetch;
  usageUrl?: string;
  capturedAt?: string;
}

interface CodexAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
  };
}

interface CodexUsageApiPayload {
  rate_limit?: CodexUsageApiRateLimitDetails | null;
  additional_rate_limits?: Array<{
    metered_feature?: string;
    limit_name?: string | null;
    rate_limit?: CodexUsageApiRateLimitDetails | null;
  }> | null;
  credits?: CodexUsageApiCredits | null;
  plan_type?: string | null;
  rate_limit_reached_type?: { kind?: string } | string | null;
  limit_id?: string | null;
  limit_name?: string | null;
  primary?: CodexRateLimits['primary'];
  secondary?: CodexRateLimits['secondary'];
}

interface CodexUsageApiRateLimitDetails {
  primary_window?: CodexUsageApiWindow | null;
  secondary_window?: CodexUsageApiWindow | null;
}

interface CodexUsageApiWindow {
  used_percent?: number;
  window_minutes?: number | null;
  resets_at?: number | null;
  limit_window_seconds?: number | null;
  reset_at?: number | null;
}

interface CodexUsageApiCredits {
  has_credits?: boolean;
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string | null;
}

interface RolloutQuotaHit {
  quota: QuotaState;
  filePath: string;
}

function normalizePercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function timestampToIso(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  return new Date(seconds * 1000).toISOString();
}

function accountEmail(account: SavedAccountProfile | null): string | undefined {
  return account?.email ?? account?.metadata?.email;
}

function enrichCodexQuota(
  state: QuotaState,
  account: SavedAccountProfile | null,
): ProviderQuotaState<'codex'> {
  return {
    ...state,
    runtimeProvider: 'codex',
    providerId: 'codex',
    accountLabel: account?.label,
    accountDetail: accountEmail(account),
  };
}

function unavailableCodexQuota(
  error: string,
  account: SavedAccountProfile | null,
  meta: Pick<QuotaState, 'failureKind' | 'httpStatus' | 'retryAfterMs' | 'source'> = {},
): ProviderQuotaState<'codex'> {
  return enrichCodexQuota({
    fiveHour: { utilization: 0, resetsAt: '' },
    sevenDay: { utilization: 0, resetsAt: '' },
    available: false,
    error,
    providerId: 'codex',
    fiveHourLabel: 'Primary',
    sevenDayLabel: 'Secondary',
    ...meta,
  }, account);
}

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isNaN(retryAt)) return undefined;

  return Math.max(retryAt - Date.now(), 0);
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeCredits(credits: CodexUsageApiCredits | null | undefined): CodexQuotaCreditsSnapshot | undefined {
  if (!credits) return undefined;
  return {
    hasCredits: credits.has_credits ?? credits.hasCredits,
    unlimited: credits.unlimited,
    balance: credits.balance ?? undefined,
  };
}

function normalizeRateLimitReachedType(value: CodexUsageApiPayload['rate_limit_reached_type']): string | undefined {
  if (typeof value === 'string') return value;
  return firstString(value?.kind);
}

function normalizeApiWindow(window: CodexUsageApiWindow | null | undefined): CodexRateLimits['primary'] {
  if (!window) return undefined;
  const windowMinutes =
    typeof window.window_minutes === 'number' || window.window_minutes === null
      ? window.window_minutes
      : typeof window.limit_window_seconds === 'number'
        ? Math.round(window.limit_window_seconds / 60)
        : undefined;
  const resetsAt =
    typeof window.resets_at === 'number' || window.resets_at === null
      ? window.resets_at
      : window.reset_at;
  return {
    used_percent: normalizePercent(window.used_percent),
    window_minutes: windowMinutes,
    resets_at: resetsAt,
  };
}

function rateLimitsFromUsagePayload(payload: CodexUsageApiPayload): CodexRateLimits {
  if (payload.primary || payload.secondary) {
    return {
      limit_id: payload.limit_id ?? 'codex',
      limit_name: payload.limit_name ?? null,
      primary: payload.primary,
      secondary: payload.secondary,
      credits: normalizeCredits(payload.credits),
      plan_type: payload.plan_type ?? undefined,
      rate_limit_reached_type: normalizeRateLimitReachedType(payload.rate_limit_reached_type),
    };
  }

  const preferred = payload.rate_limit;
  return {
    limit_id: 'codex',
    limit_name: null,
    primary: normalizeApiWindow(preferred?.primary_window),
    secondary: normalizeApiWindow(preferred?.secondary_window),
    credits: normalizeCredits(payload.credits),
    plan_type: payload.plan_type ?? undefined,
    rate_limit_reached_type: normalizeRateLimitReachedType(payload.rate_limit_reached_type),
  };
}

export function quotaFromCodexRateLimits(
  rateLimits: CodexRateLimits | null | undefined,
  source: 'api' | 'session' | 'cache' = 'session',
  capturedAt = new Date().toISOString(),
): QuotaState | null {
  const primary = rateLimits?.primary;
  const secondary = rateLimits?.secondary;
  if (!primary && !secondary) return null;

  return {
    fiveHour: primary
      ? { utilization: normalizePercent(primary.used_percent), resetsAt: timestampToIso(primary.resets_at) }
      : { utilization: 0, resetsAt: '' },
    sevenDay: secondary
      ? { utilization: normalizePercent(secondary.used_percent), resetsAt: timestampToIso(secondary.resets_at) }
      : { utilization: 0, resetsAt: '' },
    available: true,
    providerId: 'codex',
    source,
    capturedAt,
    stale: source === 'cache',
    fiveHourLabel: 'Primary',
    sevenDayLabel: 'Secondary',
    limitId: rateLimits?.limit_id,
    limitName: rateLimits?.limit_name ?? undefined,
    credits: rateLimits?.credits,
    planType: rateLimits?.plan_type,
    rateLimitReachedType: rateLimits?.rate_limit_reached_type,
  };
}

export function readLatestCodexQuotaFromRollouts(
  sessionPaths: string[],
  options: {
    source?: 'session' | 'cache';
    maxTailBytes?: number;
    maxSessionFiles?: number;
  } = {},
): QuotaState | null {
  const maxSessionFiles = options.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES;
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;

  for (const sessionPath of sessionPaths.slice(0, maxSessionFiles)) {
    const hit = readLatestQuotaFromRollout(sessionPath, maxTailBytes, options.source ?? 'session');
    if (hit) return hit.quota;
  }
  return null;
}

export function resolveCodexQuotaFromLocalSources(
  options: CodexQuotaResolveOptions = {},
): ProviderQuotaState<'codex'> | null {
  const account = options.activeAccount !== undefined ? options.activeAccount : getActiveCodexAccount();
  const readSnapshot = options.readSnapshot ?? readQuotaSnapshot;
  const writeSnapshot = options.writeSnapshot ?? writeQuotaSnapshot;
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  const maxSessionFiles = options.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES;
  let ownProvider = false;
  const provider = options.provider ?? (() => {
    ownProvider = true;
    return new CodexProvider();
  })();

  try {
    const workspaceSessions = options.workspacePath ? provider.findAllSessions(options.workspacePath) : [];
    const workspaceQuota = readLatestCodexQuotaFromRollouts(workspaceSessions, { maxTailBytes, maxSessionFiles });
    if (workspaceQuota) {
      if (account) writeSnapshot('codex', account.id, workspaceQuota);
      return enrichCodexQuota(workspaceQuota, account);
    }

    const codexHome = options.codexHome ?? resolveSidekickCodexHome();
    const accountSessions = findRolloutFiles(path.join(codexHome, 'sessions'));
    const accountQuota = readLatestCodexQuotaFromRollouts(accountSessions, { maxTailBytes, maxSessionFiles });
    if (accountQuota) {
      if (account) writeSnapshot('codex', account.id, accountQuota);
      return enrichCodexQuota(accountQuota, account);
    }

    const cached = account ? readSnapshot('codex', account.id) : null;
    if (cached) {
      return enrichCodexQuota({
        ...cached,
        providerId: 'codex',
        source: 'cache',
        stale: true,
        fiveHourLabel: cached.fiveHourLabel ?? 'Primary',
        sevenDayLabel: cached.sevenDayLabel ?? 'Secondary',
      }, account);
    }
  } finally {
    if (ownProvider) provider.dispose();
  }

  return null;
}

export async function resolveCodexQuota(
  options: CodexQuotaResolveOptions = {},
): Promise<ProviderQuotaState<'codex'>> {
  const source = options.source ?? 'local';
  const account = options.activeAccount !== undefined ? options.activeAccount : getActiveCodexAccount();
  const writeSnapshot = options.writeSnapshot ?? writeQuotaSnapshot;

  if (source === 'api') {
    const apiQuota = await fetchCodexQuotaFromApi(options);
    if (apiQuota.available) {
      if (account) writeSnapshot('codex', account.id, apiQuota);
      return enrichCodexQuota(apiQuota, account);
    }

    const fallback = resolveCodexQuotaFromLocalSources(options);
    return fallback ?? enrichCodexQuota(apiQuota, account);
  }

  const local = resolveCodexQuotaFromLocalSources(options);
  if (local) return local;

  if (source === 'auto') {
    const apiQuota = await fetchCodexQuotaFromApi(options);
    if (apiQuota.available && account) {
      writeSnapshot('codex', account.id, apiQuota);
    }
    return enrichCodexQuota(apiQuota, account);
  }

  return unavailableCodexQuota(
    account
      ? `No Codex rate-limit data is available for "${account.label ?? account.id}".`
      : 'No Codex rate-limit data is available.',
    account,
    { source: 'session' },
  );
}

export async function fetchCodexQuotaFromApi(options: CodexQuotaApiOptions = {}): Promise<QuotaState> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const accessToken = options.accessToken ?? readCodexAccessToken(options.codexHome ?? resolveSidekickCodexHome());

  if (!accessToken) {
    return {
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'Codex API refresh requires a ChatGPT login.',
      failureKind: 'auth',
      providerId: 'codex',
      source: 'api',
      capturedAt,
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
    };
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(options.usageUrl ?? CHATGPT_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return {
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
        error: `Codex usage API error: ${response.status}`,
        failureKind: response.status === 401 || response.status === 403
          ? 'auth'
          : response.status === 429
            ? 'rate_limit'
            : response.status >= 500 && response.status <= 599
              ? 'server'
              : 'unknown',
        httpStatus: response.status,
        retryAfterMs: response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined,
        providerId: 'codex',
        source: 'api',
        capturedAt,
        fiveHourLabel: 'Primary',
        sevenDayLabel: 'Secondary',
      };
    }

    const payload = await response.json() as CodexUsageApiPayload;
    const quota = quotaFromCodexRateLimits(rateLimitsFromUsagePayload(payload), 'api', capturedAt);
    if (!quota) {
      return {
        fiveHour: { utilization: 0, resetsAt: '' },
        sevenDay: { utilization: 0, resetsAt: '' },
        available: false,
        error: 'Codex usage API returned no rate-limit windows.',
        failureKind: 'unknown',
        providerId: 'codex',
        source: 'api',
        capturedAt,
        fiveHourLabel: 'Primary',
        sevenDayLabel: 'Secondary',
      };
    }
    return quota;
  } catch {
    return {
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'Codex usage API network error',
      failureKind: 'network',
      providerId: 'codex',
      source: 'api',
      capturedAt,
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
    };
  }
}

function readCodexAccessToken(codexHome: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')) as CodexAuthJson;
    if (parsed.OPENAI_API_KEY || parsed.auth_mode === 'api_key') return null;
    return parsed.tokens?.access_token || null;
  } catch {
    return null;
  }
}

function readLatestQuotaFromRollout(
  sessionPath: string,
  maxTailBytes: number,
  source: 'session' | 'cache',
): RolloutQuotaHit | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(sessionPath);
    if (!stat.isFile() || stat.size <= 0) return null;

    const start = Math.max(0, stat.size - maxTailBytes);
    const bytesToRead = stat.size - start;
    const buffer = Buffer.alloc(bytesToRead);
    fd = fs.openSync(sessionPath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
    fs.closeSync(fd);
    fd = null;

    let text = buffer.toString('utf8', 0, bytesRead);
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('rate_limits')) continue;

      try {
        const parsed = JSON.parse(line) as {
          timestamp?: string;
          type?: string;
          payload?: { type?: string; rate_limits?: CodexRateLimits | null };
        };
        if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'token_count') continue;
        const quota = quotaFromCodexRateLimits(parsed.payload.rate_limits, source, parsed.timestamp ?? new Date(stat.mtime).toISOString());
        if (quota) return { quota, filePath: sessionPath };
      } catch {
        // Ignore malformed or partial lines.
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  return null;
}

function findRolloutFiles(sessionsDir: string): string[] {
  const results: Array<{ path: string; mtime: number }> = [];

  function visit(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 0) {
          results.push({ path: fullPath, mtime: stat.mtime.getTime() });
        }
      } catch {
        // Skip inaccessible files.
      }
    }
  }

  visit(sessionsDir);
  results.sort((a, b) => b.mtime - a.mtime);
  return results.map(item => item.path);
}
