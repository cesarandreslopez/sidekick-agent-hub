import type { QuotaState } from './quota';

export interface QuotaFailureDescriptor {
  severity: 'info' | 'warning' | 'error';
  title: string;
  message: string;
  detail?: string;
  alertKey: string;
  isRetryable: boolean;
}

function formatRetryAfter(ms: number): string {
  if (ms <= 0) return 'now';

  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

export function describeQuotaFailure(quota: QuotaState | null | undefined): QuotaFailureDescriptor | null {
  if (!quota || quota.available || !quota.failureKind) return null;

  switch (quota.failureKind) {
    case 'auth':
      if (quota.error === 'No OAuth token available') {
        return {
          severity: 'error',
          title: 'Sign in required',
          message: 'No Claude Code credentials are available in this environment.',
          detail: 'Run `claude` to sign in, then retry quota refresh.',
          alertKey: 'auth:no-credentials',
          isRetryable: false,
        };
      }

      return {
        severity: 'error',
        title: 'Claude Code sign-in expired',
        message: 'The current Claude Code OAuth session was rejected.',
        detail: 'Sign in again to refresh subscription quota.',
        alertKey: `auth:${quota.httpStatus ?? 'unknown'}`,
        isRetryable: false,
      };

    case 'network':
      return {
        severity: 'warning',
        title: 'Quota API unreachable',
        message: 'Could not reach Anthropic from the current environment.',
        detail: 'Check connectivity, proxy, or firewall settings, then retry.',
        alertKey: 'network',
        isRetryable: true,
      };

    case 'rate_limit':
      return {
        severity: 'warning',
        title: 'Quota API rate limited',
        message: quota.retryAfterMs != null
          ? `Retry in ${formatRetryAfter(quota.retryAfterMs)}.`
          : 'Retry shortly.',
        detail: quota.httpStatus != null ? `Anthropic returned HTTP ${quota.httpStatus}.` : undefined,
        alertKey: `rate_limit:${quota.httpStatus ?? 429}`,
        isRetryable: true,
      };

    case 'server':
      return {
        severity: 'warning',
        title: 'Quota API unavailable',
        message: quota.httpStatus != null
          ? `Anthropic returned HTTP ${quota.httpStatus}. Try again shortly.`
          : 'Anthropic quota data is temporarily unavailable.',
        alertKey: `server:${quota.httpStatus ?? 'unknown'}`,
        isRetryable: true,
      };

    case 'unknown':
      return {
        severity: 'error',
        title: 'Unexpected quota response',
        message: quota.httpStatus != null
          ? `Anthropic returned HTTP ${quota.httpStatus}.`
          : (quota.error ?? 'Quota data could not be retrieved.'),
        detail: 'This failure is not classified as retryable.',
        alertKey: `unknown:${quota.httpStatus ?? 'none'}`,
        isRetryable: false,
      };
  }
}
