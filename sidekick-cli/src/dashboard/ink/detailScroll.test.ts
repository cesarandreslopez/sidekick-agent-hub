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

  it('reserves both indicator rows when clamping to the tail', () => {
    expect(maxDetailScroll(40, 10)).toBe(32);
    expect(maxDetailScroll(5, 10)).toBe(0);
  });

  it('auto-scrolls when content identity changes even if the new tab is shorter', () => {
    expect(shouldAutoScrollDetail('session:timeline', 'session:summary', 200, 400)).toBe(true);
    expect(shouldAutoScrollDetail('session:timeline', 'session:timeline', 200, 200)).toBe(false);
  });
});
