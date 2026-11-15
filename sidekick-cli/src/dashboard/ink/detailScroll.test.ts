import { describe, expect, it } from 'vitest';
import { clampDetailScroll, maxDetailScroll, shouldAutoScrollDetail } from './detailScroll';

describe('detail scrolling', () => {
  it('clamps an offset that outlived the content it was measured against', () => {
    // CLAMP_SELECTION keeps the offset when the list shrinks under the cursor,
    // so a 30-line-deep offset can land on a 15-line item.
    expect(clampDetailScroll(30, 15)).toBe(14);
    expect(clampDetailScroll(30, 0)).toBe(0);
    expect(clampDetailScroll(5, 40)).toBe(5);
    expect(clampDetailScroll(-3, 40)).toBe(0);
  });

  it('clamps to the real bottom when the viewport is known', () => {
    // 30 rows in a 15-row pane: the last full page starts at 30 - (15 - 2).
    expect(clampDetailScroll(30, 30, 15)).toBe(17);
    expect(clampDetailScroll(30, 15, 15)).toBe(2);
    expect(clampDetailScroll(30, 10, 15)).toBe(0);
    expect(clampDetailScroll(4, 30, 15)).toBe(4);
  });

  it('reserves both indicator rows when clamping to the tail', () => {
    expect(maxDetailScroll(40, 10)).toBe(32);
    expect(maxDetailScroll(5, 10)).toBe(0);
  });

  it('auto-scrolls when content identity changes even if the new tab is shorter', () => {
    expect(shouldAutoScrollDetail('session:timeline', 'session:summary', 200, 400)).toBe(true);
    expect(shouldAutoScrollDetail('session:timeline', 'session:timeline', 200, 200)).toBe(false);
  });

  it('follows new rows only when the reader was at the bottom', () => {
    expect(shouldAutoScrollDetail('t', 't', 31, 30, true)).toBe(true);
    expect(shouldAutoScrollDetail('t', 't', 31, 30, false)).toBe(false);
    // A new tab or item still jumps to the bottom.
    expect(shouldAutoScrollDetail('t2', 't', 31, 30, false)).toBe(true);
  });
});
