export interface TabHitTarget {
  shortcutKey: string | number;
  title: string;
}

export function sideListItemViewportHeight(contentHeight: number, itemCount: number): number {
  const safeHeight = Math.max(1, contentHeight);
  return Math.max(1, safeHeight - (itemCount > safeHeight ? 2 : 0));
}

export function topTabIndexAt(x: number, tabs: TabHitTarget[]): number | null {
  let column = 0;
  for (let index = 0; index < tabs.length; index++) {
    const width = String(tabs[index].shortcutKey).length + tabs[index].title.length + 2;
    if (x >= column && x < column + width) return index;
    column += width;
  }
  return null;
}

export function detailTabIndexAt(
  x: number,
  sideWidth: number,
  labels: string[],
  activeIndex: number,
): number | null {
  let column = sideWidth + 1;
  for (let index = 0; index < labels.length; index++) {
    const width = labels[index].length + (index === activeIndex ? 3 : 2);
    if (x >= column && x < column + width) return index;
    column += width;
  }
  return null;
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
