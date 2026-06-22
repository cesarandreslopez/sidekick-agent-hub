import fs from 'fs';
import os from 'os';
import path from 'path';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import type { QuotaState } from './quota';
import type { ProviderQuotaState } from './providerQuota';

const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_TIMEOUT_MS = 10_000;

type ZaiSnapshotProvider = 'zai';
type SnapshotReader = (providerId: ZaiSnapshotProvider, accountId: string) => QuotaState | null;
type SnapshotWriter = (providerId: ZaiSnapshotProvider, accountId: string, quota: QuotaState) => void;

export type ZaiPlatform = 'ZAI' | 'ZHIPU';
export type ZaiCredentialSource = 'opencode' | 'env';

export interface ZaiCredentials {
  authToken: string;
  baseUrl: string;
  platform: ZaiPlatform;
  source: ZaiCredentialSource;
}

export interface ReadZaiCredentialsOptions {
  openCodeDataDir?: string;
  env?: Record<string, string | undefined>;
}

export interface ZaiQuotaApiOptions extends ReadZaiCredentialsOptions {
  credentials?: ZaiCredentials | null;
  fetchImpl?: typeof fetch;
  capturedAt?: string;
  timeoutMs?: number;
}

export interface ZaiQuotaResolveOptions extends ZaiQuotaApiOptions {
  accountId?: string;
  readSnapshot?: SnapshotReader;
  writeSnapshot?: SnapshotWriter;
}

interface ZaiQuotaLimitPayload {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: {
    level?: string;
    limits?: ZaiQuotaLimitEntry[];
  };
  limits?: ZaiQuotaLimitEntry[];
}

interface ZaiQuotaLimitEntry {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  nextResetTime?: number | string;
}

function unavailableZaiQuotaState(
  error: string,
  meta: Pick<QuotaState, 'failureKind' | 'httpStatus' | 'retryAfterMs'> = {},
  capturedAt: string = new Date().toISOString(),
): QuotaState {
  return {
    fiveHour: { utilization: 0, resetsAt: '' },
    sevenDay: { utilization: 0, resetsAt: '' },
    available: false,
    error,
    providerId: 'zai',
    source: 'api',
    capturedAt,
    fiveHourLabel: '5-Hour',
    sevenDayLabel: 'Weekly',
    ...meta,
  };
}

function openCodeDataDirCandidates(): string[] {
  const candidates: string[] = [];
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) candidates.push(path.join(xdg, 'opencode'));

  candidates.push(path.join(os.homedir(), '.local', 'share', 'opencode'));
  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'opencode'));
  } else if (process.platform === 'win32') {
    candidates.push(path.join(
      process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'opencode',
    ));
  }

  return Array.from(new Set(candidates));
}

function readOpenCodeAuthToken(openCodeDataDir?: string): string | null {
  const candidates = openCodeDataDir ? [openCodeDataDir] : openCodeDataDirCandidates();
  for (const dataDir of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8')) as Record<string, unknown>;
      const codingPlan = parsed['zai-coding-plan'] as { key?: unknown } | undefined;
      const zai = parsed.zai as { key?: unknown } | undefined;
      if (typeof codingPlan?.key === 'string' && codingPlan.key.trim()) return codingPlan.key.trim();
      if (typeof zai?.key === 'string' && zai.key.trim()) return zai.key.trim();
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function platformFromBaseUrl(baseUrl: string): ZaiPlatform | null {
  if (baseUrl.includes('api.z.ai')) return 'ZAI';
  if (baseUrl.includes('open.bigmodel.cn') || baseUrl.includes('dev.bigmodel.cn')) return 'ZHIPU';
  return null;
}

export function readZaiCredentials(options: ReadZaiCredentialsOptions = {}): ZaiCredentials | null {
  const openCodeToken = readOpenCodeAuthToken(options.openCodeDataDir);
  if (openCodeToken) {
    return {
      authToken: openCodeToken,
      baseUrl: DEFAULT_ZAI_BASE_URL,
      platform: 'ZAI',
      source: 'opencode',
    };
  }

  const env = options.env ?? process.env;
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (!authToken || !baseUrl) return null;

  const platform = platformFromBaseUrl(baseUrl);
  if (!platform) return null;

  return {
    authToken,
    baseUrl,
    platform,
    source: 'env',
  };
}

function quotaLimitUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}${QUOTA_PATH}`;
  } catch {
    return null;
  }
}

function tokenLimitEntries(payload: ZaiQuotaLimitPayload): ZaiQuotaLimitEntry[] {
  const limits = payload.data?.limits ?? payload.limits ?? [];
  return limits.filter((item) => item?.type === 'TOKENS_LIMIT' && typeof item.percentage === 'number');
}

function isFiveHourLimit(item: ZaiQuotaLimitEntry): boolean {
  return item.type === 'TOKENS_LIMIT' && item.unit === 3 && item.number === 5;
}

function isWeeklyLimit(item: ZaiQuotaLimitEntry): boolean {
  return item.type === 'TOKENS_LIMIT' && item.unit === 6 && item.number === 1;
}

function isoFromEpochMs(value: number | string | undefined): string {
  if (value == null) return '';
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString();
}

function displayPlanName(level: string | undefined): string {
  if (!level) return 'z.ai Coding Plan';
  return `z.ai ${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

export function quotaStateFromZaiQuotaLimitPayload(
  payload: unknown,
  capturedAt: string = new Date().toISOString(),
): QuotaState {
  const data = payload as ZaiQuotaLimitPayload;
  const tokenLimits = tokenLimitEntries(data);
  const fiveHourLimit = tokenLimits.find(isFiveHourLimit) ?? tokenLimits[0];
  const weeklyLimit = tokenLimits.find(isWeeklyLimit) ?? tokenLimits.find(item => item !== fiveHourLimit);
  const level = data.data?.level;

  if (!fiveHourLimit || !weeklyLimit) {
    return unavailableZaiQuotaState('z.ai quota API returned no token quota windows.', {
      failureKind: 'unknown',
    }, capturedAt);
  }

  return {
    fiveHour: {
      utilization: fiveHourLimit.percentage ?? 0,
      resetsAt: isoFromEpochMs(fiveHourLimit.nextResetTime),
    },
    sevenDay: {
      utilization: weeklyLimit.percentage ?? 0,
      resetsAt: isoFromEpochMs(weeklyLimit.nextResetTime),
    },
    available: true,
    providerId: 'zai',
    source: 'api',
    capturedAt,
    fiveHourLabel: '5-Hour',
    sevenDayLabel: 'Weekly',
    planType: level,
    limitId: level ? `zai-${level}` : 'zai-coding-plan',
    limitName: displayPlanName(level),
  };
}

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function failureKindForStatus(status: number): NonNullable<QuotaState['failureKind']> {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'unknown';
}

function sanitizeErrorMessage(message: string, authToken?: string): string {
  let result = message;
  if (authToken) {
    result = result.split(authToken).join('<redacted>');
  }
  return result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>');
}

export async function fetchZaiQuotaFromApi(options: ZaiQuotaApiOptions = {}): Promise<QuotaState> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const credentials = options.credentials ?? readZaiCredentials(options);
  if (!credentials) {
    return unavailableZaiQuotaState(
      'No z.ai credentials found. Sign in to OpenCode with z.ai or set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN.',
      { failureKind: 'auth' },
      capturedAt,
    );
  }

  const url = quotaLimitUrl(credentials.baseUrl);
  if (!url) {
    return unavailableZaiQuotaState('Invalid z.ai base URL.', { failureKind: 'unknown' }, capturedAt);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: credentials.authToken,
        'Accept-Language': 'en-US,en',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const failureKind = failureKindForStatus(response.status);
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      const detail = parsed && typeof parsed === 'object' && 'msg' in parsed
        ? String((parsed as { msg?: unknown }).msg ?? '')
        : '';
      const baseMessage = failureKind === 'auth'
        ? `z.ai quota API rejected credentials (HTTP ${response.status}).`
        : `z.ai quota API error (HTTP ${response.status}).`;
      return unavailableZaiQuotaState(
        sanitizeErrorMessage([baseMessage, detail].filter(Boolean).join(' '), credentials.authToken),
        { failureKind, httpStatus: response.status, retryAfterMs },
        capturedAt,
      );
    }

    return quotaStateFromZaiQuotaLimitPayload(parsed, capturedAt);
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    return unavailableZaiQuotaState(
      isAbort ? 'z.ai quota API timed out.' : 'z.ai quota API network error.',
      { failureKind: 'network' },
      capturedAt,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function enrichZaiQuota(state: QuotaState): ProviderQuotaState<'zai'> {
  return {
    ...state,
    runtimeProvider: 'zai',
    providerId: 'zai',
    fiveHourLabel: state.fiveHourLabel ?? '5-Hour',
    sevenDayLabel: state.sevenDayLabel ?? 'Weekly',
  };
}

export async function resolveZaiQuota(options: ZaiQuotaResolveOptions = {}): Promise<ProviderQuotaState<'zai'>> {
  const accountId = options.accountId ?? DEFAULT_ACCOUNT_ID;
  const readSnapshot = options.readSnapshot ?? readQuotaSnapshot;
  const writeSnapshot = options.writeSnapshot ?? writeQuotaSnapshot;
  const apiQuota = await fetchZaiQuotaFromApi(options);

  if (apiQuota.available) {
    writeSnapshot('zai', accountId, apiQuota);
    return enrichZaiQuota(apiQuota);
  }

  const cached = readSnapshot('zai', accountId);
  if (cached) {
    return enrichZaiQuota({
      ...cached,
      providerId: 'zai',
      source: 'cache',
      stale: true,
      fiveHourLabel: cached.fiveHourLabel ?? '5-Hour',
      sevenDayLabel: cached.sevenDayLabel ?? 'Weekly',
    });
  }

  return enrichZaiQuota(apiQuota);
}
