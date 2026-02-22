/**
 * Root Ink dashboard component — lazydocker-style two-pane layout.
 * Replaces PanelLayout.ts with React/Ink rendering.
 */

import React, { useReducer, useCallback, useEffect, useRef } from 'react';
import { Box, useInput, useApp } from 'ink';
import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { SidePanel, PanelItem, PanelAction } from '../panels/types';
// FocusStack logic is now handled by the useReducer state
import { getRandomPhraseBlessedTag } from '../../phrases';
import { useTerminalSize } from './useTerminalSize';
import { useWindowedScroll } from './useWindowedScroll';
import { TabBar } from './TabBar';
import { SideList } from './SideList';
import { DetailTabBar } from './DetailTabBar';
import { DetailPane } from './DetailPane';
import { StatusBar } from './StatusBar';
import { SplashOverlay } from './SplashOverlay';
import { HelpOverlay } from './HelpOverlay';
import { ContextMenuOverlay } from './ContextMenuOverlay';
import { FilterOverlay } from './FilterOverlay';
import { TooSmallOverlay } from './TooSmallOverlay';
import { ToastNotification } from './ToastNotification';
import { MouseProvider } from './mouse';
import type { TerminalMouseEvent } from './mouse';

// ── Constants ──

const SIDE_PANEL_WIDTH = 26;
const NARROW_SIDE_WIDTH = 22;
const MIN_SCREEN_WIDTH = 60;
const MIN_SCREEN_HEIGHT = 15;
const WIDE_SIDE_WIDTH = 40;

type LayoutMode = 'normal' | 'expanded' | 'wide-side';
type OverlayKind = null | 'help' | 'context-menu' | 'filter';
type FocusTarget = 'side' | 'detail';

// ── Types ──

interface SessionFilter {
  sessionPrefix?: string;
  date?: string;
  label: string;
}

interface ToastEntry {
  id: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  expiresAt: number;
}

// ── State ──

interface DashboardUIState {
  activePanelIndex: number;
  selectedItemIndex: number;
  detailTabIndex: number;
  layoutMode: LayoutMode;
  focusTarget: FocusTarget;
  overlay: OverlayKind;
  filterString: string;
  sessionFilter: SessionFilter | null;
  detailScrollOffset: number;
  toasts: ToastEntry[];
  hasReceivedEvents: boolean;
  contextMenuIndex: number;
  renderTick: number;
}

type Action =
  | { type: 'SWITCH_PANEL'; index: number }
  | { type: 'SELECT_ITEM'; index: number }
  | { type: 'SET_DETAIL_TAB'; index: number }
  | { type: 'CYCLE_DETAIL_TAB'; direction: 1 | -1; tabCount: number }
  | { type: 'CYCLE_LAYOUT' }
  | { type: 'TOGGLE_FOCUS' }
  | { type: 'SET_FOCUS'; target: FocusTarget }
  | { type: 'SET_OVERLAY'; overlay: OverlayKind }
  | { type: 'SET_FILTER'; value: string }
  | { type: 'SET_SESSION_FILTER'; filter: SessionFilter | null }
  | { type: 'SCROLL_DETAIL'; offset: number }
  | { type: 'SCROLL_DETAIL_DELTA'; delta: number; totalLines: number; viewportHeight: number }
  | { type: 'ADD_TOAST'; toast: ToastEntry }
  | { type: 'REMOVE_TOAST'; id: number }
  | { type: 'FIRST_EVENT'; sessionPrefix: string }
  | { type: 'CONTEXT_MENU_NAV'; delta: number; itemCount: number }
  | { type: 'CONTEXT_MENU_SELECT' }
  | { type: 'SCROLL_SIDE'; delta: number; itemCount: number }
  | { type: 'TICK' };

function reducer(state: DashboardUIState, action: Action): DashboardUIState {
  switch (action.type) {
    case 'SWITCH_PANEL':
      return {
        ...state,
        activePanelIndex: action.index,
        selectedItemIndex: 0,
        detailTabIndex: 0,
        filterString: '',
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
      return { ...state, overlay: action.overlay, contextMenuIndex: 0 };

    case 'SET_FILTER':
      return { ...state, filterString: action.value };

    case 'SET_SESSION_FILTER':
      return { ...state, sessionFilter: action.filter };

    case 'SCROLL_DETAIL':
      return { ...state, detailScrollOffset: action.offset };

    case 'SCROLL_DETAIL_DELTA': {
      const maxOffset = Math.max(0, action.totalLines - action.viewportHeight);
      const next = Math.max(0, Math.min(state.detailScrollOffset + action.delta, maxOffset));
      return { ...state, detailScrollOffset: next };
    }

    case 'ADD_TOAST':
      return { ...state, toasts: [...state.toasts, action.toast] };

    case 'REMOVE_TOAST':
      return { ...state, toasts: state.toasts.filter(t => t.id !== action.id) };

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
      const next = Math.max(0, Math.min(state.selectedItemIndex + action.delta, action.itemCount - 1));
      return { ...state, selectedItemIndex: next, detailTabIndex: 0, detailScrollOffset: 0 };
    }

    case 'TICK':
      return { ...state, renderTick: state.renderTick + 1 };

    default:
      return state;
  }
}

const initialState: DashboardUIState = {
  activePanelIndex: 0,
  selectedItemIndex: 0,
  detailTabIndex: 0,
  layoutMode: 'normal',
  focusTarget: 'side',
  overlay: null,
  filterString: '',
  sessionFilter: null,
  detailScrollOffset: 0,
  toasts: [],
  hasReceivedEvents: false,
  contextMenuIndex: 0,
  renderTick: 0,
};

// ── Props ──

interface DashboardProps {
  panels: SidePanel[];
  metrics: DashboardMetrics;
  staticData: StaticData;
  isPinned?: boolean;
  pendingSessionPath?: string | null;
  onSessionSwitch?: (sessionPath: string) => void;
  onTogglePin?: () => void;
}

// ── Component ──

export function Dashboard({ panels, metrics, staticData, isPinned, pendingSessionPath, onSessionSwitch, onTogglePin }: DashboardProps): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const toastIdRef = useRef(0);
  const lastAlertCountRef = useRef(0);
  const alertsInitRef = useRef(false);
  const prevDetailLineCountRef = useRef(0);

  // ── First event detection ──
  useEffect(() => {
    if (!state.hasReceivedEvents && metrics.eventCount > 0) {
      const prefix = (metrics.sessionStartTime || '').substring(0, 8);
      dispatch({ type: 'FIRST_EVENT', sessionPrefix: prefix });
    }
  }, [metrics.eventCount, state.hasReceivedEvents, metrics.sessionStartTime]);

  // ── Alert detection ──
  useEffect(() => {
    if (!alertsInitRef.current) {
      lastAlertCountRef.current = metrics.eventCount;
      alertsInitRef.current = true;
      return;
    }
    if (metrics.eventCount === lastAlertCountRef.current) return;
    const newCount = metrics.eventCount - lastAlertCountRef.current;
    const startIdx = Math.max(0, metrics.timeline.length - newCount);
    for (let i = startIdx; i < metrics.timeline.length; i++) {
      const e = metrics.timeline[i];
      if (e.type === 'summary') {
        addToast(e.summary || 'Context compacted', 'warning');
      } else if (e.type === 'system' && e.summary?.includes('ended')) {
        addToast(e.summary, 'info');
      }
    }
    lastAlertCountRef.current = metrics.eventCount;
  }, [metrics.eventCount, metrics.timeline]);

  // ── Toast management ──
  const addToast = useCallback((message: string, severity: 'error' | 'warning' | 'info') => {
    const durations = { error: 4000, warning: 3000, info: 2000 };
    const id = ++toastIdRef.current;
    dispatch({
      type: 'ADD_TOAST',
      toast: { id, message, severity, expiresAt: Date.now() + durations[severity] },
    });
    setTimeout(() => {
      dispatch({ type: 'REMOVE_TOAST', id });
    }, durations[severity]);
  }, []);

  // ── Derived values ──
  const panel = panels[state.activePanelIndex];
  const tooSmall = columns < MIN_SCREEN_WIDTH || rows < MIN_SCREEN_HEIGHT;

  // Side width based on layout mode
  const getSideWidth = () => {
    switch (state.layoutMode) {
      case 'expanded': return 0;
      case 'wide-side': return Math.min(WIDE_SIDE_WIDTH, columns - 30);
      default: return columns < 80 ? NARROW_SIDE_WIDTH : SIDE_PANEL_WIDTH;
    }
  };
  const sideWidth = getSideWidth();

  // Get items with filters applied
  const getFilteredItems = useCallback((): PanelItem[] => {
    let items = panel.getItems(metrics, staticData);

    // Session filter
    if (state.sessionFilter && ['tasks', 'kanban', 'notes', 'decisions'].includes(panel.id)) {
      if (panel.id === 'kanban') {
        items = items.map(it => filterKanbanColumn(it, state.sessionFilter!));
      } else {
        items = items.filter(it => matchesSessionFilter(it, state.sessionFilter!));
      }
    }

    // Text filter
    if (state.filterString) {
      const f = state.filterString.toLowerCase();
      items = items.filter(it => {
        const searchText = panel.getSearchableText?.(it)
          ?? it.label.replace(/\{[^}]*\}/g, '');
        return searchText.toLowerCase().includes(f);
      });
    }

    // Sort
    items.sort((a, b) => a.sortKey - b.sortKey);
    return items;
  }, [panel, metrics, staticData, state.sessionFilter, state.filterString]);

  const currentItems = getFilteredItems();

  // Clamp selection
  const clampedSelection = Math.min(state.selectedItemIndex, Math.max(0, currentItems.length - 1));
  if (clampedSelection !== state.selectedItemIndex && currentItems.length > 0) {
    dispatch({ type: 'SELECT_ITEM', index: clampedSelection });
  }

  // Side list scrolling
  const sideViewportHeight = Math.max(1, rows - 5); // tab bar + borders + status bar
  const sideScroll = useWindowedScroll({
    totalItems: currentItems.length,
    viewportHeight: sideViewportHeight,
  });

  // Sync sideScroll selection with state
  useEffect(() => {
    if (sideScroll.selectedIndex !== state.selectedItemIndex) {
      sideScroll.setSelected(state.selectedItemIndex);
    }
  }, [state.selectedItemIndex]);

  // Detail content
  const selectedItem = currentItems[clampedSelection];
  const detailTabs = panel.detailTabs;
  const tabIdx = Math.min(state.detailTabIndex, detailTabs.length - 1);

  let detailContent = '';
  if (selectedItem && detailTabs.length > 0 && tabIdx >= 0) {
    const tab = detailTabs[tabIdx];
    const tabLabel = tab.label;
    const skipPhrase = tabLabel === 'Timeline' || tabLabel === 'Mind Map';
    const prefix = skipPhrase ? '' : getRandomPhraseBlessedTag() + '\n';
    detailContent = prefix + tab.render(selectedItem, metrics, staticData);
  } else if (!selectedItem) {
    detailContent = '{grey-fg}(no item selected){/grey-fg}';
  }

  const detailLines = detailContent.split('\n');
  const detailViewportHeight = Math.max(1, rows - 5);

  // Auto-scroll for tabs that request it (e.g., Timeline)
  const activeTab = detailTabs[tabIdx];
  useEffect(() => {
    if (!activeTab?.autoScrollBottom) return;
    if (detailLines.length <= detailViewportHeight) return;
    // Only auto-scroll when new content arrives (line count increased)
    if (detailLines.length > prevDetailLineCountRef.current) {
      const bottomOffset = detailLines.length - detailViewportHeight;
      dispatch({ type: 'SCROLL_DETAIL', offset: bottomOffset });
    }
    prevDetailLineCountRef.current = detailLines.length;
  }, [detailLines.length, activeTab?.autoScrollBottom, detailViewportHeight]);

  // Sync activeDetailTabIndex for panels that read it
  if ('activeDetailTabIndex' in panel) {
    (panel as Record<string, unknown>).activeDetailTabIndex = state.detailTabIndex;
  }

  // ── Context menu actions ──
  const getContextActions = useCallback((): PanelAction[] => {
    if (!selectedItem) return [];
    return panel.getActions().filter(a => !a.condition || a.condition(selectedItem));
  }, [panel, selectedItem]);

  const contextActions = state.overlay === 'context-menu' ? getContextActions() : [];

  // ── Build panel hints ──
  const buildPanelHints = useCallback((): string => {
    const parts: string[] = [];
    const bindings = panel.getKeybindings?.() || [];
    for (const b of bindings) {
      if (!b.condition || b.condition(selectedItem)) {
        parts.push(`${b.keys[0]} ${b.label.toLowerCase().substring(0, 12)}`);
      }
    }
    if (panel.getActions().length > 0 && state.focusTarget === 'side') {
      parts.push('x actions');
    }
    if (['tasks', 'kanban', 'notes', 'decisions'].includes(panel.id) && state.focusTarget === 'side') {
      parts.push('f session');
    }
    return parts.length > 0 ? parts.join('  ') + '  ' : '';
  }, [panel, selectedItem, state.focusTarget]);

  // ── Session filter toggle ──
  const toggleSessionFilter = useCallback(() => {
    if (state.sessionFilter) {
      dispatch({ type: 'SET_SESSION_FILTER', filter: null });
      addToast('Session filter cleared', 'info');
      return;
    }

    let sessionData: unknown;
    if (panels[state.activePanelIndex].id === 'sessions') {
      sessionData = selectedItem?.data;
    } else {
      const sessPanel = panels.find(p => p.id === 'sessions');
      if (sessPanel) {
        const sessItems = sessPanel.getItems(metrics, staticData);
        sessionData = sessItems.find(it => it.id === 'active')?.data;
      }
    }

    if (!sessionData) {
      addToast('No session selected', 'info');
      return;
    }

    const d = sessionData as { type: string; metrics?: DashboardMetrics; session?: { date: string } };
    if (d.type === 'active') {
      const prefix = (d.metrics?.sessionStartTime || '').substring(0, 8);
      if (!prefix) { addToast('No session start time available', 'info'); return; }
      const filter = { sessionPrefix: prefix, label: '● active session' };
      dispatch({ type: 'SET_SESSION_FILTER', filter });
      addToast(`Session filter: ${filter.label}`, 'info');
    } else if (d.type === 'historical' && d.session) {
      const filter = { date: d.session.date, label: `⊛ ${d.session.date}` };
      dispatch({ type: 'SET_SESSION_FILTER', filter });
      addToast(`Session filter: ${filter.label}`, 'info');
    } else {
      addToast('Cannot filter by this item', 'info');
    }
  }, [state.sessionFilter, state.activePanelIndex, selectedItem, panels, metrics, staticData, addToast]);

  // ── Mouse input ──
  const handleMouse = useCallback((event: TerminalMouseEvent) => {
    // Overlays: click anywhere dismisses
    if (state.overlay) {
      if (event.type === 'click') {
        dispatch({ type: 'SET_OVERLAY', overlay: null });
      }
      return;
    }

    if (!state.hasReceivedEvents) return;

    const { x, y } = event;

    // Scroll wheel
    if (event.type === 'scroll') {
      if (x < sideWidth && sideWidth > 0) {
        const delta = event.scrollDirection === 'down' ? 3 : -3;
        dispatch({ type: 'SCROLL_SIDE', delta, itemCount: currentItems.length });
        const newIdx = Math.max(0, Math.min(clampedSelection + delta, currentItems.length - 1));
        sideScroll.setSelected(newIdx);
      } else {
        const delta = event.scrollDirection === 'down' ? 3 : -3;
        dispatch({ type: 'SCROLL_DETAIL_DELTA', delta, totalLines: detailLines.length, viewportHeight: detailViewportHeight });
      }
      return;
    }

    if (event.type !== 'click' || event.button !== 'left') return;

    // Row 0: TabBar
    if (y === 0) {
      let col = 0;
      for (let i = 0; i < panels.length; i++) {
        // Each tab renders as "[N] Title" + marginRight=1 → key.length + title.length + 4
        const tabWidth = String(panels[i].shortcutKey).length + panels[i].title.length + 4;
        if (x >= col && x < col + tabWidth) {
          panels[state.activePanelIndex]?.onDeactivate?.();
          dispatch({ type: 'SWITCH_PANEL', index: i });
          panels[i]?.onActivate?.();
          return;
        }
        col += tabWidth;
      }
      return;
    }

    // Last row: StatusBar (no action)
    if (y >= rows - 1) return;

    // Main content area
    if (x < sideWidth && sideWidth > 0) {
      // Click in side list
      dispatch({ type: 'SET_FOCUS', target: 'side' });
      // Row 0 = tab bar, row 1 = border/panel title row
      // When scrolled down, a "▲" indicator takes an extra row
      const hasScrollUp = sideScroll.scrollOffset > 0;
      const itemRow = y - 2 - (hasScrollUp ? 1 : 0);
      const itemIndex = sideScroll.scrollOffset + itemRow;
      if (itemIndex >= 0 && itemIndex < currentItems.length) {
        dispatch({ type: 'SELECT_ITEM', index: itemIndex });
        sideScroll.setSelected(itemIndex);
      }
    } else {
      // Click in detail area
      dispatch({ type: 'SET_FOCUS', target: 'detail' });

      // Row 1 = DetailTabBar — check for tab click
      if (y === 1 && detailTabs.length > 1) {
        let col = sideWidth + 2; // leading space + border
        for (let i = 0; i < detailTabs.length; i++) {
          // "▸ Label" or "  Label" + marginRight=1
          const tabWidth = detailTabs[i].label.length + 3;
          if (x >= col && x < col + tabWidth) {
            dispatch({ type: 'SET_DETAIL_TAB', index: i });
            return;
          }
          col += tabWidth;
        }
      }
    }
  }, [state.overlay, state.hasReceivedEvents, state.activePanelIndex, sideWidth, currentItems.length, clampedSelection, sideScroll, detailLines.length, detailViewportHeight, panels, detailTabs, rows]);

  // ── Keyboard input ──
  useInput((input, key) => {
    // Quit
    if (input === 'q' || (key.ctrl && input === 'c')) {
      if (state.overlay) {
        dispatch({ type: 'SET_OVERLAY', overlay: null });
        return;
      }
      exit();
      return;
    }

    // Filter overlay captures all input
    if (state.overlay === 'filter') {
      if (key.escape) {
        dispatch({ type: 'SET_FILTER', value: '' });
        dispatch({ type: 'SET_OVERLAY', overlay: null });
        return;
      }
      if (key.return) {
        dispatch({ type: 'SET_OVERLAY', overlay: null });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: 'SET_FILTER', value: state.filterString.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({ type: 'SET_FILTER', value: state.filterString + input });
        return;
      }
      return;
    }

    // Context menu overlay
    if (state.overlay === 'context-menu') {
      if (key.escape) {
        dispatch({ type: 'SET_OVERLAY', overlay: null });
        return;
      }
      if (input === 'j' || key.downArrow) {
        dispatch({ type: 'CONTEXT_MENU_NAV', delta: 1, itemCount: contextActions.length });
        return;
      }
      if (input === 'k' || key.upArrow) {
        dispatch({ type: 'CONTEXT_MENU_NAV', delta: -1, itemCount: contextActions.length });
        return;
      }
      if (key.return) {
        const action = contextActions[state.contextMenuIndex];
        if (action && selectedItem) {
          action.handler(selectedItem);
          dispatch({ type: 'CONTEXT_MENU_SELECT' });
        }
        return;
      }
      // Direct key shortcut
      const match = contextActions.find(a => a.key === input);
      if (match && selectedItem) {
        match.handler(selectedItem);
        dispatch({ type: 'CONTEXT_MENU_SELECT' });
      }
      return;
    }

    // Help overlay
    if (state.overlay === 'help') {
      if (key.escape || input === '?') {
        dispatch({ type: 'SET_OVERLAY', overlay: null });
      }
      return;
    }

    // ── Global keys (no overlay) ──

    // Escape
    if (key.escape) {
      if (state.filterString) {
        dispatch({ type: 'SET_FILTER', value: '' });
        return;
      }
      if (state.focusTarget === 'detail') {
        dispatch({ type: 'SET_FOCUS', target: 'side' });
        return;
      }
      return;
    }

    // Help toggle
    if (input === '?') {
      dispatch({ type: 'SET_OVERLAY', overlay: 'help' });
      return;
    }

    // Panel switching (1-9)
    const num = parseInt(input, 10);
    if (num >= 1 && num <= panels.length) {
      if (!state.hasReceivedEvents && num <= 2) return;
      if (!state.hasReceivedEvents) {
        dispatch({ type: 'FIRST_EVENT', sessionPrefix: '' });
      }
      panels[state.activePanelIndex]?.onDeactivate?.();
      dispatch({ type: 'SWITCH_PANEL', index: num - 1 });
      panels[num - 1]?.onActivate?.();
      return;
    }

    if (!state.hasReceivedEvents) return;

    // Tab toggle focus
    if (key.tab) {
      dispatch({ type: 'TOGGLE_FOCUS' });
      return;
    }

    // Layout cycling
    if (input === 'z') {
      dispatch({ type: 'CYCLE_LAYOUT' });
      const modes: LayoutMode[] = ['normal', 'expanded', 'wide-side'];
      const idx = modes.indexOf(state.layoutMode);
      const next = modes[(idx + 1) % modes.length];
      const labels: Record<LayoutMode, string> = { normal: 'Normal', expanded: 'Expanded', 'wide-side': 'Wide Side' };
      addToast(`Layout: ${labels[next]}`, 'info');
      return;
    }

    // Filter
    if (input === '/') {
      dispatch({ type: 'SET_OVERLAY', overlay: 'filter' });
      return;
    }

    // Pin session toggle
    if (input === 'p' && onTogglePin) {
      onTogglePin();
      addToast(isPinned ? 'Session unpinned' : 'Session pinned', 'info');
      return;
    }

    // Switch to pending session
    if (input === 's' && pendingSessionPath && onSessionSwitch) {
      onSessionSwitch(pendingSessionPath);
      return;
    }

    // Session filter
    if (input === 'f') {
      toggleSessionFilter();
      return;
    }

    // Context menu
    if (input === 'x') {
      if (selectedItem && panel.getActions().length > 0) {
        dispatch({ type: 'SET_OVERLAY', overlay: 'context-menu' });
      }
      return;
    }

    // Detail tab cycling
    if (input === '[') {
      dispatch({ type: 'CYCLE_DETAIL_TAB', direction: -1, tabCount: detailTabs.length });
      return;
    }
    if (input === ']') {
      dispatch({ type: 'CYCLE_DETAIL_TAB', direction: 1, tabCount: detailTabs.length });
      return;
    }

    // Navigation
    if (state.focusTarget === 'side') {
      if (input === 'j' || key.downArrow) {
        if (clampedSelection < currentItems.length - 1) {
          dispatch({ type: 'SELECT_ITEM', index: clampedSelection + 1 });
          sideScroll.selectNext();
        }
        return;
      }
      if (input === 'k' || key.upArrow) {
        if (clampedSelection > 0) {
          dispatch({ type: 'SELECT_ITEM', index: clampedSelection - 1 });
          sideScroll.selectPrev();
        }
        return;
      }
      if (input === 'g') {
        dispatch({ type: 'SELECT_ITEM', index: 0 });
        sideScroll.selectFirst();
        return;
      }
      if (input === 'G') {
        dispatch({ type: 'SELECT_ITEM', index: Math.max(0, currentItems.length - 1) });
        sideScroll.selectLast();
        return;
      }
      if (key.return) {
        dispatch({ type: 'SET_FOCUS', target: 'detail' });
        return;
      }
    }

    if (state.focusTarget === 'detail') {
      if (input === 'j' || key.downArrow) {
        dispatch({ type: 'SCROLL_DETAIL_DELTA', delta: 1, totalLines: detailLines.length, viewportHeight: detailViewportHeight });
        return;
      }
      if (input === 'k' || key.upArrow) {
        dispatch({ type: 'SCROLL_DETAIL_DELTA', delta: -1, totalLines: detailLines.length, viewportHeight: detailViewportHeight });
        return;
      }
      if (input === 'h' || key.leftArrow) {
        dispatch({ type: 'SET_FOCUS', target: 'side' });
        return;
      }
      if (input === 'g') {
        dispatch({ type: 'SCROLL_DETAIL', offset: 0 });
        return;
      }
      if (input === 'G') {
        dispatch({ type: 'SCROLL_DETAIL', offset: Math.max(0, detailLines.length - detailViewportHeight) });
        return;
      }
    }

    // Panel-specific keybindings
    const bindings = panel.getKeybindings?.() || [];
    const bindingMatch = bindings.find(b =>
      b.keys.includes(input) && (!b.condition || b.condition(selectedItem))
    );
    if (bindingMatch) {
      bindingMatch.handler(selectedItem);
      dispatch({ type: 'TICK' });
      return;
    }

    // Panel action shortcuts
    if (selectedItem) {
      const actions = panel.getActions();
      const actionMatch = actions.find(a => a.key === input && (!a.condition || a.condition(selectedItem)));
      if (actionMatch) {
        actionMatch.handler(selectedItem);
      }
    }
  });

  // ── Render ──

  if (tooSmall) {
    return <TooSmallOverlay columns={columns} rows={rows} />;
  }

  if (!state.hasReceivedEvents) {
    return (
      <MouseProvider onMouse={handleMouse}>
        <Box flexDirection="column" height={rows} width={columns}>
          <Box flexGrow={1} justifyContent="center" alignItems="center">
            <SplashOverlay />
          </Box>
          <StatusBar
            eventCount={0}
            focusTarget="side"
            panelHints=""
            sessionFilter={null}
            filterString=""
          />
        </Box>
      </MouseProvider>
    );
  }

  return (
    <MouseProvider onMouse={handleMouse}>
      <Box flexDirection="column" height={rows} width={columns}>
        {/* Tab bar */}
        <TabBar panels={panels} activeIndex={state.activePanelIndex} layoutMode={state.layoutMode} />

        {/* Main content area */}
        <Box flexGrow={1} flexDirection="row">
          {/* Side list (hidden in expanded mode) */}
          {sideWidth > 0 && (
            <SideList
              items={currentItems}
              selectedIndex={clampedSelection}
              scrollOffset={sideScroll.scrollOffset}
              focused={state.focusTarget === 'side'}
              width={sideWidth}
              viewportHeight={sideViewportHeight}
              panelTitle={panel.title}
            />
          )}

          {/* Detail area */}
          <Box flexDirection="column" flexGrow={1}>
            <DetailTabBar tabs={detailTabs} activeIndex={state.detailTabIndex} />
            <DetailPane
              content={detailContent}
              scrollOffset={state.detailScrollOffset}
              viewportHeight={detailViewportHeight}
              focused={state.focusTarget === 'detail'}
            />
          </Box>
        </Box>

        {/* Status bar */}
        <StatusBar
          eventCount={metrics.eventCount}
          providerName={metrics.providerName}
          focusTarget={state.focusTarget}
          panelHints={buildPanelHints()}
          sessionFilter={state.sessionFilter?.label ?? null}
          filterString={state.filterString}
          matchCount={currentItems.length}
          totalCount={panel.getItems(metrics, staticData).length}
          updateInfo={metrics.updateInfo}
        />

        {/* Overlays */}
        {state.overlay === 'help' && (
          <HelpOverlay panels={panels} activePanelIndex={state.activePanelIndex} />
        )}

        {state.overlay === 'context-menu' && (
          <ContextMenuOverlay
            actions={contextActions}
            selectedIndex={state.contextMenuIndex}
          />
        )}

        {state.overlay === 'filter' && (
          <FilterOverlay filterString={state.filterString} />
        )}

        {/* Toasts */}
        {state.toasts.length > 0 && (
          <ToastNotification toast={state.toasts[state.toasts.length - 1]} />
        )}
      </Box>
    </MouseProvider>
  );
}

// ── Session filter helpers ──

function matchesSessionFilter(item: PanelItem, filter: SessionFilter): boolean {
  const data = item.data as Record<string, unknown> | undefined;
  if (!data) return false;

  if (filter.sessionPrefix) {
    const sessionOrigin = data.sessionOrigin as string | undefined;
    const sessionId = data.sessionId as string | undefined;
    if (sessionOrigin?.substring(0, 8) === filter.sessionPrefix) return true;
    if (sessionId?.substring(0, 8) === filter.sessionPrefix) return true;
    if (!sessionOrigin && !sessionId) return true;
    return false;
  }

  if (filter.date) {
    const createdAt = data.createdAt as string | undefined;
    const timestamp = data.timestamp as string | undefined;
    const sessionOrigin = data.sessionOrigin as string | undefined;
    const sessionId = data.sessionId as string | undefined;
    if (createdAt?.startsWith(filter.date)) return true;
    if (timestamp?.startsWith(filter.date)) return true;
    if (sessionOrigin?.startsWith(filter.date)) return true;
    if (sessionId?.startsWith(filter.date)) return true;
    return false;
  }

  return true;
}

function filterKanbanColumn(item: PanelItem, filter: SessionFilter): PanelItem {
  const colData = item.data as { status: string; tasks: Array<Record<string, unknown>> };
  const filtered = colData.tasks.filter(t =>
    matchesSessionFilter({ id: '', label: '', sortKey: 0, data: t }, filter)
  );
  const statusIcons: Record<string, string> = {
    pending: '{yellow-fg}○{/yellow-fg}',
    in_progress: '{green-fg}→{/green-fg}',
    completed: '{cyan-fg}✓{/cyan-fg}',
  };
  const statusLabels: Record<string, string> = {
    pending: 'Pending',
    in_progress: 'Active',
    completed: 'Completed',
  };
  const icon = statusIcons[colData.status] || '';
  const label = statusLabels[colData.status] || colData.status;
  return {
    ...item,
    label: `${icon} ${label} (${filtered.length})`,
    data: { status: colData.status, tasks: filtered },
  };
}
