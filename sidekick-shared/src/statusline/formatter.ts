import type { ActiveAccountStatus } from '../accountStatus';
import type { QuotaState } from '../quota';
import { FIVE_HOUR_WINDOW_MS, formatQuotaAge } from '../quota';
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

  const utilization = clampPercent(quota.fiveHour.utilization);
  const reset = formatReset(quota.fiveHour.resetsAt, now);
  const eta = estimateWindowEta(quota, now);
  const segments = [`acct:${account}`, `5h ${Math.round(utilization)}% resets ${reset}`];
  if (eta != null) segments.push(`~${formatMinutes(eta)} left`);
  if (quota.sevenDay.resetsAt && quota.sevenDay.utilization > 0) {
    segments.push(`7d ${Math.round(clampPercent(quota.sevenDay.utilization))}%`);
  }
  if (quota.freshness && quota.freshness !== 'fresh') {
    segments.push(`(${formatQuotaAge(quota.ageMs)})`);
  }
  return joinSegments([...segments, ...liveSegments]);
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

function estimateWindowEta(quota: QuotaState, now: Date): number | null {
  const resetAt = Date.parse(quota.fiveHour.resetsAt);
  if (!Number.isFinite(resetAt)) return null;
  const nowMs = now.getTime();
  if (resetAt <= nowMs) return null;
  const capturedAt = quota.capturedAt ? Date.parse(quota.capturedAt) : now.getTime();
  const sampleAt = Number.isFinite(capturedAt) ? capturedAt : now.getTime();
  if (sampleAt >= resetAt) return null;
  const elapsedMinutes = (sampleAt - (resetAt - FIVE_HOUR_WINDOW_MS)) / 60_000;
  if (elapsedMinutes <= 0 || quota.fiveHour.utilization <= 0) return null;
  const burnRate = quota.fiveHour.utilization / elapsedMinutes;
  const eta = estimateTimeToQuota(quota.fiveHour.utilization, 100, burnRate);
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

function formatReset(value: string, fallback: Date): string {
  const reset = new Date(value);
  const date = Number.isNaN(reset.getTime()) ? fallback : reset;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatMinutes(value: number): string {
  const minutes = Math.max(0, Math.round(value));
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h${remainder}m` : `${hours}h`;
}
