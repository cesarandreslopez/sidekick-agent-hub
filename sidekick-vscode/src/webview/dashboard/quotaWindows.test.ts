import { describe, expect, it } from 'vitest';
import {
  quotaCardVisibility,
  quotaSectionTooltip,
  renderQuotaExtrasHtml,
  type QuotaView,
} from './quotaWindows';

const ULTRA: QuotaView = {
  providerId: 'claude-code',
  fiveHour: { utilization: 0, resetsAt: '', absent: true },
  sevenDay: { utilization: 17, resetsAt: '2026-11-07T06:00:00Z' },
  planLabel: 'Ultra',
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      label: '7-Day',
      utilization: 17,
      resetsAt: '2026-11-07T06:00:00Z',
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      label: '7-Day (Fable)',
      utilization: 4,
      resetsAt: '2026-11-07T06:00:00Z',
      scopeModel: 'Fable',
      allowancePercentOfWeekly: 50,
    },
  ],
  extraUsage: {
    enabled: false,
    monthlyLimit: 20000,
    usedCredits: 0,
    utilization: 0,
    currency: 'USD',
    decimalPlaces: 2,
    disabledReason: 'out_of_credits',
  },
};

describe('quotaCardVisibility', () => {
  it('hides the five-hour card on a plan without one', () => {
    expect(quotaCardVisibility(ULTRA, 'claude-code')).toEqual({ fiveHour: false, sevenDay: true });
  });

  it('keeps an idle Claude window visible', () => {
    expect(
      quotaCardVisibility({ ...ULTRA, fiveHour: { utilization: 0, resetsAt: '' } }, 'claude-code'),
    ).toEqual({ fiveHour: true, sevenDay: true });
  });

  it('shows only the reported window for a weekly-only Codex plan', () => {
    expect(
      quotaCardVisibility(
        {
          providerId: 'codex',
          fiveHour: { utilization: 37, resetsAt: '2026-11-07T00:20:19Z' },
          sevenDay: { utilization: 0, resetsAt: '', absent: true },
        },
        'codex',
      ),
    ).toEqual({ fiveHour: true, sevenDay: false });
  });
});

describe('renderQuotaExtrasHtml', () => {
  it('renders extra meters and plan notes', () => {
    const html = renderQuotaExtrasHtml(ULTRA, 'claude-code', () => 'Resets in 6d 2h');
    expect(html).toContain('7-Day (Fable)');
    expect(html).toContain('width: 4%');
    expect(html).toContain('Fable may use up to 50% of the weekly limit');
    expect(html).toContain('No 5-hour limit on Ultra');
    expect(html).toContain('Extra usage: $0.00 of $200.00 used · off (out of credits)');
    // The headline weekly meter is already a gauge.
    expect(html.match(/quota-extra-row/g)).toHaveLength(1);
  });

  it('is empty for the classic two-window shape', () => {
    expect(
      renderQuotaExtrasHtml(
        {
          fiveHour: { utilization: 10, resetsAt: '2026-11-01T05:00:00Z' },
          sevenDay: { utilization: 20, resetsAt: '2026-11-07T06:00:00Z' },
        },
        'claude-code',
        () => '',
      ),
    ).toBe('');
  });

  it('escapes server-supplied labels', () => {
    const html = renderQuotaExtrasHtml(
      {
        ...ULTRA,
        extraUsage: undefined,
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            label: '<b>x</b>',
            utilization: 1,
            resetsAt: '',
          },
        ],
      },
      'claude-code',
      () => '',
    );
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('quotaSectionTooltip', () => {
  it('names the Claude plan when known', () => {
    expect(quotaSectionTooltip(ULTRA, 'claude-code')).toBe(
      'Claude Ultra subscription usage limits',
    );
    expect(quotaSectionTooltip({ ...ULTRA, planLabel: undefined }, 'claude-code')).toBe(
      'Claude subscription usage limits',
    );
    expect(quotaSectionTooltip(ULTRA, 'codex')).toBe('Codex CLI rate limits');
  });
});
