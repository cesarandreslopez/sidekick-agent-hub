import { describe, it, expect } from 'vitest';
import {
  quotaWindowSchema,
  quotaStateSchema,
  peakHoursStateSchema,
  quotaFailureDescriptorSchema,
  providerQuotaStateSchema,
  providerQuotaMapSchema,
} from './quota';
import type { ProviderQuotaState } from '../providerQuota';

function fullCodexState(): ProviderQuotaState<'codex'> {
  return {
    runtimeProvider: 'codex',
    fiveHour: { utilization: 42, resetsAt: '2026-06-09T12:00:00Z' },
    sevenDay: { utilization: 13, resetsAt: '2026-06-12T00:00:00Z' },
    available: true,
    providerId: 'codex',
    source: 'cache',
    capturedAt: '2026-06-09T08:00:00Z',
    stale: false,
    fiveHourLabel: 'Primary',
    sevenDayLabel: 'Secondary',
    accountLabel: 'Default',
    peakHours: null,
    failure: null,
  };
}

describe('quotaWindowSchema', () => {
  it('accepts a valid window', () => {
    expect(quotaWindowSchema.safeParse({ utilization: 50, resetsAt: '' }).success).toBe(true);
  });

  it('rejects a string utilization', () => {
    expect(quotaWindowSchema.safeParse({ utilization: '50', resetsAt: '' }).success).toBe(false);
  });
});

describe('quotaStateSchema', () => {
  it('round-trips the unavailable shape fetchQuota produces', () => {
    const unavailable = {
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      error: 'HTTP 429',
      failureKind: 'rate_limit',
      httpStatus: 429,
      retryAfterMs: 30_000,
    };
    const result = quotaStateSchema.safeParse(unavailable);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(unavailable);
  });

  it('round-trips a fully-populated available state', () => {
    const state = {
      fiveHour: { utilization: 42, resetsAt: '2026-06-09T12:00:00Z' },
      sevenDay: { utilization: 13, resetsAt: '2026-06-12T00:00:00Z' },
      available: true,
      projectedFiveHour: 80,
      projectedSevenDay: 20,
      providerId: 'codex',
      source: 'cache',
      capturedAt: '2026-06-09T08:00:00Z',
      stale: true,
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
      limitId: 'codex-primary',
      limitName: 'Primary window',
      credits: { remaining: 12.5 },
      planType: 'pro',
      rateLimitReachedType: 'secondary',
    };
    const result = quotaStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(state);
  });

  it('rejects unknown failureKind values', () => {
    const result = quotaStateSchema.safeParse({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: false,
      failureKind: 'timeout',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a state missing `available`', () => {
    const result = quotaStateSchema.safeParse({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
    });
    expect(result.success).toBe(false);
  });

  it('strips unknown extra keys (strict-object behavior, not passthrough)', () => {
    const result = quotaStateSchema.safeParse({
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 0, resetsAt: '' },
      available: true,
      someFutureField: 'dropped',
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('someFutureField');
  });
});

describe('peakHoursStateSchema', () => {
  it('accepts an unavailable state with nulls', () => {
    const result = peakHoursStateSchema.safeParse({
      status: 'unknown',
      isPeak: false,
      sessionLimitSpeed: 'unknown',
      label: 'Peak hours unknown',
      peakHoursDescription: '',
      nextChange: null,
      minutesUntilChange: null,
      note: '',
      updatedAt: '2026-06-09T08:00:00Z',
      unavailable: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a not-applicable provider state', () => {
    const result = peakHoursStateSchema.safeParse({
      status: 'off_peak',
      isPeak: false,
      sessionLimitSpeed: 'normal',
      label: 'Not applicable',
      peakHoursDescription: '',
      nextChange: '2026-06-09T17:00:00Z',
      minutesUntilChange: 90,
      note: '',
      updatedAt: '2026-06-09T08:00:00Z',
      unavailable: false,
      notApplicable: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const result = peakHoursStateSchema.safeParse({
      status: 'busy',
      isPeak: true,
      sessionLimitSpeed: 'normal',
      label: '',
      peakHoursDescription: '',
      nextChange: null,
      minutesUntilChange: null,
      note: '',
      updatedAt: '',
      unavailable: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('quotaFailureDescriptorSchema', () => {
  it('accepts a valid descriptor', () => {
    const result = quotaFailureDescriptorSchema.safeParse({
      severity: 'warning',
      title: 'Rate limited',
      message: 'Try again later',
      alertKey: 'quota.rate_limit',
      isRetryable: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown severity', () => {
    const result = quotaFailureDescriptorSchema.safeParse({
      severity: 'fatal',
      title: '',
      message: '',
      alertKey: '',
      isRetryable: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('providerQuotaStateSchema', () => {
  it('round-trips a full codex state with null peakHours/failure', () => {
    const state = fullCodexState();
    const result = providerQuotaStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(state);
  });

  it('rejects an unknown runtimeProvider', () => {
    const result = providerQuotaStateSchema.safeParse({
      ...fullCodexState(),
      runtimeProvider: 'opencode',
    });
    expect(result.success).toBe(false);
  });
});

describe('providerQuotaMapSchema', () => {
  it('accepts an empty map', () => {
    expect(providerQuotaMapSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a map with a claude entry', () => {
    const result = providerQuotaMapSchema.safeParse({
      claude: { ...fullCodexState(), runtimeProvider: 'claude', providerId: 'claude-code' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a codex state under the claude key (literal narrowing)', () => {
    const result = providerQuotaMapSchema.safeParse({
      claude: fullCodexState(),
    });
    expect(result.success).toBe(false);
  });
});
