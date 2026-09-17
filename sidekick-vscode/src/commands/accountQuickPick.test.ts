import { describe, expect, it } from 'vitest';
import type { AccountView, SwitchAccountResult } from 'sidekick-shared';
import {
  buildAccountQuickPickItems,
  buildSwitchSummary,
  describeHealth,
  formatRelative,
  healthIcon,
} from './accountQuickPick';

const DAY = 24 * 60 * 60 * 1000;
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

describe('accountQuickPick', () => {
  it('describes health and picks icons by state', () => {
    expect(describeHealth(view({ id: 'a' }).health, NOW)).toBe('fresh · expires in 6d');
    expect(healthIcon(view({ id: 'a', isActive: true }))).toBe('$(pass-filled)');
    expect(healthIcon(view({ id: 'a' }))).toBe('$(account)');
    expect(
      healthIcon(
        view({
          id: 'a',
          health: {
            providerId: 'claude-code',
            accountId: 'a',
            state: 'expired',
            checkedAt: NOW,
            isLive: false,
          },
        }),
      ),
    ).toBe('$(error)');
    expect(formatRelative(NOW - 3 * DAY, NOW)).toBe('3d ago');
  });

  it('groups items by provider with separators, marks the current account, and gates undo', () => {
    const views = [
      view({ id: 'work', isActive: true, planType: 'max' }),
      view({
        id: 'c',
        providerId: 'codex',
        label: 'Client',
        email: 'c@corp.com',
        health: {
          providerId: 'codex',
          accountId: 'c',
          state: 'expired',
          checkedAt: NOW,
          isLive: false,
        },
      }),
    ];
    const items = buildAccountQuickPickItems(views, { canUndo: false, now: NOW });
    expect(items.map((item) => item.label)).toEqual([
      'Claude Code',
      '$(pass-filled) work',
      'Codex',
      '$(error) Client',
      'Actions',
      '$(add) Add account…',
      '$(terminal) Open terminal as account…',
      '$(sign-in) Sign in again…',
      '$(list-tree) Open Accounts view',
    ]);
    expect(items[0].kind).toBe(-1);
    expect(items[1].description).toBe('work@example.com · max · (current)');
    expect(items[3].detail).toBe('Expired — select to sign in again');
    expect(
      buildAccountQuickPickItems(views, { canUndo: true, now: NOW }).map((i) => i.label),
    ).toContain('$(discard) Undo last switch');
    expect(buildAccountQuickPickItems([], { canUndo: false }).map((i) => i.label)).toEqual([
      'Actions',
      '$(add) Add account…',
      '$(list-tree) Open Accounts view',
    ]);
  });

  it('builds one summary with warnings folded in and actions gated on state', () => {
    const base: SwitchAccountResult = {
      success: true,
      provider: 'claude-code',
      accountId: 'work',
      previousAccountId: 'home',
      verified: true,
      verification: 'store',
      warnings: [],
      hints: ['New claude sessions use work@example.com.'],
      runningConsumers: [],
      undoToken: 'tok',
      email: 'work@example.com',
    };
    const clean = buildSwitchSummary(base, 'Work');
    expect(clean).toMatchObject({
      message: 'Switched to Work (work@example.com) ✓',
      severity: 'info',
      actions: ['Undo', 'Details'],
    });

    const warned = buildSwitchSummary(
      {
        ...base,
        warnings: ['Claude Desktop is not switched by sidekick.', 'x'],
        runningConsumers: [
          { kind: 'claude-desktop', pids: [4], switched: false, reachability: 'r' },
        ],
      },
      'Work',
      { extensionHostRunning: true },
    );
    expect(warned.message).toBe(
      'Switched to Work (work@example.com) ✓ — 2 warnings: Claude Desktop is not switched by sidekick.',
    );
    expect(warned.severity).toBe('warning');
    expect(warned.actions).toEqual(['Undo', 'Details', 'Reload Window']);
    expect(warned.details).toContain('running: claude-desktop pid 4');

    expect(buildSwitchSummary({ ...base, alreadyActive: true }, 'Work').message).toBe(
      'Work (work@example.com) is already the active Claude Code account.',
    );
    const failed = buildSwitchSummary(
      { ...base, success: false, needsLogin: true, error: 'expired', verified: false },
      'Work',
    );
    expect(failed).toMatchObject({
      message: 'expired',
      severity: 'error',
      actions: ['Sign In Again', 'Details'],
    });
    expect(
      buildSwitchSummary({ ...base, verified: false, undoToken: undefined, hints: [] }, 'Work'),
    ).toMatchObject({ message: 'Switched to Work (work@example.com) (not verified)', actions: [] });
  });
});
