import { describe, expect, it } from 'vitest';
import {
  detailTabIndexAt,
  sideListItemIndexAt,
  sideListItemViewportHeight,
  topTabIndexAt,
} from './mouseHitTesting';
import { layoutDetailTabs, layoutTopTabs } from './tabLayout';

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

  it('reads top tab columns from the layout the tab bar renders', () => {
    const tabs = [
      { shortcutKey: 1, title: 'Sessions' },
      { shortcutKey: 2, title: 'Tasks' },
      { shortcutKey: 3, title: 'Timeline' },
    ];
    // "▸1 Sessions" (0-10) " " " 2 Tasks" (12-19) " " " 3 Timeline" (21-31)
    const layout = layoutTopTabs(tabs, 0, 120);
    expect(topTabIndexAt(0, layout)).toBe(0);
    expect(topTabIndexAt(10, layout)).toBe(0);
    expect(topTabIndexAt(11, layout)).toBeNull();
    expect(topTabIndexAt(12, layout)).toBe(1);
    expect(topTabIndexAt(25, layout)).toBe(2);
    expect(topTabIndexAt(40, layout)).toBeNull();
  });

  it('offsets detail tab columns by the side list width', () => {
    const layout = layoutDetailTabs(['Summary', 'Timeline'], 0, 60);
    // " " then "▸ Summary" (1-9) " " "  Timeline" (11-20), shifted by the side list.
    expect(detailTabIndexAt(30, 30, layout)).toBeNull();
    expect(detailTabIndexAt(31, 30, layout)).toBe(0);
    expect(detailTabIndexAt(41, 30, layout)).toBe(1);
  });
});
