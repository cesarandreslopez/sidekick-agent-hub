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
        fiveHour: { utilization: 68, resetsAt: '2026-07-18T14:00:00.000Z' },
        sevenDay: { utilization: 20, resetsAt: '2026-07-20T00:00:00.000Z' },
      },
    });
    expect(result).toMatch(/^acct:work · 5h 68% resets /);
    expect(result).toContain('left');
  });

  it('stays useful when no cache exists', () => {
    expect(formatStatusline({ accounts })).toBe('acct:work · quota unavailable');
  });
});
