import { describe, expect, it } from 'vitest';
import type { AccountView } from 'sidekick-shared';
import { buildAccountRows, initialSelection, selectableAccounts } from './AccountsPickerInk';

function view(id: string, providerId: 'claude-code' | 'codex', isActive = false): AccountView {
  return {
    id,
    providerId,
    label: id,
    isActive,
    source: 'registered',
    addedAt: '2026-01-01T00:00:00Z',
    health: { providerId, accountId: id, state: 'fresh', checkedAt: 0, isLive: false },
  };
}

describe('AccountsPickerInk helpers', () => {
  it('groups rows by provider with headers and keeps selectable order', () => {
    const views = [view('c1', 'codex'), view('a1', 'claude-code'), view('a2', 'claude-code', true)];
    const rows = buildAccountRows(views);
    expect(rows.map((row) => (row.type === 'header' ? `#${row.providerId}` : row.view.id))).toEqual(
      ['#claude-code', 'a1', 'a2', '#codex', 'c1'],
    );
    expect(selectableAccounts(rows).map((v) => v.id)).toEqual(['a1', 'a2', 'c1']);
    expect(initialSelection(views)).toBe(1);
    expect(initialSelection([view('x', 'codex')])).toBe(0);
    expect(buildAccountRows([])).toEqual([]);
  });
});
