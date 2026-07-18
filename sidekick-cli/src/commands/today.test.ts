import { describe, expect, it, vi } from 'vitest';

vi.mock('../cli', () => ({ resolveProvider: vi.fn() }));

import { compactBriefText, scheduledPeakHoursLine } from './today';

describe('scheduledPeakHoursLine', () => {
  it('reports the documented weekday peak window without a network lookup', () => {
    expect(scheduledPeakHoursLine(new Date('2026-07-20T15:00:00Z'))).toContain('active');
    expect(scheduledPeakHoursLine(new Date('2026-07-20T20:00:00Z'))).toContain('off-peak');
    expect(scheduledPeakHoursLine(new Date('2026-07-19T15:00:00Z'))).toContain('off-peak');
  });

  it('keeps long handoffs compact enough for the one-screen brief', () => {
    expect(compactBriefText('line one\n\nline two')).toBe('line one line two');
    expect(compactBriefText('x'.repeat(200), 20)).toHaveLength(20);
  });
});
