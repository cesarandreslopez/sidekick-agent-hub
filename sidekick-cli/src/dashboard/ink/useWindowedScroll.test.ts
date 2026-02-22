/**
 * Tests for windowed scroll logic.
 * Since we can't use React testing hooks without @testing-library/react,
 * we test the pure logic that the hook implements via a helper.
 */

import { describe, it, expect } from 'vitest';

// Replicate the core logic from useWindowedScroll for testing
interface ScrollState {
  selectedIndex: number;
  scrollOffset: number;
}

function ensureVisible(index: number, currentOffset: number, totalItems: number, viewportHeight: number): number {
  if (viewportHeight <= 0 || totalItems <= 0) return 0;
  let offset = currentOffset;
  if (index < offset) offset = index;
  if (index >= offset + viewportHeight) offset = index - viewportHeight + 1;
  const maxOffset = Math.max(0, totalItems - viewportHeight);
  return Math.max(0, Math.min(offset, maxOffset));
}

function selectNext(state: ScrollState, totalItems: number, viewportHeight: number): ScrollState {
  const next = Math.min(state.selectedIndex + 1, totalItems - 1);
  return { selectedIndex: next, scrollOffset: ensureVisible(next, state.scrollOffset, totalItems, viewportHeight) };
}

function selectPrev(state: ScrollState, totalItems: number, viewportHeight: number): ScrollState {
  const next = Math.max(state.selectedIndex - 1, 0);
  return { selectedIndex: next, scrollOffset: ensureVisible(next, state.scrollOffset, totalItems, viewportHeight) };
}

function selectFirst(): ScrollState {
  return { selectedIndex: 0, scrollOffset: 0 };
}

function selectLast(totalItems: number, viewportHeight: number): ScrollState {
  const last = Math.max(0, totalItems - 1);
  return { selectedIndex: last, scrollOffset: ensureVisible(last, 0, totalItems, viewportHeight) };
}

function setSelected(index: number, totalItems: number, viewportHeight: number): ScrollState {
  const clamped = Math.max(0, Math.min(index, totalItems - 1));
  return { selectedIndex: clamped, scrollOffset: ensureVisible(clamped, 0, totalItems, viewportHeight) };
}

describe('windowed scroll logic', () => {
  it('starts at index 0 offset 0', () => {
    const state: ScrollState = { selectedIndex: 0, scrollOffset: 0 };
    expect(state.selectedIndex).toBe(0);
    expect(state.scrollOffset).toBe(0);
  });

  it('selectNext increments index', () => {
    const state = selectNext({ selectedIndex: 0, scrollOffset: 0 }, 10, 5);
    expect(state.selectedIndex).toBe(1);
  });

  it('selectPrev decrements index', () => {
    let state: ScrollState = { selectedIndex: 0, scrollOffset: 0 };
    state = selectNext(state, 10, 5);
    state = selectNext(state, 10, 5);
    state = selectPrev(state, 10, 5);
    expect(state.selectedIndex).toBe(1);
  });

  it('selectPrev does not go below 0', () => {
    const state = selectPrev({ selectedIndex: 0, scrollOffset: 0 }, 10, 5);
    expect(state.selectedIndex).toBe(0);
  });

  it('selectNext does not exceed totalItems - 1', () => {
    let state: ScrollState = { selectedIndex: 0, scrollOffset: 0 };
    for (let i = 0; i < 5; i++) {
      state = selectNext(state, 3, 5);
    }
    expect(state.selectedIndex).toBe(2);
  });

  it('scrollOffset adjusts when selection moves below viewport', () => {
    let state: ScrollState = { selectedIndex: 0, scrollOffset: 0 };
    state = selectNext(state, 10, 3);
    state = selectNext(state, 10, 3);
    state = selectNext(state, 10, 3);
    expect(state.selectedIndex).toBe(3);
    expect(state.scrollOffset).toBe(1);
  });

  it('selectFirst goes to beginning', () => {
    const state = selectFirst();
    expect(state.selectedIndex).toBe(0);
    expect(state.scrollOffset).toBe(0);
  });

  it('selectLast goes to end', () => {
    const state = selectLast(10, 3);
    expect(state.selectedIndex).toBe(9);
    expect(state.scrollOffset).toBe(7);
  });

  it('setSelected jumps to specific index', () => {
    const state = setSelected(5, 10, 3);
    expect(state.selectedIndex).toBe(5);
  });

  it('setSelected clamps to bounds', () => {
    const state = setSelected(20, 10, 3);
    expect(state.selectedIndex).toBe(9);
  });

  it('handles empty list', () => {
    const state = ensureVisible(0, 0, 0, 5);
    expect(state).toBe(0);
  });

  it('scrollOffset adjusts when selection moves above viewport', () => {
    // Start scrolled down, then select something above
    const offset = ensureVisible(2, 5, 10, 3);
    expect(offset).toBe(2);
  });
});
