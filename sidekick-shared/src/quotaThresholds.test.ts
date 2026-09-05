import { describe, expect, it } from 'vitest';
import type { QuotaState } from './quota';
import {
  DEFAULT_QUOTA_THRESHOLDS,
  describeQuotaThresholdAlert,
  evaluateQuotaThresholds,
} from './quotaThresholds';

function quota(
  fiveHour: number,
  sevenDay: number,
  overrides: Partial<QuotaState> = {},
): QuotaState {
  return {
    fiveHour: { utilization: fiveHour, resetsAt: '2026-07-18T16:00:00.000Z' },
    sevenDay: { utilization: sevenDay, resetsAt: '2026-07-21T00:00:00.000Z' },
    available: true,
    ...overrides,
  };
}

describe('evaluateQuotaThresholds', () => {
  it('fires once per threshold on the rising edge', () => {
    let memory = {};
    let result = evaluateQuotaThresholds(quota(50, 10), DEFAULT_QUOTA_THRESHOLDS, memory);
    expect(result.alerts).toEqual([]);
    memory = result.memory;

    result = evaluateQuotaThresholds(quota(82, 10), DEFAULT_QUOTA_THRESHOLDS, memory);
    expect(result.alerts).toMatchObject([
      { window: 'fiveHour', threshold: 80, severity: 'warning' },
    ]);
    memory = result.memory;

    // Same window, still above 80: no repeat.
    result = evaluateQuotaThresholds(quota(88, 10), DEFAULT_QUOTA_THRESHOLDS, memory);
    expect(result.alerts).toEqual([]);
    memory = result.memory;

    result = evaluateQuotaThresholds(quota(96, 10), DEFAULT_QUOTA_THRESHOLDS, memory);
    expect(result.alerts).toMatchObject([
      { window: 'fiveHour', threshold: 95, severity: 'critical' },
    ]);
  });

  it('jumps straight to the highest crossed threshold', () => {
    const result = evaluateQuotaThresholds(quota(97, 0));
    expect(result.alerts).toMatchObject([{ threshold: 95, severity: 'critical' }]);
  });

  it('re-arms when the window resets', () => {
    let result = evaluateQuotaThresholds(quota(90, 0));
    expect(result.alerts).toHaveLength(1);
    const reset = quota(85, 0, {
      fiveHour: { utilization: 85, resetsAt: '2026-07-18T21:00:00.000Z' },
    });
    result = evaluateQuotaThresholds(reset, DEFAULT_QUOTA_THRESHOLDS, result.memory);
    expect(result.alerts).toMatchObject([{ window: 'fiveHour', threshold: 80 }]);
  });

  it('evaluates the seven-day window independently', () => {
    const result = evaluateQuotaThresholds(quota(10, 91));
    expect(result.alerts).toMatchObject([
      { window: 'sevenDay', threshold: 90, severity: 'critical' },
    ]);
  });

  it('ignores unavailable samples and keeps memory', () => {
    const first = evaluateQuotaThresholds(quota(90, 0));
    const result = evaluateQuotaThresholds(
      quota(0, 0, { available: false }),
      DEFAULT_QUOTA_THRESHOLDS,
      first.memory,
    );
    expect(result.alerts).toEqual([]);
    expect(result.memory).toBe(first.memory);
  });

  it('sanitizes threshold lists', () => {
    const result = evaluateQuotaThresholds(quota(50, 0), {
      fiveHour: [150, -5, Number.NaN, 40, 40],
      sevenDay: [],
    });
    expect(result.alerts).toMatchObject([{ threshold: 40, severity: 'critical' }]);
  });
});

describe('describeQuotaThresholdAlert', () => {
  it('names the window, utilization, and reset time', () => {
    const [alert] = evaluateQuotaThresholds(quota(82.4, 0)).alerts;
    const text = describeQuotaThresholdAlert(alert, {
      providerLabel: 'Claude',
      now: new Date('2026-07-18T13:00:00.000Z'),
    });
    expect(text).toMatch(/^Claude five-hour window at 82% \(resets .+\)$/);
  });

  it('omits the reset clause when the reset time is unknown', () => {
    const [alert] = evaluateQuotaThresholds(
      quota(0, 95, { sevenDay: { utilization: 95, resetsAt: '' } }),
    ).alerts;
    expect(describeQuotaThresholdAlert(alert)).toBe('Claude seven-day window at 95%');
  });
});
