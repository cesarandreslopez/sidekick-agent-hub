import { describe, expect, it, vi } from 'vitest';
import { getPanelItemsOnce } from './panelItems';

describe('getPanelItemsOnce', () => {
  it('builds the panel list once while retaining filtered and total counts', () => {
    const getItems = vi.fn(() => [
      { id: 'a', label: 'a', sortKey: 0 },
      { id: 'b', label: 'b', sortKey: 1 },
    ]);
    const result = getPanelItemsOnce(getItems, (items) => items.slice(0, 1));
    expect(getItems).toHaveBeenCalledOnce();
    expect(result.currentItems).toHaveLength(1);
    expect(result.allItems).toHaveLength(2);
  });
});
