/**
 * Hook for windowed list/content scrolling.
 * Manages a scroll offset and selected index within a virtual viewport.
 */

import { useState, useCallback, useEffect } from 'react';

interface UseWindowedScrollOptions {
  totalItems: number;
  viewportHeight: number;
}

interface UseWindowedScrollResult {
  scrollOffset: number;
  selectedIndex: number;
  selectNext: () => void;
  selectPrev: () => void;
  selectFirst: () => void;
  selectLast: () => void;
  scrollDown: () => void;
  scrollUp: () => void;
  scrollPageDown: () => void;
  scrollPageUp: () => void;
  setSelected: (index: number) => void;
}

export function useWindowedScroll({
  totalItems,
  viewportHeight,
}: UseWindowedScrollOptions): UseWindowedScrollResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Clamp selection when totalItems changes
  useEffect(() => {
    if (totalItems === 0) {
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
    setSelectedIndex(prev => Math.min(prev, totalItems - 1));
  }, [totalItems]);

  const ensureVisible = useCallback((index: number, currentOffset: number): number => {
    if (viewportHeight <= 0 || totalItems <= 0) return 0;
    let offset = currentOffset;
    // If selected is above viewport, scroll up
    if (index < offset) {
      offset = index;
    }
    // If selected is below viewport, scroll down
    if (index >= offset + viewportHeight) {
      offset = index - viewportHeight + 1;
    }
    // Clamp offset
    const maxOffset = Math.max(0, totalItems - viewportHeight);
    return Math.max(0, Math.min(offset, maxOffset));
  }, [totalItems, viewportHeight]);

  const selectNext = useCallback(() => {
    setSelectedIndex(prev => {
      const next = Math.min(prev + 1, totalItems - 1);
      setScrollOffset(cur => ensureVisible(next, cur));
      return next;
    });
  }, [totalItems, ensureVisible]);

  const selectPrev = useCallback(() => {
    setSelectedIndex(prev => {
      const next = Math.max(prev - 1, 0);
      setScrollOffset(cur => ensureVisible(next, cur));
      return next;
    });
  }, [ensureVisible]);

  const selectFirst = useCallback(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
  }, []);

  const selectLast = useCallback(() => {
    const last = Math.max(0, totalItems - 1);
    setSelectedIndex(last);
    setScrollOffset(cur => ensureVisible(last, cur));
  }, [totalItems, ensureVisible]);

  const scrollDown = useCallback(() => {
    setScrollOffset(prev => {
      const maxOffset = Math.max(0, totalItems - viewportHeight);
      return Math.min(prev + 1, maxOffset);
    });
  }, [totalItems, viewportHeight]);

  const scrollUp = useCallback(() => {
    setScrollOffset(prev => Math.max(prev - 1, 0));
  }, []);

  const scrollPageDown = useCallback(() => {
    setScrollOffset(prev => {
      const maxOffset = Math.max(0, totalItems - viewportHeight);
      return Math.min(prev + viewportHeight, maxOffset);
    });
    setSelectedIndex(prev => Math.min(prev + viewportHeight, totalItems - 1));
  }, [totalItems, viewportHeight]);

  const scrollPageUp = useCallback(() => {
    setScrollOffset(prev => Math.max(prev - viewportHeight, 0));
    setSelectedIndex(prev => Math.max(prev - viewportHeight, 0));
  }, [viewportHeight]);

  const setSelected = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, totalItems - 1));
    setSelectedIndex(clamped);
    setScrollOffset(cur => ensureVisible(clamped, cur));
  }, [totalItems, ensureVisible]);

  return {
    scrollOffset,
    selectedIndex,
    selectNext,
    selectPrev,
    selectFirst,
    selectLast,
    scrollDown,
    scrollUp,
    scrollPageDown,
    scrollPageUp,
    setSelected,
  };
}
