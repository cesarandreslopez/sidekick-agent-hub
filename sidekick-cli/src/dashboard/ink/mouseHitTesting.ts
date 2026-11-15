import {
  detailTabIndexAtColumn,
  topTabIndexAtColumn,
  type DetailTabLayout,
  type TopTabLayout,
} from './tabLayout';

export function sideListItemViewportHeight(contentHeight: number, itemCount: number): number {
  const safeHeight = Math.max(1, contentHeight);
  return Math.max(1, safeHeight - (itemCount > safeHeight ? 2 : 0));
}

/** Top tab under column `x`, read from the same layout the tab bar renders. */
export function topTabIndexAt(x: number, layout: TopTabLayout): number | null {
  return topTabIndexAtColumn(x, layout);
}

/**
 * Detail tab under screen column `x`. The detail tab bar starts where the
 * side list ends; its spans are relative to that origin.
 */
export function detailTabIndexAt(
  x: number,
  sideWidth: number,
  layout: DetailTabLayout,
): number | null {
  return detailTabIndexAtColumn(x - sideWidth, layout);
}

export function sideListItemIndexAt(
  y: number,
  scrollOffset: number,
  itemCount: number,
): number | null {
  // Tab bar, border, and panel title occupy rows 0, 1, and 2.
  const itemRow = y - 3 - (scrollOffset > 0 ? 1 : 0);
  if (itemRow < 0) return null;
  const index = scrollOffset + itemRow;
  return index < itemCount ? index : null;
}
