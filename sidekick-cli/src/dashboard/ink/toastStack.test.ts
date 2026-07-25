import { describe, expect, it } from 'vitest';
import { MAX_VISIBLE_TOASTS, visibleToasts } from './toastStack';

const toasts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

describe('visibleToasts', () => {
  it('returns nothing for an empty stack', () => {
    expect(visibleToasts([])).toEqual([]);
  });

  it('returns every toast when under the cap', () => {
    expect(visibleToasts(toasts(2))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('keeps the newest toasts when over the cap', () => {
    // The dashboard previously rendered only toasts[length - 1], so a burst
    // showed one message and silently dropped the rest.
    expect(visibleToasts(toasts(5))).toEqual([{ id: 3 }, { id: 4 }, { id: 5 }]);
  });

  it('preserves oldest-first order so stacking matches render order', () => {
    const visible = visibleToasts(toasts(5));
    expect(visible.map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it('honors an explicit cap', () => {
    expect(visibleToasts(toasts(5), 1)).toEqual([{ id: 5 }]);
    expect(visibleToasts(toasts(5), 0)).toEqual([]);
  });

  it('defaults to three visible toasts', () => {
    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(visibleToasts(toasts(10))).toHaveLength(3);
  });
});
