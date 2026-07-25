/**
 * Pure UI state reducer for the Ink dashboard.
 * Extracted from Dashboard.tsx so state transitions are unit-testable
 * without a renderer.
 */

import { parseDateExpression } from '../dateFilterExpression';
import { maxDetailScroll } from './detailScroll';

export type LayoutMode = 'normal' | 'expanded' | 'wide-side';
export type OverlayKind = null | 'help' | 'context-menu' | 'filter' | 'changelog';
export type FocusTarget = 'side' | 'detail';

export interface SessionFilter {
  sessionPrefix?: string;
  date?: string;
  label: string;
}

export interface ToastEntry {
  id: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  expiresAt: number;
}

export interface DashboardUIState {
  activePanelIndex: number;
  selectedItemIndex: number;
  detailTabIndex: number;
  layoutMode: LayoutMode;
  focusTarget: FocusTarget;
  overlay: OverlayKind;
  filterString: string;
  filterMode: 'substring' | 'fuzzy' | 'regex' | 'date';
  filterError: string | null;
  sessionFilter: SessionFilter | null;
  detailScrollOffset: number;
  toasts: ToastEntry[];
  hasReceivedEvents: boolean;
  contextMenuIndex: number;
  overlayScrollOffset: number;
  renderTick: number;
  mouseEnabled: boolean;
}

export type Action =
  | { type: 'SWITCH_PANEL'; index: number }
  | { type: 'SELECT_ITEM'; index: number }
  /**
   * Move the selection without touching the detail tab or scroll offset.
   * Used when the list shrinks under the cursor — live event churn, or typing
   * into the filter — where SELECT_ITEM would yank the user back to the top of
   * the first tab.
   */
  | { type: 'CLAMP_SELECTION'; index: number }
  | { type: 'SET_DETAIL_TAB'; index: number }
  | { type: 'CYCLE_DETAIL_TAB'; direction: 1 | -1; tabCount: number }
  | { type: 'CYCLE_LAYOUT' }
  | { type: 'TOGGLE_FOCUS' }
  | { type: 'SET_FOCUS'; target: FocusTarget }
  | { type: 'SET_OVERLAY'; overlay: OverlayKind }
  | { type: 'SET_FILTER'; value: string }
  | { type: 'CYCLE_FILTER_MODE' }
  | { type: 'SET_FILTER_ERROR'; error: string | null }
  | { type: 'SET_SESSION_FILTER'; filter: SessionFilter | null }
  | { type: 'SCROLL_DETAIL'; offset: number }
  | { type: 'SCROLL_DETAIL_DELTA'; delta: number; totalLines: number; viewportHeight: number }
  | { type: 'ADD_TOAST'; toast: ToastEntry }
  | { type: 'REMOVE_TOAST'; id: number }
  | { type: 'FIRST_EVENT'; sessionPrefix: string }
  | { type: 'CONTEXT_MENU_NAV'; delta: number; itemCount: number }
  | { type: 'CONTEXT_MENU_SELECT' }
  | { type: 'SCROLL_SIDE'; delta: number; itemCount: number }
  | { type: 'OVERLAY_SCROLL'; delta: number }
  | { type: 'CLAMP_OVERLAY_SCROLL'; maxOffset: number }
  | { type: 'TOGGLE_MOUSE' }
  | { type: 'TICK' };

/** Validate a filter string for the given mode; null when valid. */
function validateFilter(mode: DashboardUIState['filterMode'], value: string): string | null {
  if (!value) return null;
  if (mode === 'regex') {
    try {
      new RegExp(value);
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid regex';
    }
    return null;
  }
  if (mode === 'date') {
    const result = parseDateExpression(value);
    return 'error' in result ? result.error : null;
  }
  return null;
}

export function reducer(state: DashboardUIState, action: Action): DashboardUIState {
  switch (action.type) {
    case 'SWITCH_PANEL':
      return {
        ...state,
        activePanelIndex: action.index,
        selectedItemIndex: 0,
        detailTabIndex: 0,
        filterString: '',
        filterMode: 'substring',
        filterError: null,
        focusTarget: 'side',
        overlay: null,
        detailScrollOffset: 0,
      };

    case 'SELECT_ITEM':
      return {
        ...state,
        selectedItemIndex: action.index,
        detailTabIndex: 0,
        detailScrollOffset: 0,
      };

    case 'CLAMP_SELECTION':
      return { ...state, selectedItemIndex: action.index };

    case 'SET_DETAIL_TAB':
      return { ...state, detailTabIndex: action.index, detailScrollOffset: 0 };

    case 'CYCLE_DETAIL_TAB': {
      if (action.tabCount <= 1) return state;
      const next = (state.detailTabIndex + action.direction + action.tabCount) % action.tabCount;
      return { ...state, detailTabIndex: next, detailScrollOffset: 0 };
    }

    case 'CYCLE_LAYOUT': {
      const modes: LayoutMode[] = ['normal', 'expanded', 'wide-side'];
      const idx = modes.indexOf(state.layoutMode);
      const next = modes[(idx + 1) % modes.length];
      return {
        ...state,
        layoutMode: next,
        focusTarget: next === 'expanded' ? 'detail' : state.focusTarget,
      };
    }

    case 'TOGGLE_FOCUS':
      return {
        ...state,
        focusTarget: state.focusTarget === 'side' ? 'detail' : 'side',
      };

    case 'SET_FOCUS':
      return { ...state, focusTarget: action.target };

    case 'SET_OVERLAY':
      return { ...state, overlay: action.overlay, contextMenuIndex: 0, overlayScrollOffset: 0 };

    case 'SET_FILTER':
      return {
        ...state,
        filterString: action.value,
        filterError: validateFilter(state.filterMode, action.value),
      };

    case 'CYCLE_FILTER_MODE': {
      const modes: Array<'substring' | 'fuzzy' | 'regex' | 'date'> = [
        'substring',
        'fuzzy',
        'regex',
        'date',
      ];
      const idx = modes.indexOf(state.filterMode);
      const next = modes[(idx + 1) % modes.length];
      return {
        ...state,
        filterMode: next,
        filterError: validateFilter(next, state.filterString),
      };
    }

    case 'SET_FILTER_ERROR':
      return { ...state, filterError: action.error };

    case 'SET_SESSION_FILTER':
      return { ...state, sessionFilter: action.filter };

    case 'SCROLL_DETAIL':
      return { ...state, detailScrollOffset: action.offset };

    case 'SCROLL_DETAIL_DELTA': {
      const maxOffset = maxDetailScroll(action.totalLines, action.viewportHeight);
      const next = Math.max(0, Math.min(state.detailScrollOffset + action.delta, maxOffset));
      return { ...state, detailScrollOffset: next };
    }

    case 'ADD_TOAST':
      return { ...state, toasts: [...state.toasts, action.toast] };

    case 'REMOVE_TOAST':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };

    case 'FIRST_EVENT':
      return {
        ...state,
        hasReceivedEvents: true,
        sessionFilter: action.sessionPrefix
          ? { sessionPrefix: action.sessionPrefix, label: '● active session' }
          : null,
      };

    case 'CONTEXT_MENU_NAV': {
      if (action.itemCount === 0) return state;
      const next = (state.contextMenuIndex + action.delta + action.itemCount) % action.itemCount;
      return { ...state, contextMenuIndex: next };
    }

    case 'CONTEXT_MENU_SELECT':
      return { ...state, overlay: null };

    case 'SCROLL_SIDE': {
      if (action.itemCount === 0) return state;
      const next = Math.max(
        0,
        Math.min(state.selectedItemIndex + action.delta, action.itemCount - 1),
      );
      return { ...state, selectedItemIndex: next, detailTabIndex: 0, detailScrollOffset: 0 };
    }

    case 'OVERLAY_SCROLL':
      return {
        ...state,
        overlayScrollOffset: Math.max(0, state.overlayScrollOffset + action.delta),
      };

    // The overlay owns its content height, so it reports the real maximum
    // offset back for clamping. Without this, scrolling past the bottom
    // inflates the counter unboundedly and later scroll-ups appear frozen.
    case 'CLAMP_OVERLAY_SCROLL':
      return {
        ...state,
        overlayScrollOffset: Math.min(state.overlayScrollOffset, Math.max(0, action.maxOffset)),
      };

    case 'TOGGLE_MOUSE':
      return { ...state, mouseEnabled: !state.mouseEnabled };

    case 'TICK':
      return { ...state, renderTick: state.renderTick + 1 };

    default:
      return state;
  }
}

export const initialState: DashboardUIState = {
  activePanelIndex: 0,
  selectedItemIndex: 0,
  detailTabIndex: 0,
  layoutMode: 'normal',
  focusTarget: 'side',
  overlay: null,
  filterString: '',
  filterMode: 'substring',
  filterError: null,
  sessionFilter: null,
  detailScrollOffset: 0,
  toasts: [],
  hasReceivedEvents: false,
  contextMenuIndex: 0,
  overlayScrollOffset: 0,
  renderTick: 0,
  mouseEnabled: true,
};
