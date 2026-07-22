import { describe, expect, it } from 'vitest';
import type { SessionPickerItem } from '../SessionPickerHelpers';
import { buildGroupedRows, resolvePickerSelection } from './SessionPickerInk';

function item(sessionPath: string, providerId: SessionPickerItem['providerId']): SessionPickerItem {
  return {
    sessionPath,
    providerId,
    label: sessionPath,
    age: 'now',
    sessionId: sessionPath,
    isActive: true,
  };
}

describe('grouped session picker selection', () => {
  it('resolves Enter through grouped row order', () => {
    const items = [
      item('claude-a', 'claude-code'),
      item('codex-x', 'codex'),
      item('claude-b', 'claude-code'),
    ];
    const grouped = buildGroupedRows(items);
    expect(resolvePickerSelection(items, grouped, 1)).toBe('claude-b');
    expect(resolvePickerSelection(items, grouped, 2)).toBe('codex-x');
    expect(resolvePickerSelection(items, grouped, 3)).toBeNull();
  });
});
