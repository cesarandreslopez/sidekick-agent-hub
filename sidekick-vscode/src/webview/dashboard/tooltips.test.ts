// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { enhanceInfoTooltips, placeTooltip } from './tooltips';

describe('placeTooltip', () => {
  it('centres under the icon and clamps to a narrow sidebar', () => {
    // A 240 px sidebar with the icon near the right edge.
    const placed = placeTooltip({ left: 220, top: 40, width: 14, bottom: 54 }, 80, 240, 600);
    expect(placed.width).toBe(220);
    expect(placed.left).toBeGreaterThanOrEqual(8);
    expect(placed.left + placed.width).toBeLessThanOrEqual(240 - 8);
    expect(placed.top).toBe(60);
  });

  it('flips above the icon when there is no room below', () => {
    const placed = placeTooltip({ left: 100, top: 560, width: 14, bottom: 574 }, 80, 400, 600);
    expect(placed.top).toBe(560 - 6 - 80);
  });

  it('narrows to the viewport when it is smaller than the tooltip', () => {
    expect(placeTooltip({ left: 10, top: 0, width: 14, bottom: 14 }, 40, 150, 600).width).toBe(134);
  });
});

describe('enhanceInfoTooltips', () => {
  it('makes info icons focusable and describes them by their tooltip', () => {
    document.body.innerHTML =
      '<span class="info-icon">?<div class="tooltip"><p>How long the model takes.</p></div></span>';
    enhanceInfoTooltips(document);
    const icon = document.querySelector<HTMLElement>('.info-icon')!;
    const tip = icon.querySelector<HTMLElement>('.tooltip')!;
    expect(icon.tabIndex).toBe(0);
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(icon.getAttribute('aria-describedby')).toBe(tip.id);

    icon.dispatchEvent(new FocusEvent('focus'));
    expect(tip.classList.contains('tooltip--placed')).toBe(true);
    icon.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tip.classList.contains('tooltip--placed')).toBe(false);
  });
});
