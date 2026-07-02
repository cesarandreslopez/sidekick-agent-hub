/**
 * Tests for the pure dashboard UI reducer.
 */

import { describe, it, expect } from 'vitest';
import { reducer, initialState, type DashboardUIState } from './dashboardReducer';

function state(overrides: Partial<DashboardUIState> = {}): DashboardUIState {
  return { ...initialState, ...overrides };
}

describe('SWITCH_PANEL', () => {
  it('resets selection, filter, focus, overlay, and scroll', () => {
    const before = state({
      selectedItemIndex: 4,
      detailTabIndex: 2,
      filterString: 'abc',
      filterMode: 'regex',
      filterError: 'bad',
      focusTarget: 'detail',
      overlay: 'help',
      detailScrollOffset: 12,
    });
    const after = reducer(before, { type: 'SWITCH_PANEL', index: 3 });
    expect(after).toMatchObject({
      activePanelIndex: 3,
      selectedItemIndex: 0,
      detailTabIndex: 0,
      filterString: '',
      filterMode: 'substring',
      filterError: null,
      focusTarget: 'side',
      overlay: null,
      detailScrollOffset: 0,
    });
  });
});

describe('filter validation', () => {
  it('SET_FILTER flags invalid regex in regex mode', () => {
    const after = reducer(state({ filterMode: 'regex' }), { type: 'SET_FILTER', value: '(' });
    expect(after.filterString).toBe('(');
    expect(after.filterError).not.toBeNull();
  });

  it('SET_FILTER accepts plain text in substring mode', () => {
    const after = reducer(state(), { type: 'SET_FILTER', value: '(' });
    expect(after.filterError).toBeNull();
  });

  it('CYCLE_FILTER_MODE walks substring → fuzzy → regex → date → substring', () => {
    let s = state();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = reducer(s, { type: 'CYCLE_FILTER_MODE' });
      seen.push(s.filterMode);
    }
    expect(seen).toEqual(['fuzzy', 'regex', 'date', 'substring']);
  });

  it('CYCLE_FILTER_MODE re-validates the current string for regex mode', () => {
    const s = state({ filterMode: 'fuzzy', filterString: '(' });
    const after = reducer(s, { type: 'CYCLE_FILTER_MODE' });
    expect(after.filterMode).toBe('regex');
    expect(after.filterError).not.toBeNull();
  });

  it('SET_FILTER flags unparseable date expressions in date mode', () => {
    const bad = reducer(state({ filterMode: 'date' }), { type: 'SET_FILTER', value: 'garbage' });
    expect(bad.filterError).not.toBeNull();
    const good = reducer(state({ filterMode: 'date' }), { type: 'SET_FILTER', value: '2d' });
    expect(good.filterError).toBeNull();
  });

  it('CYCLE_FILTER_MODE re-validates the current string when landing on date mode', () => {
    const s = state({ filterMode: 'regex', filterString: 'abc' });
    const after = reducer(s, { type: 'CYCLE_FILTER_MODE' });
    expect(after.filterMode).toBe('date');
    expect(after.filterError).not.toBeNull();
  });
});

describe('scrolling', () => {
  it('SCROLL_DETAIL_DELTA clamps to [0, total - viewport]', () => {
    const s = state({ detailScrollOffset: 28 });
    const down = reducer(s, {
      type: 'SCROLL_DETAIL_DELTA',
      delta: 10,
      totalLines: 40,
      viewportHeight: 10,
    });
    expect(down.detailScrollOffset).toBe(30);
    const up = reducer(state({ detailScrollOffset: 1 }), {
      type: 'SCROLL_DETAIL_DELTA',
      delta: -5,
      totalLines: 40,
      viewportHeight: 10,
    });
    expect(up.detailScrollOffset).toBe(0);
  });

  it('OVERLAY_SCROLL clamps at zero and accumulates', () => {
    let s = state();
    s = reducer(s, { type: 'OVERLAY_SCROLL', delta: -3 });
    expect(s.overlayScrollOffset).toBe(0);
    s = reducer(s, { type: 'OVERLAY_SCROLL', delta: 5 });
    expect(s.overlayScrollOffset).toBe(5);
  });

  it('SET_OVERLAY resets changelog scroll and context menu index', () => {
    const s = state({ overlayScrollOffset: 7, contextMenuIndex: 3 });
    const after = reducer(s, { type: 'SET_OVERLAY', overlay: 'changelog' });
    expect(after.overlayScrollOffset).toBe(0);
    expect(after.contextMenuIndex).toBe(0);
  });

  it('SCROLL_SIDE clamps within item bounds and resets detail state', () => {
    const s = state({ selectedItemIndex: 1, detailTabIndex: 2, detailScrollOffset: 9 });
    const after = reducer(s, { type: 'SCROLL_SIDE', delta: 10, itemCount: 5 });
    expect(after.selectedItemIndex).toBe(4);
    expect(after.detailTabIndex).toBe(0);
    expect(after.detailScrollOffset).toBe(0);
  });
});

describe('misc transitions', () => {
  it('FIRST_EVENT with a prefix installs the active-session filter', () => {
    const after = reducer(state({ hasReceivedEvents: false }), {
      type: 'FIRST_EVENT',
      sessionPrefix: '2026-07-',
    });
    expect(after.hasReceivedEvents).toBe(true);
    expect(after.sessionFilter).toEqual({
      sessionPrefix: '2026-07-',
      label: '● active session',
    });
  });

  it('FIRST_EVENT without a prefix clears the session filter', () => {
    const after = reducer(
      state({ hasReceivedEvents: false, sessionFilter: { label: 'x', date: '2026-01-01' } }),
      { type: 'FIRST_EVENT', sessionPrefix: '' },
    );
    expect(after.sessionFilter).toBeNull();
  });

  it('CONTEXT_MENU_NAV wraps around', () => {
    const s = state({ contextMenuIndex: 2 });
    const after = reducer(s, { type: 'CONTEXT_MENU_NAV', delta: 1, itemCount: 3 });
    expect(after.contextMenuIndex).toBe(0);
  });

  it('CYCLE_DETAIL_TAB is a no-op with a single tab', () => {
    const s = state({ detailTabIndex: 0 });
    expect(reducer(s, { type: 'CYCLE_DETAIL_TAB', direction: 1, tabCount: 1 })).toBe(s);
  });

  it('CYCLE_LAYOUT forces detail focus in expanded mode', () => {
    const after = reducer(state({ layoutMode: 'normal', focusTarget: 'side' }), {
      type: 'CYCLE_LAYOUT',
    });
    expect(after.layoutMode).toBe('expanded');
    expect(after.focusTarget).toBe('detail');
  });

  it('TOGGLE_MOUSE flips mouse capture', () => {
    const off = reducer(state(), { type: 'TOGGLE_MOUSE' });
    expect(off.mouseEnabled).toBe(false);
    expect(reducer(off, { type: 'TOGGLE_MOUSE' }).mouseEnabled).toBe(true);
  });

  it('toasts add and remove by id', () => {
    const toast = { id: 1, message: 'hi', severity: 'info' as const, expiresAt: 99 };
    let s = reducer(state(), { type: 'ADD_TOAST', toast });
    expect(s.toasts).toHaveLength(1);
    s = reducer(s, { type: 'REMOVE_TOAST', id: 1 });
    expect(s.toasts).toHaveLength(0);
  });
});
