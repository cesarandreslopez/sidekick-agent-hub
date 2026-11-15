/**
 * The dashboard's "?" info tooltips (typed): reachable from the keyboard,
 * described to screen readers, and placed inside the viewport.
 *
 * The markup is `<span class="info-icon">?<div class="tooltip">…</div></span>`.
 * CSS alone showed the tooltip on hover only, centred on its icon, so at
 * sidebar widths it ran off the edge, and inside collapsed groups
 * (`overflow: hidden`) it was cut off. Placing it with `position: fixed`
 * escapes both.
 *
 * @module webview/dashboard/tooltips
 */

const MARGIN = 8;
const GAP = 6;
const MAX_WIDTH = 220;

export interface TooltipPlacement {
  left: number;
  top: number;
  width: number;
}

/**
 * Where a tooltip goes for an icon at `anchor` in a `viewportWidth` ×
 * `viewportHeight` window: below the icon (above when there is no room),
 * centred on it, and clamped to the viewport margins.
 */
export function placeTooltip(
  anchor: { left: number; top: number; width: number; bottom: number },
  tooltipHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): TooltipPlacement {
  const width = Math.max(120, Math.min(MAX_WIDTH, viewportWidth - MARGIN * 2));
  const centre = anchor.left + anchor.width / 2;
  const left = Math.min(Math.max(centre - width / 2, MARGIN), Math.max(MARGIN, viewportWidth - width - MARGIN));
  const below = anchor.bottom + GAP;
  const top =
    below + tooltipHeight > viewportHeight - MARGIN && anchor.top - GAP - tooltipHeight >= MARGIN
      ? anchor.top - GAP - tooltipHeight
      : below;
  return { left, top, width };
}

/** Make every info icon focusable and describe it with its tooltip. */
export function enhanceInfoTooltips(doc: Document): void {
  const view = doc.defaultView;
  const icons = Array.from(doc.querySelectorAll<HTMLElement>('.info-icon'));
  icons.forEach((icon, index) => {
    const tip = icon.querySelector<HTMLElement>('.tooltip');
    if (!tip) return;
    tip.id ||= `sk-info-tip-${index}`;
    tip.setAttribute('role', 'tooltip');
    icon.tabIndex = 0;
    icon.setAttribute('role', 'button');
    icon.setAttribute('aria-label', 'More information');
    icon.setAttribute('aria-describedby', tip.id);

    const show = (): void => {
      tip.classList.add('tooltip--placed');
      // Measure at the final width before placing.
      const width = Math.max(120, Math.min(MAX_WIDTH, (view?.innerWidth ?? MAX_WIDTH) - MARGIN * 2));
      tip.style.width = `${width}px`;
      const rect = icon.getBoundingClientRect();
      const placed = placeTooltip(
        rect,
        tip.offsetHeight || 0,
        view?.innerWidth ?? width + MARGIN * 2,
        view?.innerHeight ?? 10_000,
      );
      tip.style.left = `${placed.left}px`;
      tip.style.top = `${placed.top}px`;
      tip.style.width = `${placed.width}px`;
    };
    const hide = (): void => {
      tip.classList.remove('tooltip--placed');
    };
    icon.addEventListener('mouseenter', show);
    icon.addEventListener('focus', show);
    icon.addEventListener('mouseleave', () => {
      if (doc.activeElement !== icon) hide();
    });
    icon.addEventListener('blur', hide);
    icon.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hide();
        icon.blur();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (tip.classList.contains('tooltip--placed')) hide();
        else show();
      }
    });
  });
}
