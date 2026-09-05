import { describe, expect, it } from 'vitest';
import type { ActiveAccountStatus } from '../accountStatus';
import { formatStatusline } from './formatter';

const accounts: ActiveAccountStatus = {
  ok: true,
  claude: { present: true, accountId: 'work-id', label: 'work' },
  codex: { present: false },
};

describe('formatStatusline', () => {
  it('renders account, cached 5h quota, reset, and ETA', () => {
    const now = new Date('2026-07-18T13:00:00.000Z');
    const result = formatStatusline({
      accounts,
      now,
      claudeQuota: {
        available: true,
        capturedAt: now.toISOString(),
        fiveHour: { utilization: 90, resetsAt: '2026-07-18T14:00:00.000Z' },
        sevenDay: { utilization: 20, resetsAt: '2026-07-20T00:00:00.000Z' },
      },
    });
    expect(result).toMatch(/^acct:work · 5h 90% resets /);
    expect(result).toContain('left');
  });

  it('stays useful when no cache exists', () => {
    expect(formatStatusline({ accounts })).toBe('acct:work · quota unavailable');
  });

  it('suppresses ETA when reset arrives before exhaustion or already passed', () => {
    const now = new Date('2026-07-18T13:00:00.000Z');
    const quota = {
      available: true,
      capturedAt: now.toISOString(),
      fiveHour: { utilization: 68, resetsAt: '2026-07-18T14:00:00.000Z' },
      sevenDay: { utilization: 20, resetsAt: '2026-07-20T00:00:00.000Z' },
    };

    expect(formatStatusline({ accounts, now, claudeQuota: quota })).not.toContain('left');
    expect(
      formatStatusline({
        accounts,
        now,
        claudeQuota: {
          ...quota,
          capturedAt: '2026-07-18T11:00:00.000Z',
          fiveHour: { utilization: 95, resetsAt: '2026-07-18T12:00:00.000Z' },
        },
      }),
    ).not.toContain('left');
  });
});

describe('formatStatusline live segments', () => {
  const now = new Date('2026-07-18T13:00:00.000Z');
  const quota = {
    available: true,
    capturedAt: now.toISOString(),
    fiveHour: { utilization: 42, resetsAt: '2026-07-18T16:00:00.000Z' },
    sevenDay: { utilization: 61, resetsAt: '2026-07-20T00:00:00.000Z' },
  };

  it('appends context, cost, cache, and the seven-day window', () => {
    const result = formatStatusline({
      accounts,
      now,
      claudeQuota: quota,
      live: {
        contextWindow: { usedPercentage: 37.4 },
        cost: { totalCostUsd: 0.4211 },
        promptCache: { hitRatio: 0.925 },
        raw: {},
      },
    });
    expect(result).toMatch(/^acct:work · 5h 42% resets /);
    expect(result).toContain('7d 61%');
    expect(result).toContain('ctx 37%');
    expect(result).toContain('$0.42');
    expect(result).toContain('cache 93%');
  });

  it('labels quota older than five minutes with its age', () => {
    const result = formatStatusline({
      accounts,
      now,
      claudeQuota: { ...quota, ageMs: 2 * 3_600_000, freshness: 'stale' },
    });
    expect(result).toContain('(2h ago)');
  });

  it('keeps live segments even when no account is known', () => {
    const result = formatStatusline({
      accounts: { ok: false, claude: { present: false }, codex: { present: false } },
      live: { contextWindow: { usedPercentage: 12 }, raw: {} },
    });
    expect(result).toBe('acct:none · quota unavailable · ctx 12%');
  });
});
