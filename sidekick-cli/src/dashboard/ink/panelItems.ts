import type { PanelItem } from '../panels/types';

export function getPanelItemsOnce(
  getItems: () => PanelItem[],
  transform: (items: PanelItem[]) => PanelItem[],
): { allItems: PanelItem[]; currentItems: PanelItem[] } {
  const allItems = getItems();
  return { allItems, currentItems: transform([...allItems]) };
}
