import type { QuotaState } from './quota';
import type { CodexRateLimits } from './types/codex';

export function quotaFromCodexRateLimits(
  rateLimits: CodexRateLimits | null | undefined,
  source: 'session' | 'cache' = 'session',
  capturedAt = new Date().toISOString(),
): QuotaState | null {
  const primary = rateLimits?.primary;
  const secondary = rateLimits?.secondary;
  if (!primary && !secondary) return null;

  return {
    fiveHour: primary
      ? { utilization: primary.used_percent, resetsAt: new Date(primary.resets_at * 1000).toISOString() }
      : { utilization: 0, resetsAt: '' },
    sevenDay: secondary
      ? { utilization: secondary.used_percent, resetsAt: new Date(secondary.resets_at * 1000).toISOString() }
      : { utilization: 0, resetsAt: '' },
    available: true,
    providerId: 'codex',
    source,
    capturedAt,
    stale: source === 'cache',
    fiveHourLabel: 'Primary',
    sevenDayLabel: 'Secondary',
  };
}
