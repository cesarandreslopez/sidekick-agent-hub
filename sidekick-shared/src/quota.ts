import type { QuotaProviderId } from './providerIds';

export { QUOTA_PROVIDER_IDS } from './providerIds';
export type { QuotaProviderId } from './providerIds';

/**
 * Stateless quota fetcher for Claude subscription usage (Pro, Max, Ultra).
 *
 * Calls the Anthropic OAuth usage endpoint and returns utilization data.
 * Polling / eventing is the caller's responsibility.
 */

export interface QuotaWindow {
  /** Utilization percentage (0–100) */
  utilization: number;
  /** ISO timestamp when the window resets */
  resetsAt: string;
  /**
   * True when the provider reported that this window does not exist for the
   * account — Claude Ultra has no five-hour session limit (`five_hour: null`),
   * and a Codex plan can report a primary window without a secondary one.
   * `utilization`/`resetsAt` are then `0`/`''` placeholders, so readers that
   * predate the flag keep their old behaviour. Absent or false: the window
   * applies (it may still be idle, with no reset time yet).
   */
  absent?: boolean;
  /** Window length in milliseconds when the provider reports it (e.g. Codex `window_minutes`). */
  windowMs?: number;
}

/**
 * One usage meter as reported by the Claude usage endpoint's `limits[]` array.
 * The server decides which meters exist and in what order; classify on
 * `kind`, never on `label`.
 */
export interface QuotaLimitRow {
  /** Server meter kind, e.g. `session`, `weekly_all`, `weekly_scoped`. */
  kind: string;
  /** Server row group, e.g. `session` or `weekly`. */
  group: string;
  /** Display label derived from kind, group, and scope, e.g. `7-Day (Fable)`. */
  label: string;
  /** Share of the window used, 0–100. */
  utilization: number;
  /** ISO timestamp when the window resets; empty when unknown. */
  resetsAt: string;
  /** Window length in milliseconds, derived from the group when known. */
  windowMs?: number;
  /** Projected utilization at reset (percentage, capped at 200). */
  projected?: number;
  /** Model the meter is scoped to (server display name), e.g. `Fable`. */
  scopeModel?: string;
  /** Surface the meter is scoped to (server display name). */
  scopeSurface?: string;
  /** Server severity for colouring: `normal`, `warning`, `critical`. */
  severity?: string;
  /** The server's headline pick — the row a single-value indicator shows. */
  isActive?: boolean;
  /** For scoped weekly meters: how much of the all-models weekly limit this meter may use. */
  allowancePercentOfWeekly?: number;
  /** For scoped weekly meters: how much of the all-models weekly limit it has used. */
  usedPercentOfWeekly?: number;
}

/**
 * Claude usage credits (extra usage): the prepaid balance that keeps requests
 * going past the plan limits, and the monthly spend limit on how much of it
 * may be used. The two are independent — a $100 balance under a $40 spend
 * limit can cover only $40 a month.
 */
export interface QuotaExtraUsage {
  /** Whether extra usage can currently cover requests. */
  enabled: boolean;
  /**
   * Monthly spend limit in minor units of `currency` (cents for USD); null when
   * uncapped. This is a cap on spend, not the credit balance — see `balance`.
   */
  monthlyLimit: number | null;
  /** Spend so far this month, in minor units of `currency`. */
  usedCredits: number | null;
  /** Share of the monthly spend limit used, 0–100. */
  utilization: number | null;
  /** ISO 4217 currency code, e.g. `USD`. */
  currency?: string;
  /** Number of minor-unit decimals (2 for USD). */
  decimalPlaces?: number;
  /** Server reason extra usage is off, e.g. `out_of_credits`. */
  disabledReason?: string;
  /**
   * Prepaid usage credits left, in minor units of `currency`. Read from the
   * organization's prepaid-credits endpoint; absent when it was not fetched
   * (no organization id) or could not be read.
   */
  balance?: number;
  /** ISO timestamp when the earliest-expiring credits in `balance` expire. */
  balanceExpiresAt?: string;
}

/** The prepaid usage-credit balance of a Claude organization. */
export interface ClaudePrepaidCredits {
  /** Credits left, in minor units of `currency` (cents for USD). */
  balance: number;
  /** ISO 4217 currency code, e.g. `USD`. */
  currency?: string;
  /** ISO timestamp when the earliest-expiring credits expire. */
  expiresAt?: string;
}

export interface CodexResetCredit {
  title?: string;
  status: string;
  resetType?: string;
  expiresAt: string;
  grantedAt?: string;
}

export interface CodexResetCreditsSnapshot {
  availableCount: number;
  totalEarnedCount?: number;
  credits: CodexResetCredit[];
  source?: 'api' | 'cache';
  capturedAt?: string;
}

export interface QuotaState {
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  /** Whether quota data was successfully retrieved */
  available: boolean;
  /** Human-readable error if not available */
  error?: string;
  /** Machine-readable failure classification for unavailable states */
  failureKind?: 'auth' | 'network' | 'rate_limit' | 'server' | 'unknown';
  /** HTTP status code for unavailable API responses */
  httpStatus?: number;
  /** Retry delay in milliseconds when rate-limited */
  retryAfterMs?: number;
  /** Projected 5-hour utilization at reset (percentage, capped at 200) */
  projectedFiveHour?: number;
  /** Projected 7-day utilization at reset (percentage, capped at 200) */
  projectedSevenDay?: number;
  /** Provider that produced this quota sample */
  providerId?: QuotaProviderId;
  /**
   * Source of the sample. `statusline` is the official rate-limit block Claude
   * Code hands to its status-line command; `session` is inferred from session
   * logs; `api` is a live usage-endpoint fetch; `cache` is a persisted snapshot.
   */
  source?: 'api' | 'session' | 'cache' | 'statusline';
  /**
   * Where a cached sample originally came from. `readQuotaSnapshot()` forces
   * `source` to `cache`; this keeps the origin (`statusline`, `session`, `api`)
   * so a reader can rank an official status-line sample above a session guess.
   */
  capturedSource?: 'api' | 'session' | 'statusline';
  /** ISO timestamp when the sample was captured */
  capturedAt?: string;
  /** Whether the sample is stale cached data */
  stale?: boolean;
  /** Milliseconds between `capturedAt` and the read, when read from a snapshot. */
  ageMs?: number;
  /** Freshness tier derived from `ageMs`; see `classifyQuotaFreshness`. */
  freshness?: QuotaFreshness;
  /** Provider-specific display label for the first window */
  fiveHourLabel?: string;
  /** Provider-specific display label for the second window */
  sevenDayLabel?: string;
  /** Provider-specific rate-limit identifier */
  limitId?: string;
  /** Provider-specific rate-limit display name */
  limitName?: string;
  /** Provider-specific credits snapshot */
  credits?: unknown;
  /** Codex reset credits snapshot from the ChatGPT reset-credit endpoint */
  resetCredits?: CodexResetCreditsSnapshot;
  /** Provider-specific plan type */
  planType?: string;
  /** Display name of the subscription plan, e.g. `Pro`, `Max`, `Ultra`. */
  planLabel?: string;
  /** Provider-specific rate-limit reached reason */
  rateLimitReachedType?: string;
  /**
   * Every usage meter the provider reported, in server order (Claude's
   * `limits[]`). The `session` and `weekly_all` rows duplicate `fiveHour` and
   * `sevenDay`; use `extraQuotaRows()` for the rest (e.g. a Fable weekly cap).
   */
  limits?: QuotaLimitRow[];
  /** Claude extra-usage (usage credits) spend, when the plan reports it. */
  extraUsage?: QuotaExtraUsage;
}

/** Plan facts read from the Claude OAuth credentials. */
export interface ClaudePlanInfo {
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ORGANIZATIONS_URL = 'https://api.anthropic.com/api/oauth/organizations';
const BETA_HEADER = 'oauth-2025-04-20';
const ORGANIZATION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 10_000;
export const FIVE_HOUR_WINDOW_MS = 5 * 3_600_000;
export const SEVEN_DAY_WINDOW_MS = 7 * 86_400_000;

/** How much to trust a cached quota sample, by age. */
export type QuotaFreshness = 'fresh' | 'aging' | 'stale';

/** A snapshot younger than this is as good as live. */
export const QUOTA_FRESH_MAX_AGE_MS = 5 * 60_000;
/** A snapshot older than this should be labelled as stale wherever it is shown. */
export const QUOTA_AGING_MAX_AGE_MS = 60 * 60_000;

/** Classify a cached sample's age. Non-finite or negative ages count as stale. */
export function classifyQuotaFreshness(ageMs: number | undefined): QuotaFreshness {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return 'stale';
  if (ageMs < QUOTA_FRESH_MAX_AGE_MS) return 'fresh';
  if (ageMs < QUOTA_AGING_MAX_AGE_MS) return 'aging';
  return 'stale';
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Whether the provider reports this window for the account at all. */
export function quotaWindowApplies(window: QuotaWindow | null | undefined): boolean {
  return Boolean(window) && window?.absent !== true;
}

/** Whether the window applies and carries a reading worth showing (a reset time or any usage). */
export function quotaWindowHasData(window: QuotaWindow | null | undefined): boolean {
  if (!window || window.absent === true) return false;
  return Boolean(window.resetsAt) || window.utilization > 0;
}

function usableWindowMs(windowMs: number | undefined): number | undefined {
  return typeof windowMs === 'number' && Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : undefined;
}

/**
 * True when every window of a sample that has a known reset time has already
 * reset by `nowMs`. Such a sample says nothing about current usage — showing
 * it as live would print old percentages with "resets now". Samples without
 * any reset time are never considered expired.
 */
export function quotaSampleExpired(quota: QuotaState, nowMs: number = Date.now()): boolean {
  const resets = [quota.fiveHour, quota.sevenDay]
    .filter((window) => !window.absent && window.resetsAt)
    .map((window) => Date.parse(window.resetsAt))
    .filter((ms) => Number.isFinite(ms));
  return resets.length > 0 && resets.every((ms) => ms <= nowMs);
}

/**
 * Human label for a window length: `5-Hour`, `Daily`, `Weekly`, `30-Day`, …
 * Returns `fallback` when the length is unknown or not a whole number of hours.
 */
export function quotaWindowLabel(windowMs: number | undefined, fallback: string): string {
  const ms = usableWindowMs(windowMs);
  if (ms === undefined) return fallback;
  if (ms === DAY_MS) return 'Daily';
  if (ms === 7 * DAY_MS) return 'Weekly';
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}-Day`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}-Hour`;
  return fallback;
}

/** Compact label for a window length: `5h`, `1d`, `7d`. Returns `fallback` when unknown. */
export function quotaWindowShortLabel(windowMs: number | undefined, fallback: string): string {
  const ms = usableWindowMs(windowMs);
  if (ms === undefined) return fallback;
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return fallback;
}

/**
 * The reported meters that `fiveHour` and `sevenDay` do not already show —
 * per-model or per-surface weekly caps and any future meter kind.
 */
export function extraQuotaRows(quota: Pick<QuotaState, 'limits'>): QuotaLimitRow[] {
  return (quota.limits ?? []).filter((row) => row.kind !== 'session' && row.kind !== 'weekly_all');
}

/**
 * Display name for a Claude subscription. The 20× tier was renamed Ultra and
 * the 5× tier Max on 2026-10-30; credentials keep the old tier ids.
 */
export function claudePlanLabel(plan: ClaudePlanInfo | null | undefined): string | undefined {
  const tier = plan?.rateLimitTier?.trim().toLowerCase() ?? '';
  if (tier.includes('ultra') || tier.includes('max_20x')) return 'Ultra';
  if (tier.includes('max_5x')) return 'Max';
  const subscription = plan?.subscriptionType?.trim().toLowerCase();
  if (!subscription) return undefined;
  return subscription.charAt(0).toUpperCase() + subscription.slice(1);
}

function formatMinorUnits(amount: number, currency: string | undefined, decimals: number): string {
  const value = amount / 10 ** decimals;
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value);
    } catch {
      return `${value.toFixed(decimals)} ${currency}`;
    }
  }
  return value.toFixed(decimals);
}

function extraUsageMoney(extra: QuotaExtraUsage, amount: number): string {
  const decimals =
    typeof extra.decimalPlaces === 'number' &&
    Number.isInteger(extra.decimalPlaces) &&
    extra.decimalPlaces >= 0 &&
    extra.decimalPlaces <= 6
      ? extra.decimalPlaces
      : 2;
  return formatMinorUnits(amount, extra.currency, decimals);
}

function extraUsageOffNote(extra: QuotaExtraUsage): string | undefined {
  if (extra.enabled) return undefined;
  const reason = extra.disabledReason ? ` (${extra.disabledReason.replace(/_/g, ' ')})` : '';
  return `off${reason}`;
}

function hasBalance(extra: QuotaExtraUsage): extra is QuotaExtraUsage & { balance: number } {
  return typeof extra.balance === 'number' && Number.isFinite(extra.balance);
}

function balanceExpiryDate(extra: QuotaExtraUsage): string | undefined {
  if (!extra.balanceExpiresAt) return undefined;
  const ms = Date.parse(extra.balanceExpiresAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

/**
 * The usage-credit balance, e.g. `$100.00 available`,
 * `$25.00 available · expires 2026-12-01`, or `$0.00 available · off (out of credits)`.
 * When the balance is unknown it never substitutes the spend limit: it reports
 * the month's spend if no spend limit is set (`$12.40 spent this month`), and
 * otherwise only whether credits are on (`on`, `off (out of credits)`), leaving
 * the amounts to {@link formatExtraUsageSpendLimit}.
 */
export function formatUsageCreditBalance(extra: QuotaExtraUsage): string {
  const parts: string[] = [];
  if (hasBalance(extra)) {
    parts.push(`${extraUsageMoney(extra, extra.balance)} available`);
    const expires = balanceExpiryDate(extra);
    if (expires) parts.push(`expires ${expires}`);
  } else if (extra.monthlyLimit === null) {
    parts.push(`${extraUsageMoney(extra, extra.usedCredits ?? 0)} spent this month`);
  }
  const off = extraUsageOffNote(extra);
  if (off) parts.push(off);
  return parts.length > 0 ? parts.join(' · ') : 'on';
}

/**
 * The monthly spend limit on usage credits, e.g. `$0.00 of $40.00 used this month`;
 * undefined when no limit is set. This is a cap on spend, not the balance.
 */
export function formatExtraUsageSpendLimit(extra: QuotaExtraUsage): string | undefined {
  if (extra.monthlyLimit === null) return undefined;
  const used = extraUsageMoney(extra, extra.usedCredits ?? 0);
  return `${used} of ${extraUsageMoney(extra, extra.monthlyLimit)} used this month`;
}

/**
 * One-line usage-credit summary that keeps the balance and the monthly spend
 * limit apart, e.g. `$100.00 available · $0.00 of $40.00 monthly spend limit used`
 * or, without a known balance, `$0.00 of $200.00 monthly spend limit used · off (out of credits)`.
 */
export function formatExtraUsage(extra: QuotaExtraUsage): string {
  const parts: string[] = [];
  if (hasBalance(extra)) parts.push(`${extraUsageMoney(extra, extra.balance)} available`);
  const used = extraUsageMoney(extra, extra.usedCredits ?? 0);
  parts.push(
    extra.monthlyLimit !== null
      ? `${used} of ${extraUsageMoney(extra, extra.monthlyLimit)} monthly spend limit used`
      : `${used} spent this month`,
  );
  const off = extraUsageOffNote(extra);
  if (off) parts.push(off);
  return parts.join(' · ');
}

/** Compact age label for status lines and table footers: `just now`, `3m ago`, `2h ago`, `3d ago`. */
export function formatQuotaAge(ageMs: number | undefined): string {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return 'age unknown';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface QuotaProjectionInput {
  utilization: number;
  resetsAt: string;
  windowMs: number;
  capturedAt?: string;
}

/**
 * Projects utilization at end of window based on elapsed time.
 *
 * Formula: `current * (windowDuration / elapsed)`, capped at 200%.
 */
export function projectQuotaWindow(input: QuotaProjectionInput): number | undefined {
  const { utilization, resetsAt, windowMs, capturedAt } = input;
  if (!resetsAt || utilization <= 0 || !Number.isFinite(utilization) || windowMs <= 0)
    return undefined;
  const resetTime = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetTime)) return undefined;

  const capturedTime = capturedAt ? Date.parse(capturedAt) : NaN;
  const now = Number.isFinite(capturedTime) ? capturedTime : Date.now();
  const elapsed = windowMs - (resetTime - now);
  if (elapsed <= 0) return undefined;
  return Math.min(Math.round(utilization * (windowMs / elapsed)), 200);
}

export function withQuotaProjections<T extends QuotaState>(
  state: T,
  options: {
    fiveHourWindowMs?: number;
    sevenDayWindowMs?: number;
    capturedAt?: string;
  } = {},
): T {
  if (!state.available) return state;

  const next = { ...state };
  const capturedAt = options.capturedAt ?? state.capturedAt;

  if (next.projectedFiveHour == null && !next.fiveHour.absent) {
    const projected = projectQuotaWindow({
      utilization: next.fiveHour.utilization,
      resetsAt: next.fiveHour.resetsAt,
      windowMs:
        options.fiveHourWindowMs ?? usableWindowMs(next.fiveHour.windowMs) ?? FIVE_HOUR_WINDOW_MS,
      capturedAt,
    });
    if (projected !== undefined) next.projectedFiveHour = projected;
  }

  if (next.projectedSevenDay == null && !next.sevenDay.absent) {
    const projected = projectQuotaWindow({
      utilization: next.sevenDay.utilization,
      resetsAt: next.sevenDay.resetsAt,
      windowMs:
        options.sevenDayWindowMs ?? usableWindowMs(next.sevenDay.windowMs) ?? SEVEN_DAY_WINDOW_MS,
      capturedAt,
    });
    if (projected !== undefined) next.projectedSevenDay = projected;
  }

  return next;
}

// ── Claude usage endpoint payload ──

/** Hard cap on parsed meter rows, matching Claude Code's own bound. */
const MAX_LIMIT_ROWS = 64;
const MAX_LABEL_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableFiniteNumber(value: unknown): number | null {
  return finiteNumber(value) ?? null;
}

function shortString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_LABEL_LENGTH ? trimmed : undefined;
}

function displayName(value: unknown): string | undefined {
  return isRecord(value) ? shortString(value.display_name) : undefined;
}

function usageWindow(value: unknown): QuotaWindow | null {
  if (!isRecord(value)) return null;
  return {
    utilization: finiteNumber(value.utilization) ?? 0,
    resetsAt: typeof value.resets_at === 'string' ? value.resets_at : '',
  };
}

function absentWindow(): QuotaWindow {
  return { utilization: 0, resetsAt: '', absent: true };
}

function windowMsForMeter(kind: string, group: string): number | undefined {
  if (kind === 'session' || group === 'session') return FIVE_HOUR_WINDOW_MS;
  if (group === 'weekly' || kind.startsWith('weekly')) return SEVEN_DAY_WINDOW_MS;
  if (group === 'daily') return DAY_MS;
  return undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function meterLabel(kind: string, group: string, scope: string | undefined): string {
  let base: string;
  if (kind === 'session' || group === 'session') base = '5-Hour';
  else if (group === 'weekly' || kind.startsWith('weekly')) base = '7-Day';
  else if (group === 'daily') base = 'Daily';
  else base = titleCase(group || kind) || kind;
  return scope ? `${base} (${scope})` : base;
}

interface WeeklyShare {
  allowance?: number;
  used?: number;
}

function weeklySharesByIndex(value: unknown): Map<number, WeeklyShare> {
  const shares = new Map<number, WeeklyShare>();
  if (!Array.isArray(value)) return shares;
  for (const entry of value.slice(0, MAX_LIMIT_ROWS)) {
    if (!isRecord(entry)) continue;
    const index = finiteNumber(entry.limit_index);
    if (index === undefined || !Number.isInteger(index) || index < 0) continue;
    shares.set(index, {
      allowance: finiteNumber(entry.allowance_percent_of_weekly),
      used: finiteNumber(entry.used_percent_of_weekly),
    });
  }
  return shares;
}

function buildMeterRow(
  input: {
    kind: string;
    group: string;
    utilization: number;
    resetsAt: string;
    scopeModel?: string;
    scopeSurface?: string;
    severity?: string;
    isActive?: boolean;
    share?: WeeklyShare;
  },
  capturedAt: string | undefined,
): QuotaLimitRow {
  const windowMs = windowMsForMeter(input.kind, input.group);
  const projected =
    windowMs !== undefined
      ? projectQuotaWindow({
          utilization: input.utilization,
          resetsAt: input.resetsAt,
          windowMs,
          capturedAt,
        })
      : undefined;
  return {
    kind: input.kind,
    group: input.group,
    label: meterLabel(input.kind, input.group, input.scopeModel ?? input.scopeSurface),
    utilization: input.utilization,
    resetsAt: input.resetsAt,
    ...(windowMs !== undefined ? { windowMs } : {}),
    ...(projected !== undefined ? { projected } : {}),
    ...(input.scopeModel ? { scopeModel: input.scopeModel } : {}),
    ...(input.scopeSurface ? { scopeSurface: input.scopeSurface } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.share?.allowance !== undefined
      ? { allowancePercentOfWeekly: input.share.allowance }
      : {}),
    ...(input.share?.used !== undefined ? { usedPercentOfWeekly: input.share.used } : {}),
  };
}

function parseLimitRows(
  value: unknown,
  sharesValue: unknown,
  capturedAt: string | undefined,
): QuotaLimitRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const shares = weeklySharesByIndex(sharesValue);
  const rows: QuotaLimitRow[] = [];
  value.slice(0, MAX_LIMIT_ROWS).forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const kind = shortString(raw.kind);
    const percent = finiteNumber(raw.percent);
    if (!kind || percent === undefined) return;
    const scope = isRecord(raw.scope) ? raw.scope : undefined;
    rows.push(
      buildMeterRow(
        {
          kind,
          group: shortString(raw.group) ?? '',
          utilization: Math.max(0, percent),
          resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : '',
          scopeModel: displayName(scope?.model),
          scopeSurface: displayName(scope?.surface),
          severity: shortString(raw.severity),
          isActive: typeof raw.is_active === 'boolean' ? raw.is_active : undefined,
          share: shares.get(index),
        },
        capturedAt,
      ),
    );
  });
  return rows;
}

/** Pre-`limits[]` per-model weekly fields, read only when the server sends no `limits[]`. */
const LEGACY_SCOPED_WEEKLY_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['seven_day_opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet'],
  ['seven_day_overage_included', 'Fable'],
];

function legacyScopedRows(
  data: Record<string, unknown>,
  capturedAt: string | undefined,
): QuotaLimitRow[] {
  const rows: QuotaLimitRow[] = [];
  for (const [field, model] of LEGACY_SCOPED_WEEKLY_FIELDS) {
    const window = usageWindow(data[field]);
    if (!window) continue;
    rows.push(
      buildMeterRow(
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          utilization: window.utilization,
          resetsAt: window.resetsAt,
          scopeModel: model,
        },
        capturedAt,
      ),
    );
  }
  return rows;
}

function parseExtraUsage(value: unknown): QuotaExtraUsage | undefined {
  if (!isRecord(value) || typeof value.is_enabled !== 'boolean') return undefined;
  const decimalPlaces = finiteNumber(value.decimal_places);
  return {
    enabled: value.is_enabled,
    monthlyLimit: nullableFiniteNumber(value.monthly_limit),
    usedCredits: nullableFiniteNumber(value.used_credits),
    utilization: nullableFiniteNumber(value.utilization),
    ...(shortString(value.currency) ? { currency: shortString(value.currency) } : {}),
    ...(decimalPlaces !== undefined ? { decimalPlaces } : {}),
    ...(shortString(value.disabled_reason)
      ? { disabledReason: shortString(value.disabled_reason) }
      : {}),
  };
}

/**
 * Normalize a Claude `organizations/<uuid>/prepaid/credits` reply. `amount` is
 * the remaining balance in minor units of `currency` — the same field Claude
 * Code reads; a reply without a numeric `amount` is unsupported.
 */
export function parsePrepaidCredits(payload: unknown): ClaudePrepaidCredits | undefined {
  if (!isRecord(payload)) return undefined;
  const amount = finiteNumber(payload.amount);
  if (amount === undefined || amount < 0) return undefined;
  const currency = shortString(payload.currency);
  const expiresAt = shortString(payload.next_expires_at);
  return {
    balance: amount,
    ...(currency ? { currency } : {}),
    ...(expiresAt && Number.isFinite(Date.parse(expiresAt)) ? { expiresAt } : {}),
  };
}

/** Attach a prepaid balance to `extraUsage`; a balance in another currency is dropped. */
function withPrepaidCredits<T extends QuotaState>(
  state: T,
  credits: ClaudePrepaidCredits | undefined,
): T {
  const extra = state.extraUsage;
  if (!extra || !credits) return state;
  if (credits.currency && extra.currency && credits.currency !== extra.currency) return state;
  return {
    ...state,
    extraUsage: {
      ...extra,
      ...(extra.currency || !credits.currency ? {} : { currency: credits.currency }),
      balance: credits.balance,
      ...(credits.expiresAt ? { balanceExpiresAt: credits.expiresAt } : {}),
    },
  };
}

function windowFromMeter(row: QuotaLimitRow | undefined): QuotaWindow | null {
  return row ? { utilization: row.utilization, resetsAt: row.resetsAt } : null;
}

/**
 * Normalize a Claude OAuth usage-endpoint body into a `QuotaState`.
 *
 * - `five_hour`/`seven_day` that are null or missing become `absent` windows
 *   (Ultra plans have no five-hour session limit), unless `limits[]` carries
 *   the matching `session`/`weekly_all` meter.
 * - `limits[]` is kept verbatim as `limits` (with derived labels, window
 *   lengths, and projections); older servers' `seven_day_opus` /
 *   `seven_day_sonnet` / `seven_day_overage_included` fill it instead.
 * - `extra_usage` becomes `extraUsage`.
 *
 * Bodies in the original two-window shape produce exactly the state they did
 * before these fields existed.
 */
export function quotaStateFromClaudeUsagePayload(
  payload: unknown,
  options: { capturedAt?: string } = {},
): QuotaState {
  const data = isRecord(payload) ? payload : {};
  const capturedAt = options.capturedAt;
  const parsedLimits = parseLimitRows(data.limits, data.weekly_scoped_shares, capturedAt);
  const legacyRows = parsedLimits === undefined ? legacyScopedRows(data, capturedAt) : [];
  const limits = parsedLimits ?? (legacyRows.length > 0 ? legacyRows : undefined);

  const fiveHour =
    usageWindow(data.five_hour) ??
    windowFromMeter(parsedLimits?.find((row) => row.kind === 'session')) ??
    absentWindow();
  const sevenDay =
    usageWindow(data.seven_day) ??
    windowFromMeter(parsedLimits?.find((row) => row.kind === 'weekly_all')) ??
    absentWindow();
  const extraUsage = parseExtraUsage(data.extra_usage);

  const projectedFiveHour = fiveHour.absent
    ? undefined
    : projectQuotaWindow({ ...fiveHour, windowMs: FIVE_HOUR_WINDOW_MS, capturedAt });
  const projectedSevenDay = sevenDay.absent
    ? undefined
    : projectQuotaWindow({ ...sevenDay, windowMs: SEVEN_DAY_WINDOW_MS, capturedAt });

  return {
    fiveHour,
    sevenDay,
    available: true,
    projectedFiveHour,
    projectedSevenDay,
    ...(limits ? { limits } : {}),
    ...(extraUsage ? { extraUsage } : {}),
  };
}

/** Stamp `planType` / `planLabel` from Claude credential plan facts (no-op without them). */
export function withClaudePlan<T extends QuotaState>(
  state: T,
  plan: ClaudePlanInfo | null | undefined,
): T {
  const planLabel = claudePlanLabel(plan);
  const planType = plan?.subscriptionType?.trim() || undefined;
  if (!planLabel && !planType) return state;
  return {
    ...state,
    ...(planType ? { planType } : {}),
    ...(planLabel ? { planLabel } : {}),
  };
}

type QuotaFailureMeta = Pick<QuotaState, 'failureKind' | 'httpStatus' | 'retryAfterMs'>;

/**
 * Helper to build an unavailable QuotaState.
 */
function unavailableState(error: string, meta: QuotaFailureMeta = {}): QuotaState {
  return {
    fiveHour: { utilization: 0, resetsAt: '' },
    sevenDay: { utilization: 0, resetsAt: '' },
    available: false,
    error,
    ...meta,
  };
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

function claudeOAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': BETA_HEADER,
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch the prepaid usage-credit balance of a Claude organization. Best
 * effort: resolves `undefined` on a malformed organization id, any HTTP or
 * network failure, a timeout, or an unsupported reply. Never throws.
 *
 * @param accessToken - OAuth access token of an account in the organization
 * @param organizationUuid - `oauthAccount.organizationUuid` of the same login
 */
export async function fetchClaudePrepaidCredits(
  accessToken: string,
  organizationUuid: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ClaudePrepaidCredits | undefined> {
  if (!ORGANIZATION_UUID_PATTERN.test(organizationUuid)) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const res = await fetchImpl(`${ORGANIZATIONS_URL}/${organizationUuid}/prepaid/credits`, {
      method: 'GET',
      signal: controller.signal,
      headers: claudeOAuthHeaders(accessToken),
    });
    if (!res.ok) return undefined;
    return parsePrepaidCredits(await res.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch current quota utilization from the Anthropic OAuth usage API.
 *
 * This is a **single-shot** function — it does not poll. The caller wraps
 * it in a polling loop, VS Code EventEmitter, or CLI interval as needed.
 *
 * @param accessToken - OAuth access token from `readClaudeMaxCredentials()`
 * @param options.fetchImpl - Fetch implementation (defaults to the global `fetch`; tests inject a stub)
 * @param options.plan - Plan facts from the same credentials; stamps `planType` and `planLabel`
 * @param options.organizationUuid - Organization of the same login. When the
 *   plan reports usage credits, one more request reads the prepaid balance into
 *   `extraUsage.balance`; without it the balance stays unknown.
 * @returns QuotaState with utilization data and elapsed-time projections
 */
export async function fetchQuota(
  accessToken: string,
  options: {
    fetchImpl?: typeof fetch;
    plan?: ClaudePlanInfo | null;
    organizationUuid?: string | null;
  } = {},
): Promise<QuotaState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timeout.unref();
  const fetchImpl = options.fetchImpl ?? fetch;
  let state: QuotaState;
  try {
    const res = await fetchImpl(USAGE_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: claudeOAuthHeaders(accessToken),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return unavailableState('Sign in to Claude Code to view quota', {
          failureKind: 'auth',
          httpStatus: res.status,
        });
      }

      if (res.status === 429) {
        return unavailableState(`API error: ${res.status}`, {
          failureKind: 'rate_limit',
          httpStatus: res.status,
          retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
        });
      }

      if (res.status >= 500 && res.status <= 599) {
        return unavailableState(`API error: ${res.status}`, {
          failureKind: 'server',
          httpStatus: res.status,
        });
      }

      return unavailableState(`API error: ${res.status}`, {
        failureKind: 'unknown',
        httpStatus: res.status,
      });
    }

    state = quotaStateFromClaudeUsagePayload(await res.json());
  } catch {
    return unavailableState('Network error', { failureKind: 'network' });
  } finally {
    clearTimeout(timeout);
  }

  // Only plans that report usage credits pay for the balance request.
  if (state.extraUsage && options.organizationUuid) {
    const credits = await fetchClaudePrepaidCredits(accessToken, options.organizationUuid, {
      fetchImpl,
    });
    state = withPrepaidCredits(state, credits);
  }
  return withClaudePlan(state, options.plan);
}
