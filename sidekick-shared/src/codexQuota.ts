import * as fs from 'fs';
import * as path from 'path';
import {
  getActiveCodexAccount,
  getCodexMonitoringHomes,
  resolveSidekickCodexHome,
} from './codexProfiles';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import type { CodexResetCreditsSnapshot, QuotaState } from './quota';
import { FIVE_HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS, withQuotaProjections } from './quota';
import { CodexProvider } from './providers/codex';
import { walkRolloutFiles } from './providers/rolloutWalker';
import type { ProviderQuotaState } from './providerQuota';
import type { SavedAccountProfile } from './accountRegistry';
import type { CodexRateLimits } from './types/codex';
import { isAggregateCodexLimit } from './types/codex';

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SESSION_FILES = 50;
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CHATGPT_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

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
  accountId?: string;
  fetchImpl?: typeof fetch;
  usageUrl?: string;
  resetCreditsUrl?: string;
  capturedAt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface CodexAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface CodexAuthCredentials {
  accessToken: string;
  accountId?: string;
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

interface CodexResetCreditsApiPayload {
  available_count?: number | null;
  total_earned_count?: number | null;
  credits?: CodexResetCreditsApiCredit[] | null;
}

interface CodexResetCreditsApiCredit {
  title?: string | null;
  status?: string | null;
  reset_type?: string | null;
  expires_at?: string | null;
  granted_at?: string | null;
}

interface RolloutQuotaHit {
  quota: QuotaState;
  filePath: string;
  mtimeMs: number;
}

function timestampMs(value: string | undefined, fallbackMs = 0): number {
  if (!value) return fallbackMs;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fallbackMs;
}

// Codex can report slightly different percentages for the same reset window
// across recent sessions. Prefer the aggregate plan family ("codex") over
// model/feature-specific families (which can read 0% while the plan is busy),
// then newer reset windows, then the highest observed same-window utilization so
// local fallbacks do not under-report quota usage.
function isPreferredQuotaHit(candidate: RolloutQuotaHit, current: RolloutQuotaHit | null): boolean {
  if (!current) return true;

  // Family rank first: an aggregate hit always outranks a model-specific one, so a
  // freshly-used per-model family (e.g. codex_bengalfox at 0%) can never mask the plan quota.
  const candidateAggregate = isAggregateCodexLimit(candidate.quota.limitId);
  const currentAggregate = isAggregateCodexLimit(current.quota.limitId);
  if (candidateAggregate !== currentAggregate) return candidateAggregate;

  const candidatePrimaryReset = timestampMs(candidate.quota.fiveHour.resetsAt);
  const currentPrimaryReset = timestampMs(current.quota.fiveHour.resetsAt);
  if (candidatePrimaryReset !== currentPrimaryReset)
    return candidatePrimaryReset > currentPrimaryReset;

  const candidateSecondaryReset = timestampMs(candidate.quota.sevenDay.resetsAt);
  const currentSecondaryReset = timestampMs(current.quota.sevenDay.resetsAt);
  if (candidateSecondaryReset !== currentSecondaryReset)
    return candidateSecondaryReset > currentSecondaryReset;

  const candidateUtilization =
    candidate.quota.fiveHour.utilization + candidate.quota.sevenDay.utilization;
  const currentUtilization =
    current.quota.fiveHour.utilization + current.quota.sevenDay.utilization;
  if (candidateUtilization !== currentUtilization) return candidateUtilization > currentUtilization;

  const candidateMs = timestampMs(candidate.quota.capturedAt, candidate.mtimeMs);
  const currentMs = timestampMs(current.quota.capturedAt, current.mtimeMs);
  if (candidateMs !== currentMs) return candidateMs > currentMs;

  return candidate.mtimeMs > current.mtimeMs;
}

function normalizePercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function windowMinutesToMs(value: number | null | undefined, fallbackMs: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value * 60_000
    : fallbackMs;
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

/** Stamp a Codex quota sample with its runtime provider, projections, and account identity. */
export function enrichCodexQuota(
  state: QuotaState,
  account: SavedAccountProfile | null,
): ProviderQuotaState<'codex'> {
  const withProjections = withQuotaProjections(state);
  return {
    ...withProjections,
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
  return enrichCodexQuota(
    {
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error,
      providerId: 'codex',
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
      ...meta,
    },
    account,
  );
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

function normalizeCredits(
  credits: CodexUsageApiCredits | null | undefined,
): CodexQuotaCreditsSnapshot | undefined {
  if (!credits) return undefined;
  return {
    hasCredits: credits.has_credits ?? credits.hasCredits,
    unlimited: credits.unlimited,
    balance: credits.balance ?? undefined,
  };
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeResetCreditsPayload(
  payload: CodexResetCreditsApiPayload,
  capturedAt: string,
): CodexResetCreditsSnapshot {
  const credits = Array.isArray(payload.credits)
    ? payload.credits.flatMap((credit) => {
        const status = firstString(credit.status);
        const expiresAt = firstString(credit.expires_at);
        if (!status || !expiresAt) return [];
        return [
          {
            title: firstString(credit.title),
            status,
            resetType: firstString(credit.reset_type),
            expiresAt,
            grantedAt: firstString(credit.granted_at),
          },
        ];
      })
    : [];

  return {
    availableCount: normalizeCount(payload.available_count),
    totalEarnedCount:
      typeof payload.total_earned_count === 'number' && Number.isFinite(payload.total_earned_count)
        ? payload.total_earned_count
        : undefined,
    credits,
    source: 'api',
    capturedAt,
  };
}

function normalizeRateLimitReachedType(
  value: CodexUsageApiPayload['rate_limit_reached_type'],
): string | undefined {
  if (typeof value === 'string') return value;
  return firstString(value?.kind);
}

function normalizeApiWindow(
  window: CodexUsageApiWindow | null | undefined,
): CodexRateLimits['primary'] {
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

  return withQuotaProjections(
    {
      fiveHour: primary
        ? {
            utilization: normalizePercent(primary.used_percent),
            resetsAt: timestampToIso(primary.resets_at),
          }
        : { utilization: 0, resetsAt: '' },
      sevenDay: secondary
        ? {
            utilization: normalizePercent(secondary.used_percent),
            resetsAt: timestampToIso(secondary.resets_at),
          }
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
    },
    {
      fiveHourWindowMs: windowMinutesToMs(primary?.window_minutes, FIVE_HOUR_WINDOW_MS),
      sevenDayWindowMs: windowMinutesToMs(secondary?.window_minutes, SEVEN_DAY_WINDOW_MS),
      capturedAt,
    },
  );
}

export function readLatestCodexQuotaFromRollouts(
  sessionPaths: string[],
  options: {
    source?: 'session' | 'cache';
    maxTailBytes?: number;
    maxSessionFiles?: number;
  } = {},
): QuotaState | null {
  return readLatestCodexQuotaHitFromRollouts(sessionPaths, options)?.quota ?? null;
}

function readLatestCodexQuotaHitFromRollouts(
  sessionPaths: string[],
  options: {
    source?: 'session' | 'cache';
    maxTailBytes?: number;
    maxSessionFiles?: number;
  } = {},
): RolloutQuotaHit | null {
  const maxSessionFiles = options.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES;
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  let latest: RolloutQuotaHit | null = null;

  for (const sessionPath of sessionPaths.slice(0, maxSessionFiles)) {
    const hit = readLatestQuotaFromRollout(sessionPath, maxTailBytes, options.source ?? 'session');
    if (hit && isPreferredQuotaHit(hit, latest)) {
      latest = hit;
    }
  }
  return latest;
}

/**
 * The newest account-level rollouts, one capped walk across the monitored
 * homes. `limit` bounds the walk itself, so a large history is never fully
 * enumerated or stat'ed just to tail a handful of files.
 */
function findAccountRolloutFiles(codexHome: string | undefined, limit: number): string[] {
  const homes = codexHome ? [codexHome] : getCodexMonitoringHomes();
  return walkRolloutFiles(
    homes.map((home) => path.join(home, 'sessions')),
    { limit },
  ).map((file) => file.path);
}

export function resolveCodexQuotaFromLocalSources(
  options: CodexQuotaResolveOptions = {},
): ProviderQuotaState<'codex'> | null {
  const account =
    options.activeAccount !== undefined ? options.activeAccount : getActiveCodexAccount();
  const readSnapshot = options.readSnapshot ?? readQuotaSnapshot;
  const writeSnapshot = options.writeSnapshot ?? writeQuotaSnapshot;
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  const maxSessionFiles = options.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES;
  let ownProvider = false;
  const provider =
    options.provider ??
    (() => {
      ownProvider = true;
      return new CodexProvider();
    })();

  try {
    const candidates: RolloutQuotaHit[] = [];
    if (options.workspacePath) {
      const workspaceSessions = provider.findAllSessions(options.workspacePath);
      const workspaceHit = readLatestCodexQuotaHitFromRollouts(workspaceSessions, {
        maxTailBytes,
        maxSessionFiles,
      });
      if (workspaceHit) candidates.push(workspaceHit);
    }

    const accountSessions = findAccountRolloutFiles(options.codexHome, maxSessionFiles);
    const accountHit = readLatestCodexQuotaHitFromRollouts(accountSessions, {
      maxTailBytes,
      maxSessionFiles,
    });
    if (accountHit) candidates.push(accountHit);

    const latestHit = candidates.reduce<RolloutQuotaHit | null>(
      (latest, candidate) => (isPreferredQuotaHit(candidate, latest) ? candidate : latest),
      null,
    );
    if (latestHit) {
      if (account) writeSnapshot('codex', account.id, latestHit.quota);
      return enrichCodexQuota(latestHit.quota, account);
    }

    const cached = account ? readSnapshot('codex', account.id) : null;
    if (cached) {
      return enrichCodexQuota(
        {
          ...cached,
          providerId: 'codex',
          source: 'cache',
          stale: true,
          fiveHourLabel: cached.fiveHourLabel ?? 'Primary',
          sevenDayLabel: cached.sevenDayLabel ?? 'Secondary',
        },
        account,
      );
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
  const account =
    options.activeAccount !== undefined ? options.activeAccount : getActiveCodexAccount();
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

export async function fetchCodexQuotaFromApi(
  options: CodexQuotaApiOptions = {},
): Promise<QuotaState> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const auth =
    options.accessToken != null
      ? { accessToken: options.accessToken, accountId: options.accountId }
      : readCodexAuth(options.codexHome ?? resolveSidekickCodexHome());
  const accessToken = auth?.accessToken;

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

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  timeout.unref();
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(options.usageUrl ?? CHATGPT_USAGE_URL, {
      method: 'GET',
      signal: controller.signal,
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
        failureKind:
          response.status === 401 || response.status === 403
            ? 'auth'
            : response.status === 429
              ? 'rate_limit'
              : response.status >= 500 && response.status <= 599
                ? 'server'
                : 'unknown',
        httpStatus: response.status,
        retryAfterMs:
          response.status === 429
            ? parseRetryAfterMs(response.headers.get('retry-after'))
            : undefined,
        providerId: 'codex',
        source: 'api',
        capturedAt,
        fiveHourLabel: 'Primary',
        sevenDayLabel: 'Secondary',
      };
    }

    const payload = (await response.json()) as CodexUsageApiPayload;
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
    const resetCredits = await fetchCodexResetCreditsFromApi({
      ...options,
      accessToken,
      accountId: auth?.accountId,
      capturedAt,
      signal: controller.signal,
    });
    if (resetCredits) {
      quota.resetCredits = resetCredits;
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
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchCodexResetCreditsFromApi(
  options: CodexQuotaApiOptions = {},
): Promise<CodexResetCreditsSnapshot | undefined> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const auth =
    options.accessToken != null
      ? { accessToken: options.accessToken, accountId: options.accountId }
      : readCodexAuth(options.codexHome ?? resolveSidekickCodexHome());
  const accessToken = auth?.accessToken;
  if (!accessToken) return undefined;

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  timeout.unref();
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      originator: 'Codex Desktop',
      'OAI-Product-Sku': 'CODEX',
      Accept: 'application/json',
    };
    if (auth?.accountId) {
      headers['ChatGPT-Account-ID'] = auth.accountId;
    }
    const response = await fetchImpl(options.resetCreditsUrl ?? CHATGPT_RESET_CREDITS_URL, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return undefined;

    return normalizeResetCreditsPayload(
      (await response.json()) as CodexResetCreditsApiPayload,
      capturedAt,
    );
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function readCodexAuth(codexHome: string): CodexAuthCredentials | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'),
    ) as CodexAuthJson;
    if (parsed.OPENAI_API_KEY || parsed.auth_mode === 'api_key') return null;
    const accessToken = parsed.tokens?.access_token;
    if (!accessToken) return null;
    return {
      accessToken,
      accountId: parsed.tokens?.account_id,
    };
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

    // Scan from the end for the latest aggregate ("codex") rate-limit sample, which
    // is what the plan quota represents. Keep the latest sample of any family as a
    // fallback so a model-only session still surfaces something.
    const lines = text.split('\n');
    let fallback: RolloutQuotaHit | null = null;
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
        const quota = quotaFromCodexRateLimits(
          parsed.payload.rate_limits,
          source,
          parsed.timestamp ?? new Date(stat.mtime).toISOString(),
        );
        if (!quota) continue;
        const hit = { quota, filePath: sessionPath, mtimeMs: stat.mtime.getTime() };
        if (isAggregateCodexLimit(quota.limitId)) return hit;
        if (!fallback) fallback = hit;
      } catch {
        // Ignore malformed or partial lines.
      }
    }
    if (fallback) return fallback;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}
