import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import type { AccountView, SwitchAccountResult } from 'sidekick-shared';
import {
  allLearned,
  columnWidths,
  formatAccountList,
  formatHealth,
  formatRelative,
  renderSwitchSummary,
  summarizeSwitch,
} from './format';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-16T12:00:00Z');

function view(overrides: Partial<AccountView> & { id: string }): AccountView {
  return {
    providerId: 'claude-code',
    label: overrides.id,
    email: `${overrides.id}@example.com`,
    isActive: false,
    source: 'registered',
    addedAt: '2026-01-01T00:00:00Z',
    health: {
      providerId: 'claude-code',
      accountId: overrides.id,
      state: 'fresh',
      checkedAt: NOW,
      isLive: false,
      refreshExpiresAt: NOW + 6 * DAY,
    },
    ...overrides,
  };
}

describe('format', () => {
  it('formats relative times in days, hours, and minutes', () => {
    expect(formatRelative(NOW + 6 * DAY, NOW)).toBe('in 6d');
    expect(formatRelative(NOW + 3 * HOUR, NOW)).toBe('in 3h');
    expect(formatRelative(NOW + 12 * 60 * 1000, NOW)).toBe('in 12m');
    expect(formatRelative(NOW - 2 * DAY, NOW)).toBe('2d ago');
    expect(formatRelative(NOW + 10, NOW)).toBe('now');
  });

  it('maps health states to badges with expiry detail', () => {
    expect(formatHealth(view({ id: 'a' }).health, NOW)).toMatchObject({
      state: 'fresh',
      color: 'green',
      detail: 'expires in 6d',
    });
    expect(
      formatHealth(
        {
          providerId: 'claude-code',
          accountId: 'b',
          state: 'expiring',
          checkedAt: NOW,
          isLive: false,
          refreshExpiresAt: NOW + 2 * DAY,
        },
        NOW,
      ),
    ).toMatchObject({ state: 'expiring', color: 'yellow', detail: 'refresh ok · expires in 2d' });
    expect(
      formatHealth(
        { providerId: 'codex', accountId: 'c', state: 'expired', checkedAt: NOW, isLive: false },
        NOW,
      ),
    ).toMatchObject({ state: 'expired', color: 'red', detail: 'sign in again' });
    expect(
      formatHealth(
        {
          providerId: 'codex',
          accountId: 'd',
          state: 'unknown',
          checkedAt: NOW,
          isLive: false,
          reason: 'API-key login',
        },
        NOW,
      ),
    ).toMatchObject({ state: 'unknown', color: 'gray', detail: 'API-key login' });
    expect(
      formatHealth(
        { providerId: 'codex', accountId: 'e', state: 'missing', checkedAt: NOW, isLive: false },
        NOW,
      ).color,
    ).toBe('red');
  });

  it('prints a grouped list with the active marker and bounded columns', () => {
    const level = chalk.level;
    chalk.level = 0;
    try {
      const views = [
        view({ id: 'work', isActive: true, label: 'Work', planType: 'max' }),
        view({
          id: 'averyveryveryverylonglabelthatgoesonandon',
          label: 'averyveryveryverylabel-that-goes-on-and-on-forever',
        }),
        view({
          id: 'c',
          providerId: 'codex',
          label: 'Codex',
          email: 'c@example.com',
          health: {
            providerId: 'codex',
            accountId: 'c',
            state: 'expired',
            checkedAt: NOW,
            isLive: false,
          },
        }),
      ];
      const widths = columnWidths(views, NOW);
      expect(widths.name).toBe(28);
      const text = formatAccountList(views, NOW);
      const lines = text.split('\n');
      expect(lines[0]).toBe('Claude Code');
      expect(lines[1]).toMatch(/^  \* Work +work@example\.com +max +● fresh +expires in 6d$/);
      expect(lines[2]).toContain('…');
      expect(lines[4]).toBe('Codex');
      expect(lines[5]).toMatch(/● expired +sign in again/);
      expect(formatAccountList([], NOW)).toBe('');
    } finally {
      chalk.level = level;
    }
  });

  it('detects when every account was learned automatically', () => {
    expect(allLearned([])).toBe(false);
    expect(allLearned([view({ id: 'a', source: 'learned' })])).toBe(true);
    expect(allLearned([view({ id: 'a', source: 'learned' }), view({ id: 'b' })])).toBe(false);
  });

  it('summarises switch results including consumer warnings, undo, and needsLogin', () => {
    const base: SwitchAccountResult = {
      success: true,
      provider: 'claude-code',
      accountId: 'work',
      previousAccountId: 'home',
      verified: true,
      verification: 'store',
      warnings: ['Running claude sessions keep the previous account until restarted.'],
      hints: ['New claude sessions use work@example.com.'],
      runningConsumers: [],
      undoToken: 't',
      email: 'work@example.com',
    };
    const ok = summarizeSwitch(base, 'Work');
    expect(ok.headline).toBe('Switched Claude Code → Work (work@example.com)  ✓ verified');
    expect(ok.hints).toEqual([
      'New claude sessions use work@example.com.',
      'Undo: sidekick accounts undo',
    ]);
    const rendered = renderSwitchSummary(ok);
    expect(rendered.stderr).toHaveLength(1);
    expect(rendered.stdout).toHaveLength(3);

    expect(
      summarizeSwitch(
        { ...base, verified: false, verification: 'none', undoToken: undefined },
        'Work',
      ).headline,
    ).toMatch(/not verified/);
    expect(summarizeSwitch({ ...base, alreadyActive: true }, 'Work').headline).toBe(
      'Work (work@example.com) is already the active Claude Code account.',
    );

    const failed = summarizeSwitch(
      { ...base, success: false, needsLogin: true, error: 'expired' },
      'Work',
    );
    expect(failed.ok).toBe(false);
    expect(failed.hints[0]).toBe('Sign in again: sidekick accounts login "Work"');
    expect(renderSwitchSummary(failed).stderr[0]).toContain('expired');
  });
});
