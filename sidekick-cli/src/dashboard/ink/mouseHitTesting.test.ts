import { describe, expect, it } from 'vitest';
import {
  detailTabIndexAt,
  sideListItemIndexAt,
  sideListItemViewportHeight,
  topTabIndexAt,
} from './mouseHitTesting';

describe('dashboard mouse hit testing', () => {
  it('maps the first visible item after the title to its own index', () => {
    expect(sideListItemIndexAt(2, 0, 5)).toBeNull();
    expect(sideListItemIndexAt(3, 0, 5)).toBe(0);
    expect(sideListItemIndexAt(4, 2, 8)).toBe(2);
  });

  it('reserves two rows for side-list scroll indicators', () => {
    expect(sideListItemViewportHeight(10, 20)).toBe(8);
    expect(sideListItemViewportHeight(10, 8)).toBe(10);
  });

  it('uses the same compact widths as the top tab renderer', () => {
    const tabs = [
      { shortcutKey: 1, title: 'Sessions' },
      { shortcutKey: 2, title: 'Tasks' },
      { shortcutKey: 3, title: 'Timeline' },
    ];
    expect(topTabIndexAt(11, tabs)).toBe(1);
    expect(topTabIndexAt(19, tabs)).toBe(2);
  });

  it('accounts for the detail leading space and active marker', () => {
    expect(detailTabIndexAt(31, 30, ['Summary', 'Timeline'], 0)).toBe(0);
    expect(detailTabIndexAt(41, 30, ['Summary', 'Timeline'], 0)).toBe(1);
  });
});
