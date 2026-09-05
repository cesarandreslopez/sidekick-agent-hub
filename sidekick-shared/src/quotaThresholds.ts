/**
 * Threshold-crossing detection for subscription quota windows.
 *
 * Pure and host-neutral: the VS Code extension and the CLI dashboard both
 * feed it every quota sample and raise whatever alerts it returns, so a user
 * hears "your five-hour window is at 80%" the same way in both. Alerts fire
 * once per threshold per reset window, on the rising edge; when a window
 * resets the memory resets with it.
 *
 * @module quotaThresholds
 */

import type { QuotaState } from './quota';

export type QuotaThresholdWindow = 'fiveHour' | 'sevenDay';

export interface QuotaThresholdConfig {
  /** Utilization percentages (0–100) that raise an alert for the five-hour window. */
  fiveHour: readonly number[];
  /** Utilization percentages (0–100) that raise an alert for the seven-day window. */
  sevenDay: readonly number[];
}

/**
 * Defaults tuned to the two surprises users report: the afternoon five-hour
 * cutoff (warn at 80%, escalate at 95%) and the mid-week weekly cap (90%).
 */
export const DEFAULT_QUOTA_THRESHOLDS: QuotaThresholdConfig = {
  fiveHour: [80, 95],
  sevenDay: [90],
};

interface WindowMemory {
  resetsAt: string;
  /** Highest threshold already alerted for this reset window (0 = none). */
  level: number;
}

/** Opaque per-window state; keep it between samples and pass it back in. */
export interface QuotaAlertMemory {
  fiveHour?: WindowMemory;
  sevenDay?: WindowMemory;
}

export interface QuotaThresholdAlert {
  window: QuotaThresholdWindow;
  /** The threshold that was crossed. */
  threshold: number;
  /** Utilization at the time of the sample. */
  utilization: number;
  /** ISO reset time of the window, when known. */
  resetsAt: string;
  /** Escalation hint: the highest configured threshold is `critical`. */
  severity: 'warning' | 'critical';
}

export interface QuotaThresholdEvaluation {
  alerts: QuotaThresholdAlert[];
  memory: QuotaAlertMemory;
}

function sanitizeThresholds(values: readonly number[]): number[] {
  return [...new Set(values.filter((v) => Number.isFinite(v) && v > 0 && v <= 100))].sort(
    (a, b) => a - b,
  );
}

function evaluateWindow(
  window: QuotaThresholdWindow,
  quota: QuotaState[QuotaThresholdWindow],
  thresholds: readonly number[],
  previous: WindowMemory | undefined,
): { alert: QuotaThresholdAlert | null; memory: WindowMemory } {
  const sorted = sanitizeThresholds(thresholds);
  const utilization = Number.isFinite(quota.utilization) ? quota.utilization : 0;
  const resetsAt = quota.resetsAt ?? '';
  let level = 0;
  for (const threshold of sorted) if (utilization >= threshold) level = threshold;
  const previousLevel = previous && previous.resetsAt === resetsAt ? previous.level : 0;
  const memory: WindowMemory = { resetsAt, level: Math.max(level, previousLevel) };
  if (level <= previousLevel) return { alert: null, memory };
  return {
    alert: {
      window,
      threshold: level,
      utilization,
      resetsAt,
      severity: level >= sorted[sorted.length - 1] ? 'critical' : 'warning',
    },
    memory,
  };
}

/**
 * Compare a quota sample against the thresholds and the alerts already
 * raised. Unavailable samples produce no alerts and leave the memory alone.
 */
export function evaluateQuotaThresholds(
  quota: QuotaState,
  config: QuotaThresholdConfig = DEFAULT_QUOTA_THRESHOLDS,
  memory: QuotaAlertMemory = {},
): QuotaThresholdEvaluation {
  if (!quota.available) return { alerts: [], memory };
  const fiveHour = evaluateWindow('fiveHour', quota.fiveHour, config.fiveHour, memory.fiveHour);
  const sevenDay = evaluateWindow('sevenDay', quota.sevenDay, config.sevenDay, memory.sevenDay);
  return {
    alerts: [fiveHour.alert, sevenDay.alert].filter(
      (alert): alert is QuotaThresholdAlert => alert !== null,
    ),
    memory: { fiveHour: fiveHour.memory, sevenDay: sevenDay.memory },
  };
}

const WINDOW_LABELS: Record<QuotaThresholdWindow, string> = {
  fiveHour: 'five-hour window',
  sevenDay: 'seven-day window',
};

function formatResetTime(resetsAt: string, now: Date): string | null {
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  const reset = new Date(ms);
  const sameDay =
    reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(reset);
}

/** One-line, reset-aware message: `Claude five-hour window at 82% (resets 14:00)`. */
export function describeQuotaThresholdAlert(
  alert: QuotaThresholdAlert,
  options: { providerLabel?: string; now?: Date } = {},
): string {
  const provider = options.providerLabel ?? 'Claude';
  const reset = formatResetTime(alert.resetsAt, options.now ?? new Date());
  const suffix = reset ? ` (resets ${reset})` : '';
  return `${provider} ${WINDOW_LABELS[alert.window]} at ${Math.round(alert.utilization)}%${suffix}`;
}
