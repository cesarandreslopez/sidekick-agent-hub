import { describe, expect, it } from 'vitest';
import { describeQuotaFailure } from './quotaPresentation';

describe('describeQuotaFailure', () => {
  it('returns null for available quota', () => {
    expect(describeQuotaFailure({
      fiveHour: { utilization: 10, resetsAt: '2026-03-12T14:00:00Z' },
      sevenDay: { utilization: 20, resetsAt: '2026-03-13T12:00:00Z' },
      available: true,
    })).toBeNull();
  });

  it('describes missing credentials as a non-retryable auth failure', () => {
    expect(describeQuotaFailure({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'No OAuth token available',
      failureKind: 'auth',
    })).toEqual({
      severity: 'error',
      title: 'Sign in required',
      message: 'No Claude Code credentials are available in this environment.',
      detail: 'Run `claude` to sign in, then retry quota refresh.',
      alertKey: 'auth:no-credentials',
      isRetryable: false,
    });
  });

  it('describes rejected auth tokens separately from missing credentials', () => {
    const descriptor = describeQuotaFailure({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'Sign in to Claude Code to view quota',
      failureKind: 'auth',
      httpStatus: 401,
    });

    expect(descriptor).toMatchObject({
      severity: 'error',
      title: 'Claude Code sign-in expired',
      alertKey: 'auth:401',
      isRetryable: false,
    });
  });

  it('formats retry-after data for rate limits without making the alert key unstable', () => {
    const first = describeQuotaFailure({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'API error: 429',
      failureKind: 'rate_limit',
      httpStatus: 429,
      retryAfterMs: 45_000,
    });
    const second = describeQuotaFailure({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'API error: 429',
      failureKind: 'rate_limit',
      httpStatus: 429,
      retryAfterMs: 10_000,
    });

    expect(first).toMatchObject({
      severity: 'warning',
      title: 'Quota API rate limited',
      message: 'Retry in 45s.',
      detail: 'Anthropic returned HTTP 429.',
      alertKey: 'rate_limit:429',
      isRetryable: true,
    });
    expect(second?.alertKey).toBe(first?.alertKey);
  });

  it('describes server failures as retryable warnings', () => {
    expect(describeQuotaFailure({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'API error: 503',
      failureKind: 'server',
      httpStatus: 503,
    })).toMatchObject({
      severity: 'warning',
      title: 'Quota API unavailable',
      alertKey: 'server:503',
      isRetryable: true,
    });
  });

  it('describes network failures as retryable warnings', () => {
    expect(describeQuotaFailure({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'Network error',
      failureKind: 'network',
    })).toMatchObject({
      severity: 'warning',
      title: 'Quota API unreachable',
      alertKey: 'network',
      isRetryable: true,
    });
  });

  it('describes unknown failures as non-retryable errors', () => {
    expect(describeQuotaFailure({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'API error: 403',
      failureKind: 'unknown',
      httpStatus: 403,
    })).toEqual({
      severity: 'error',
      title: 'Unexpected quota response',
      message: 'Anthropic returned HTTP 403.',
      detail: 'This failure is not classified as retryable.',
      alertKey: 'unknown:403',
      isRetryable: false,
    });
  });
});
