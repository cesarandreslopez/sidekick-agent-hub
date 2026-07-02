/**
 * Root Ink dashboard component — lazydocker-style two-pane layout.
 * Replaces PanelLayout.ts with React/Ink rendering.
 */

import React, { useReducer, useCallback, useEffect, useRef, useMemo } from 'react';
import { Box, useInput, useApp } from 'ink';
import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { SidePanel, PanelItem, PanelAction } from '../panels/types';
// FocusStack logic is now handled by the useReducer state
import { getRandomPhraseBlessedTag } from '../../phraseFormatters';
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
import { ChangelogOverlay } from './ChangelogOverlay';
import { TooSmallOverlay } from './TooSmallOverlay';
import { ToastNotification } from './ToastNotification';
import { MouseProvider } from './mouse';
import type { TerminalMouseEvent } from './mouse';
import changelogMd from '../../../CHANGELOG.md';
import { describeQuotaFailure, parseChangelog } from 'sidekick-shared';
import { initialState, reducer, type SessionFilter } from './dashboardReducer';
import { handleDashboardInput } from './inputDispatch';
import { itemTimestampMs, parseDateExpression } from '../dateFilterExpression';

const changelogEntries = parseChangelog(changelogMd, 5);

// ── Constants ──

const SIDE_PANEL_WIDTH = 26;
const NARROW_SIDE_WIDTH = 22;
const MIN_SCREEN_WIDTH = 60;
const MIN_SCREEN_HEIGHT = 15;
const WIDE_SIDE_WIDTH = 40;

// ── Props ──

interface DashboardProps {
  panels: SidePanel[];
  metrics: DashboardMetrics;
  staticData: StaticData;
  isPinned?: boolean;
  pendingSessionPath?: string | null;
  onSessionSwitch?: (sessionPath: string) => void;
  onTogglePin?: () => void;
  onGenerateReport?: () => void;
  /** Initial mouse-capture state (resolved from --no-mouse flag and cli-config). */
  mouseInitiallyEnabled?: boolean;
  /** Called when the user toggles mouse capture with 'M' (for persistence). */
  onMouseSettingChange?: (enabled: boolean) => void;
}

// ── Component ──

export function Dashboard({
  panels,
  metrics,
  staticData,
  isPinned,
  pendingSessionPath,
  onSessionSwitch,
  onTogglePin,
  onGenerateReport,
  mouseInitiallyEnabled,
  onMouseSettingChange,
}: DashboardProps): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState, (base) => ({
    ...base,
    mouseEnabled: mouseInitiallyEnabled !== false,
  }));
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const toastIdRef = useRef(0);
  const lastAlertCountRef = useRef(0);
  const lastQuotaAlertKeyRef = useRef<string | null>(null);
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

  // ── Quota alert detection ──
  useEffect(() => {
    if (metrics.providerId !== 'claude-code') {
      lastQuotaAlertKeyRef.current = null;
      return;
    }

    const descriptor = describeQuotaFailure(metrics.quota);
    if (!descriptor) {
      lastQuotaAlertKeyRef.current = null;
      return;
    }

    if (lastQuotaAlertKeyRef.current === descriptor.alertKey) return;

    lastQuotaAlertKeyRef.current = descriptor.alertKey;
    addToast(`${descriptor.title}: ${descriptor.message}`, descriptor.severity);
  }, [addToast, metrics.providerId, metrics.quota]);

  // ── Derived values ──
  const panel = panels[state.activePanelIndex];
  const tooSmall = columns < MIN_SCREEN_WIDTH || rows < MIN_SCREEN_HEIGHT;

  // Side width based on layout mode
  const getSideWidth = () => {
    switch (state.layoutMode) {
      case 'expanded':
        return 0;
      case 'wide-side':
        return Math.min(WIDE_SIDE_WIDTH, columns - 30);
      default:
        return columns < 80 ? NARROW_SIDE_WIDTH : SIDE_PANEL_WIDTH;
    }
  };
  const sideWidth = getSideWidth();

  // Get items with filters applied
  const getFilteredItems = useCallback((): PanelItem[] => {
    let items = panel.getItems(metrics, staticData);

    // Session filter
    if (
      state.sessionFilter &&
      ['tasks', 'kanban', 'notes', 'decisions', 'plans'].includes(panel.id)
    ) {
      if (panel.id === 'kanban') {
        items = items.map((it) => filterKanbanColumn(it, state.sessionFilter!));
      } else {
        items = items.filter((it) => matchesSessionFilter(it, state.sessionFilter!));
      }
    }

    // Text filter (supports substring, fuzzy, regex, and date modes)
    if (state.filterString) {
      const f = state.filterString;
      const mode = state.filterMode;
      if (mode === 'date') {
        const parsed = parseDateExpression(f);
        // An invalid expression leaves the list unfiltered — the overlay
        // shows the parse error; transiently-invalid typing ("2026-")
        // must not blank the list.
        if (!('error' in parsed)) {
          const since = parsed.since ? Date.parse(parsed.since) : -Infinity;
          const until = parsed.until ? Date.parse(parsed.until) : Infinity;
          items = items.filter((it) => {
            const ts = panel.getItemTimestamp
              ? panel.getItemTimestamp(it)
              : itemTimestampMs(it.data);
            return ts !== null && ts >= since && ts < until;
          });
        }
      } else {
        items = items.filter((it) => {
          const searchText = panel.getSearchableText?.(it) ?? it.label.replace(/\{[^}]*\}/g, '');
          switch (mode) {
            case 'fuzzy': {
              const lower = searchText.toLowerCase();
              return f
                .toLowerCase()
                .split(/\s+/)
                .filter((w) => w)
                .every((w) => lower.includes(w));
            }
            case 'regex': {
              try {
                return new RegExp(f).test(searchText);
              } catch {
                return false;
              }
            }
            case 'substring':
            default:
              return searchText.toLowerCase().includes(f.toLowerCase());
          }
        });
      }
    }

    // Sort
    items.sort((a, b) => a.sortKey - b.sortKey);
    return items;
  }, [panel, metrics, staticData, state.sessionFilter, state.filterString, state.filterMode]);

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

  const detailPhrase = useMemo(() => getRandomPhraseBlessedTag(), [selectedItem?.id, tabIdx]);

  // Usable detail-pane columns for the current layout: total minus the side
  // panel minus border/padding overhead (parity with the legacy 29 - 26 = 3).
  const detailContentWidth = Math.max(40, columns - sideWidth - 3);

  let detailContent = '';
  if (selectedItem && detailTabs.length > 0 && tabIdx >= 0) {
    const tab = detailTabs[tabIdx];
    const tabLabel = tab.label;
    const skipPhrase = tabLabel === 'Timeline' || tabLabel === 'Mind Map';
    const prefix = skipPhrase ? '' : detailPhrase + '\n';
    detailContent =
      prefix + tab.render(selectedItem, metrics, staticData, { width: detailContentWidth });
  } else if (!selectedItem) {
    const filterablePanel = ['tasks', 'kanban', 'notes', 'decisions', 'plans'].includes(panel.id);
    detailContent =
      state.sessionFilter && filterablePanel
        ? '{grey-fg}No items in this session — press {/grey-fg}{magenta-fg}f{/magenta-fg}{grey-fg} to see all{/grey-fg}'
        : '{grey-fg}(no item selected){/grey-fg}';
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
    return panel.getActions().filter((a) => !a.condition || a.condition(selectedItem));
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
    if (
      ['tasks', 'kanban', 'notes', 'decisions', 'plans'].includes(panel.id) &&
      state.focusTarget === 'side'
    ) {
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
      const sessPanel = panels.find((p) => p.id === 'sessions');
      if (sessPanel) {
        const sessItems = sessPanel.getItems(metrics, staticData);
        sessionData = sessItems.find((it) => it.id === 'active')?.data;
      }
    }

    if (!sessionData) {
      addToast('No session selected', 'info');
      return;
    }

    const d = sessionData as {
      type: string;
      metrics?: DashboardMetrics;
      session?: { date: string };
    };
    if (d.type === 'active') {
      const prefix = (d.metrics?.sessionStartTime || '').substring(0, 8);
      if (!prefix) {
        addToast('No session start time available', 'info');
        return;
      }
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
  }, [
    state.sessionFilter,
    state.activePanelIndex,
    selectedItem,
    panels,
    metrics,
    staticData,
    addToast,
  ]);

  // ── Mouse input ──
  const handleMouse = useCallback(
    (event: TerminalMouseEvent) => {
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
          dispatch({
            type: 'SCROLL_DETAIL_DELTA',
            delta,
            totalLines: detailLines.length,
            viewportHeight: detailViewportHeight,
          });
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
    },
    [
      state.overlay,
      state.hasReceivedEvents,
      state.activePanelIndex,
      sideWidth,
      currentItems.length,
      clampedSelection,
      sideScroll,
      detailLines.length,
      detailViewportHeight,
      panels,
      detailTabs,
      rows,
    ],
  );

  // ── Keyboard input ──
  useInput((input, key) =>
    handleDashboardInput(input, key, {
      state,
      dispatch,
      exit,
      panels,
      panel,
      selectedItem,
      contextActions,
      currentItemCount: currentItems.length,
      clampedSelection,
      sideScroll,
      detailTabCount: detailTabs.length,
      detailLineCount: detailLines.length,
      detailViewportHeight,
      addToast,
      toggleSessionFilter,
      onMouseSettingChange,
      onGenerateReport,
      onTogglePin,
      isPinned,
      pendingSessionPath,
      onSessionSwitch,
    }),
  );

  // ── Render ──

  if (tooSmall) {
    return <TooSmallOverlay columns={columns} rows={rows} />;
  }

  if (!state.hasReceivedEvents) {
    return (
      <MouseProvider onMouse={handleMouse} enabled={state.mouseEnabled}>
        <Box flexDirection="column" height={rows} width={columns}>
          <Box flexGrow={1} justifyContent="center" alignItems="center">
            <SplashOverlay panelCount={panels.length} />
          </Box>
          <StatusBar
            eventCount={0}
            focusTarget="side"
            panelHints=""
            sessionFilter={null}
            filterString=""
            mouseEnabled={state.mouseEnabled}
          />
        </Box>
      </MouseProvider>
    );
  }

  return (
    <MouseProvider onMouse={handleMouse} enabled={state.mouseEnabled}>
      <Box flexDirection="column" height={rows} width={columns}>
        {/* Tab bar (hidden when full-screen overlay is active) */}
        {state.overlay !== 'help' && state.overlay !== 'changelog' && (
          <TabBar
            panels={panels}
            activeIndex={state.activePanelIndex}
            layoutMode={state.layoutMode}
          />
        )}

        {/* Main content area (hidden when full-screen overlay is active) */}
        {state.overlay !== 'help' && state.overlay !== 'changelog' && (
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
                sessionFilterActive={
                  !!state.sessionFilter &&
                  ['tasks', 'kanban', 'notes', 'decisions', 'plans'].includes(panel.id)
                }
                emptyStateHint={panel.emptyStateHint}
                filterString={state.filterString}
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
        )}

        {/* Full-screen overlays (replace main content) */}
        {state.overlay === 'help' && (
          <HelpOverlay
            panels={panels}
            activePanelIndex={state.activePanelIndex}
            scrollOffset={state.overlayScrollOffset}
            onClampScroll={(maxOffset) => dispatch({ type: 'CLAMP_OVERLAY_SCROLL', maxOffset })}
          />
        )}

        {state.overlay === 'changelog' && (
          <ChangelogOverlay
            entries={changelogEntries}
            scrollOffset={state.overlayScrollOffset}
            onClampScroll={(maxOffset) => dispatch({ type: 'CLAMP_OVERLAY_SCROLL', maxOffset })}
          />
        )}

        {/* Status bar — always visible */}
        <StatusBar
          eventCount={metrics.eventCount}
          providerName={metrics.providerName}
          permissionMode={metrics.permissionMode}
          focusTarget={state.focusTarget}
          panelHints={buildPanelHints()}
          sessionFilter={state.sessionFilter?.label ?? null}
          filterString={state.filterString}
          matchCount={currentItems.length}
          totalCount={panel.getItems(metrics, staticData).length}
          updateInfo={metrics.updateInfo}
          providerStatus={metrics.providerStatus}
          openaiStatus={metrics.openaiStatus}
          mouseEnabled={state.mouseEnabled}
        />

        {/* Inline overlays (render on top of content) */}
        {state.overlay === 'context-menu' && (
          <ContextMenuOverlay actions={contextActions} selectedIndex={state.contextMenuIndex} />
        )}

        {state.overlay === 'filter' && (
          <FilterOverlay
            filterString={state.filterString}
            filterMode={state.filterMode}
            filterError={state.filterError}
          />
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
  const filtered = colData.tasks.filter((t) =>
    matchesSessionFilter({ id: '', label: '', sortKey: 0, data: t }, filter),
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
