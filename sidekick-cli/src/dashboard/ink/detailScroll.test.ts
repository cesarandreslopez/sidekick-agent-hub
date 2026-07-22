import { describe, expect, it } from 'vitest';
import { maxDetailScroll, shouldAutoScrollDetail } from './detailScroll';

describe('detail scrolling', () => {
  it('reserves both indicator rows when clamping to the tail', () => {
    expect(maxDetailScroll(40, 10)).toBe(32);
    expect(maxDetailScroll(5, 10)).toBe(0);
  });

  it('auto-scrolls when content identity changes even if the new tab is shorter', () => {
    expect(shouldAutoScrollDetail('session:timeline', 'session:summary', 200, 400)).toBe(true);
    expect(shouldAutoScrollDetail('session:timeline', 'session:timeline', 200, 200)).toBe(false);
  });
});
