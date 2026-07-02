/**
 * Keyboard input dispatch for the Ink dashboard.
 * Extracted from Dashboard.tsx's useInput callback so key handling is
 * unit-testable without a renderer. All state reads/writes flow through
 * the ctx object; this module owns no state of its own.
 */

import type { Key } from 'ink';
import type { Action, DashboardUIState, LayoutMode } from './dashboardReducer';
import type { PanelAction, PanelItem, SidePanel } from '../panels/types';

/** Subset of useWindowedScroll's API used by keyboard navigation. */
export interface SideScrollControls {
  selectNext(): void;
  selectPrev(): void;
  selectFirst(): void;
  selectLast(): void;
}

/** Everything the input handler needs from the Dashboard component. */
export interface InputDispatchContext {
  state: DashboardUIState;
  dispatch: (action: Action) => void;
  exit: () => void;
  panels: SidePanel[];
  /** The active panel (panels[state.activePanelIndex]). */
  panel: SidePanel;
  selectedItem: PanelItem | undefined;
  /** Context-menu actions for the selected item (empty unless the menu is open). */
  contextActions: PanelAction[];
  currentItemCount: number;
  clampedSelection: number;
  sideScroll: SideScrollControls;
  detailTabCount: number;
  detailLineCount: number;
  detailViewportHeight: number;
  addToast: (message: string, severity: 'error' | 'warning' | 'info') => void;
  toggleSessionFilter: () => void;
  onGenerateReport?: () => void;
  onTogglePin?: () => void;
  isPinned?: boolean;
  pendingSessionPath?: string | null;
  onSessionSwitch?: (sessionPath: string) => void;
}

export function handleDashboardInput(input: string, key: Key, ctx: InputDispatchContext): void {
  const {
    state,
    dispatch,
    exit,
    panels,
    panel,
    selectedItem,
    contextActions,
    currentItemCount,
    clampedSelection,
    sideScroll,
    detailTabCount,
    detailLineCount,
    detailViewportHeight,
    addToast,
    toggleSessionFilter,
    onGenerateReport,
    onTogglePin,
    isPinned,
    pendingSessionPath,
    onSessionSwitch,
  } = ctx;

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
    if (key.tab) {
      dispatch({ type: 'CYCLE_FILTER_MODE' });
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
        const msg = action.handler(selectedItem);
        if (typeof msg === 'string')
          addToast(
            msg,
            msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('unavailable')
              ? 'error'
              : 'info',
          );
        dispatch({ type: 'CONTEXT_MENU_SELECT' });
      }
      return;
    }
    // Direct key shortcut
    const match = contextActions.find((a) => a.key === input);
    if (match && selectedItem) {
      const msg = match.handler(selectedItem);
      if (typeof msg === 'string')
        addToast(
          msg,
          msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('unavailable')
            ? 'error'
            : 'info',
        );
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

  // Changelog overlay
  if (state.overlay === 'changelog') {
    if (key.escape || input === 'V') {
      dispatch({ type: 'SET_OVERLAY', overlay: null });
    } else if (input === 'j' || key.downArrow) {
      dispatch({ type: 'CHANGELOG_SCROLL', delta: 1 });
    } else if (input === 'k' || key.upArrow) {
      dispatch({ type: 'CHANGELOG_SCROLL', delta: -1 });
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

  // Changelog toggle
  if (input === 'V') {
    dispatch({ type: 'SET_OVERLAY', overlay: 'changelog' });
    return;
  }

  // Generate HTML report
  if (input === 'r') {
    onGenerateReport?.();
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
    const labels: Record<LayoutMode, string> = {
      normal: 'Normal',
      expanded: 'Expanded',
      'wide-side': 'Wide Side',
    };
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
    dispatch({ type: 'CYCLE_DETAIL_TAB', direction: -1, tabCount: detailTabCount });
    return;
  }
  if (input === ']') {
    dispatch({ type: 'CYCLE_DETAIL_TAB', direction: 1, tabCount: detailTabCount });
    return;
  }

  // Navigation
  if (state.focusTarget === 'side') {
    if (input === 'j' || key.downArrow) {
      if (clampedSelection < currentItemCount - 1) {
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
      dispatch({ type: 'SELECT_ITEM', index: Math.max(0, currentItemCount - 1) });
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
      dispatch({
        type: 'SCROLL_DETAIL_DELTA',
        delta: 1,
        totalLines: detailLineCount,
        viewportHeight: detailViewportHeight,
      });
      return;
    }
    if (input === 'k' || key.upArrow) {
      dispatch({
        type: 'SCROLL_DETAIL_DELTA',
        delta: -1,
        totalLines: detailLineCount,
        viewportHeight: detailViewportHeight,
      });
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
      dispatch({
        type: 'SCROLL_DETAIL',
        offset: Math.max(0, detailLineCount - detailViewportHeight),
      });
      return;
    }
  }

  // Panel-specific keybindings
  const bindings = panel.getKeybindings?.() || [];
  const bindingMatch = bindings.find(
    (b) => b.keys.includes(input) && (!b.condition || b.condition(selectedItem)),
  );
  if (bindingMatch) {
    bindingMatch.handler(selectedItem);
    dispatch({ type: 'TICK' });
    return;
  }

  // Panel action shortcuts
  if (selectedItem) {
    const actions = panel.getActions();
    const actionMatch = actions.find(
      (a) => a.key === input && (!a.condition || a.condition(selectedItem)),
    );
    if (actionMatch) {
      const msg = actionMatch.handler(selectedItem);
      if (typeof msg === 'string')
        addToast(
          msg,
          msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('unavailable')
            ? 'error'
            : 'info',
        );
    }
  }
}
