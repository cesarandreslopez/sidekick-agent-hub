import type { ActiveAccountStatus } from '../accountStatus';
import type { QuotaState, QuotaWindow } from '../quota';
import {
  FIVE_HOUR_WINDOW_MS,
  SEVEN_DAY_WINDOW_MS,
  formatQuotaAge,
  quotaWindowApplies,
  quotaWindowHasData,
  quotaWindowShortLabel,
} from '../quota';
import { estimateTimeToQuota } from './BurnRateCalculator';
import type { ClaudeStatuslinePayload } from './claudeStatuslinePayload';

export interface StatuslineInput {
  accounts: ActiveAccountStatus;
  claudeQuota?: QuotaState | null;
  codexQuota?: QuotaState | null;
  /**
   * The document Claude Code piped to the status-line command, when running
   * as one. Adds context usage, session cost, and prompt-cache hit rate.
   */
  live?: ClaudeStatuslinePayload | null;
  now?: Date;
}

export interface StatuslineSelection {
  providerId: 'claude-code' | 'codex';
  accountId?: string;
  accountLabel: string;
  quota: QuotaState | null;
}

export function selectStatuslineAccount(input: StatuslineInput): StatuslineSelection | null {
  if (input.accounts.claude.present) {
    return {
      providerId: 'claude-code',
      accountId: input.accounts.claude.accountId,
      accountLabel: input.accounts.claude.label ?? input.accounts.claude.email ?? 'claude',
      quota: input.claudeQuota ?? null,
    };
  }
  if (input.accounts.codex.present) {
    return {
      providerId: 'codex',
      accountId: input.accounts.codex.accountId,
      accountLabel: input.accounts.codex.label ?? input.accounts.codex.email ?? 'codex',
      quota: input.codexQuota ?? null,
    };
  }
  return null;
}

/**
 * One-line status. Segments, in order, each omitted when unknown:
 * `acct:<label> · 5h 42% resets 14:00 · ~1h20m left · 7d 61% · (2h ago) · ctx 37% · $0.42 · cache 92%`
 *
 * Plans without a five-hour window (Claude Ultra) lead with the weekly window
 * instead: `acct:<label> · 7d 17% resets Fri 01:00 · ~2d3h left · …`. Window
 * labels follow the reported window length, so a Codex weekly primary window
 * reads `7d`, not `5h`.
 *
 * The age segment appears only for cached quota older than five minutes, so
 * a snapshot from yesterday can no longer read like a live figure.
 */
export function formatStatusline(input: StatuslineInput): string {
  const selected = selectStatuslineAccount(input);
  const now = input.now ?? new Date();
  const liveSegments = formatLiveSegments(input.live);
  if (!selected) return joinSegments(['acct:none', 'quota unavailable', ...liveSegments]);
  const account = compactLabel(selected.accountLabel);
  const quota = selected.quota;
  if (!quota?.available) {
    return joinSegments([`acct:${account}`, 'quota unavailable', ...liveSegments]);
  }

  const first = describeWindow(quota.fiveHour, '5h', FIVE_HOUR_WINDOW_MS);
  const second = describeWindow(quota.sevenDay, '7d', SEVEN_DAY_WINDOW_MS);
  // Lead with the first window whenever the plan has it (even idle); fall back
  // to the second window when the first does not exist for this plan.
  const leadWithFirst = quotaWindowApplies(quota.fiveHour) || !quotaWindowHasData(quota.sevenDay);
  const lead = leadWithFirst ? first : second;
  const segments = [`acct:${account}`, formatLeadSegment(lead, now)];
  const eta = estimateWindowEta(lead, quota.capturedAt, now);
  if (eta != null) segments.push(`~${formatMinutes(eta)} left`);
  if (leadWithFirst && quotaWindowHasData(quota.sevenDay) && quota.sevenDay.utilization > 0) {
    segments.push(`${second.label} ${Math.round(clampPercent(quota.sevenDay.utilization))}%`);
  }
  if (quota.freshness && quota.freshness !== 'fresh') {
    segments.push(`(${formatQuotaAge(quota.ageMs)})`);
  }
  return joinSegments([...segments, ...liveSegments]);
}

interface DescribedWindow {
  label: string;
  window: QuotaWindow;
  windowMs: number;
}

function describeWindow(window: QuotaWindow, label: string, defaultMs: number): DescribedWindow {
  const windowMs =
    typeof window.windowMs === 'number' && Number.isFinite(window.windowMs) && window.windowMs > 0
      ? window.windowMs
      : defaultMs;
  return { label: quotaWindowShortLabel(window.windowMs, label), window, windowMs };
}

function formatLeadSegment(lead: DescribedWindow, now: Date): string {
  const percent = `${lead.label} ${Math.round(clampPercent(lead.window.utilization))}%`;
  const reset = formatReset(lead.window.resetsAt, now);
  return reset ? `${percent} resets ${reset}` : percent;
}

function formatLiveSegments(live: ClaudeStatuslinePayload | null | undefined): string[] {
  if (!live) return [];
  const segments: string[] = [];
  const context = live.contextWindow?.usedPercentage;
  if (typeof context === 'number') segments.push(`ctx ${Math.round(clampPercent(context))}%`);
  const cost = live.cost?.totalCostUsd;
  if (typeof cost === 'number' && cost > 0) segments.push(`$${formatCost(cost)}`);
  const hitRatio = live.promptCache?.hitRatio;
  if (typeof hitRatio === 'number')
    segments.push(`cache ${Math.round(clampPercent(hitRatio * 100))}%`);
  return segments;
}

function joinSegments(segments: string[]): string {
  return segments.join(' · ');
}

function formatCost(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function estimateWindowEta(
  lead: DescribedWindow,
  capturedAtIso: string | undefined,
  now: Date,
): number | null {
  const { window, windowMs } = lead;
  if (window.absent) return null;
  const resetAt = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetAt)) return null;
  const nowMs = now.getTime();
  if (resetAt <= nowMs) return null;
  const capturedAt = capturedAtIso ? Date.parse(capturedAtIso) : now.getTime();
  const sampleAt = Number.isFinite(capturedAt) ? capturedAt : now.getTime();
  if (sampleAt >= resetAt) return null;
  const elapsedMinutes = (sampleAt - (resetAt - windowMs)) / 60_000;
  if (elapsedMinutes <= 0 || window.utilization <= 0) return null;
  const burnRate = window.utilization / elapsedMinutes;
  const eta = estimateTimeToQuota(window.utilization, 100, burnRate);
  const minutesUntilReset = (resetAt - nowMs) / 60_000;
  return eta !== null && eta < minutesUntilReset ? eta : null;
}

function compactLabel(value: string): string {
  const trimmed = value.trim();
  const localPart = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
  return localPart.replace(/\s+/g, '-').slice(0, 24) || 'unknown';
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

/**
 * Reset time as `HH:MM`, or `Fri 01:00` when it is more than a day away.
 * Returns '' for an empty or unparseable value — never the current time.
 */
function formatReset(value: string, now: Date): string {
  if (!value) return '';
  const reset = new Date(value);
  if (Number.isNaN(reset.getTime())) return '';
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(reset);
  if (reset.getTime() - now.getTime() <= 86_400_000) return time;
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(reset);
  return `${weekday} ${time}`;
}

function formatMinutes(value: number): string {
  const minutes = Math.max(0, Math.round(value));
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    const remainderHours = hours % 24;
    return remainderHours ? `${days}d${remainderHours}h` : `${days}d`;
  }
  const remainder = minutes % 60;
  return remainder ? `${hours}h${remainder}m` : `${hours}h`;
}
