/**
 * Characterization tests for the dashboard keyboard dispatch.
 *
 * These pin the CURRENT dispatch behavior so the input-pipeline reorder can
 * land as a small, fully covered diff. Cases marked CHARACTERIZATION document
 * known-buggy behavior on purpose; the reorder commit updates them.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Key } from 'ink';
import { handleDashboardInput, type InputDispatchContext } from './inputDispatch';
import { initialState, type Action, type DashboardUIState } from './dashboardReducer';
import type { KeyBinding, PanelAction, PanelItem, SidePanel } from '../panels/types';

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

interface StubPanelOpts {
  id?: string;
  shortcutKey?: number;
  actions?: PanelAction[];
  bindings?: KeyBinding[];
}

function makePanel(opts: StubPanelOpts = {}): SidePanel {
  return {
    id: opts.id ?? 'sessions',
    title: 'Stub',
    shortcutKey: opts.shortcutKey ?? 1,
    detailTabs: [{ label: 'Info', render: () => '' }],
    getItems: () => [],
    getActions: () => opts.actions ?? [],
    getKeybindings: () => opts.bindings ?? [],
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
  };
}

interface MakeCtxResult {
  ctx: InputDispatchContext;
  dispatched: Action[];
  exit: ReturnType<typeof vi.fn>;
  addToast: ReturnType<typeof vi.fn>;
  toggleSessionFilter: ReturnType<typeof vi.fn>;
  sideScroll: {
    selectNext: ReturnType<typeof vi.fn>;
    selectPrev: ReturnType<typeof vi.fn>;
    selectFirst: ReturnType<typeof vi.fn>;
    selectLast: ReturnType<typeof vi.fn>;
  };
}

function makeCtx(
  stateOverrides: Partial<DashboardUIState> = {},
  ctxOverrides: Partial<InputDispatchContext> = {},
): MakeCtxResult {
  const dispatched: Action[] = [];
  const exit = vi.fn();
  const addToast = vi.fn();
  const toggleSessionFilter = vi.fn();
  const sideScroll = {
    selectNext: vi.fn(),
    selectPrev: vi.fn(),
    selectFirst: vi.fn(),
    selectLast: vi.fn(),
  };
  const panels = ctxOverrides.panels ?? [makePanel(), makePanel({ id: 'p2', shortcutKey: 2 })];
  const ctx: InputDispatchContext = {
    state: { ...initialState, hasReceivedEvents: true, ...stateOverrides },
    dispatch: (a) => dispatched.push(a),
    exit,
    panels,
    panel: panels[0],
    selectedItem: undefined,
    contextActions: [],
    currentItemCount: 0,
    clampedSelection: 0,
    sideScroll,
    detailTabCount: 1,
    detailLineCount: 0,
    detailViewportHeight: 10,
    addToast,
    toggleSessionFilter,
    ...ctxOverrides,
  };
  return { ctx, dispatched, exit, addToast, toggleSessionFilter, sideScroll };
}

const item: PanelItem = { id: 'i1', label: 'Item', sortKey: 0, data: {} };

describe('quit handling', () => {
  it("'q' with no overlay exits", () => {
    const { ctx, exit, dispatched } = makeCtx();
    handleDashboardInput('q', makeKey(), ctx);
    expect(exit).toHaveBeenCalledOnce();
    expect(dispatched).toEqual([]);
  });

  it("'q' with help overlay closes the overlay instead of exiting", () => {
    const { ctx, exit, dispatched } = makeCtx({ overlay: 'help' });
    handleDashboardInput('q', makeKey(), ctx);
    expect(exit).not.toHaveBeenCalled();
    expect(dispatched).toEqual([{ type: 'SET_OVERLAY', overlay: null }]);
  });

  // CHARACTERIZATION (bug): 'q' cannot be typed into the filter — the quit
  // check runs before the filter-capture branch and closes the overlay.
  it("'q' with filter overlay currently closes the overlay (not typed)", () => {
    const { ctx, exit, dispatched } = makeCtx({ overlay: 'filter', filterString: 's' });
    handleDashboardInput('q', makeKey(), ctx);
    expect(exit).not.toHaveBeenCalled();
    expect(dispatched).toEqual([{ type: 'SET_OVERLAY', overlay: null }]);
  });

  // CHARACTERIZATION: Ctrl+C with an overlay open currently only closes the
  // overlay rather than exiting.
  it('Ctrl+C with overlay currently closes overlay, no exit', () => {
    const { ctx, exit, dispatched } = makeCtx({ overlay: 'changelog' });
    handleDashboardInput('c', makeKey({ ctrl: true }), ctx);
    expect(exit).not.toHaveBeenCalled();
    expect(dispatched).toEqual([{ type: 'SET_OVERLAY', overlay: null }]);
  });

  it('Ctrl+C with no overlay exits', () => {
    const { ctx, exit } = makeCtx();
    handleDashboardInput('c', makeKey({ ctrl: true }), ctx);
    expect(exit).toHaveBeenCalledOnce();
  });
});

describe('filter overlay', () => {
  it('printable characters append to the filter string', () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'filter', filterString: 'ab' });
    handleDashboardInput('c', makeKey(), ctx);
    expect(dispatched).toEqual([{ type: 'SET_FILTER', value: 'abc' }]);
  });

  it('backspace trims the filter string', () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'filter', filterString: 'abc' });
    handleDashboardInput('', makeKey({ backspace: true }), ctx);
    expect(dispatched).toEqual([{ type: 'SET_FILTER', value: 'ab' }]);
  });

  it('escape clears the filter and closes the overlay', () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'filter', filterString: 'abc' });
    handleDashboardInput('', makeKey({ escape: true }), ctx);
    expect(dispatched).toEqual([
      { type: 'SET_FILTER', value: '' },
      { type: 'SET_OVERLAY', overlay: null },
    ]);
  });

  it('enter closes the overlay keeping the filter', () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'filter', filterString: 'abc' });
    handleDashboardInput('', makeKey({ return: true }), ctx);
    expect(dispatched).toEqual([{ type: 'SET_OVERLAY', overlay: null }]);
  });

  it('tab cycles the filter mode', () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'filter' });
    handleDashboardInput('', makeKey({ tab: true }), ctx);
    expect(dispatched).toEqual([{ type: 'CYCLE_FILTER_MODE' }]);
  });

  it('ctrl-modified characters are ignored', () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'filter', filterString: 'ab' });
    handleDashboardInput('x', makeKey({ ctrl: true }), ctx);
    expect(dispatched).toEqual([]);
  });
});

describe('context menu overlay', () => {
  const actions: PanelAction[] = [
    { key: 'd', label: 'Delete', handler: vi.fn(() => 'Deleted') },
    { key: 'o', label: 'Open', handler: vi.fn(() => 'Open failed') },
  ];

  it('j/k navigate', () => {
    const { ctx, dispatched } = makeCtx(
      { overlay: 'context-menu' },
      { contextActions: actions, selectedItem: item },
    );
    handleDashboardInput('j', makeKey(), ctx);
    handleDashboardInput('k', makeKey(), ctx);
    expect(dispatched).toEqual([
      { type: 'CONTEXT_MENU_NAV', delta: 1, itemCount: 2 },
      { type: 'CONTEXT_MENU_NAV', delta: -1, itemCount: 2 },
    ]);
  });

  it('enter runs the highlighted action and toasts info', () => {
    const { ctx, dispatched, addToast } = makeCtx(
      { overlay: 'context-menu', contextMenuIndex: 0 },
      { contextActions: actions, selectedItem: item },
    );
    handleDashboardInput('', makeKey({ return: true }), ctx);
    expect(actions[0].handler).toHaveBeenCalledWith(item);
    expect(addToast).toHaveBeenCalledWith('Deleted', 'info');
    expect(dispatched).toEqual([{ type: 'CONTEXT_MENU_SELECT' }]);
  });

  it("a failing action's message toasts as error", () => {
    const { ctx, addToast } = makeCtx(
      { overlay: 'context-menu' },
      { contextActions: actions, selectedItem: item },
    );
    handleDashboardInput('o', makeKey(), ctx);
    expect(addToast).toHaveBeenCalledWith('Open failed', 'error');
  });

  it('escape closes the menu', () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'context-menu' }, { contextActions: actions });
    handleDashboardInput('', makeKey({ escape: true }), ctx);
    expect(dispatched).toEqual([{ type: 'SET_OVERLAY', overlay: null }]);
  });
});

describe('help and changelog overlays', () => {
  it("'?' closes the help overlay; other keys are inert", () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'help' });
    handleDashboardInput('j', makeKey(), ctx);
    expect(dispatched).toEqual([]);
    handleDashboardInput('?', makeKey(), ctx);
    expect(dispatched).toEqual([{ type: 'SET_OVERLAY', overlay: null }]);
  });

  it('changelog scrolls with j/k and closes with V', () => {
    const { ctx, dispatched } = makeCtx({ overlay: 'changelog' });
    handleDashboardInput('j', makeKey(), ctx);
    handleDashboardInput('k', makeKey(), ctx);
    handleDashboardInput('V', makeKey(), ctx);
    expect(dispatched).toEqual([
      { type: 'CHANGELOG_SCROLL', delta: 1 },
      { type: 'CHANGELOG_SCROLL', delta: -1 },
      { type: 'SET_OVERLAY', overlay: null },
    ]);
  });
});

describe('global keys', () => {
  it('escape clears an active filter string first', () => {
    const { ctx, dispatched } = makeCtx({ filterString: 'abc' });
    handleDashboardInput('', makeKey({ escape: true }), ctx);
    expect(dispatched).toEqual([{ type: 'SET_FILTER', value: '' }]);
  });

  it('escape returns focus to the side list', () => {
    const { ctx, dispatched } = makeCtx({ focusTarget: 'detail' });
    handleDashboardInput('', makeKey({ escape: true }), ctx);
    expect(dispatched).toEqual([{ type: 'SET_FOCUS', target: 'side' }]);
  });

  it("'?' opens help, 'V' opens changelog, '/' opens filter", () => {
    const { ctx, dispatched } = makeCtx();
    handleDashboardInput('?', makeKey(), ctx);
    handleDashboardInput('V', makeKey(), ctx);
    handleDashboardInput('/', makeKey(), ctx);
    expect(dispatched).toEqual([
      { type: 'SET_OVERLAY', overlay: 'help' },
      { type: 'SET_OVERLAY', overlay: 'changelog' },
      { type: 'SET_OVERLAY', overlay: 'filter' },
    ]);
  });

  it("'z' cycles layout with a toast", () => {
    const { ctx, dispatched, addToast } = makeCtx();
    handleDashboardInput('z', makeKey(), ctx);
    expect(dispatched).toEqual([{ type: 'CYCLE_LAYOUT' }]);
    expect(addToast).toHaveBeenCalledWith('Layout: Expanded', 'info');
  });

  it("'r' triggers report generation", () => {
    const onGenerateReport = vi.fn();
    const { ctx } = makeCtx({}, { onGenerateReport });
    handleDashboardInput('r', makeKey(), ctx);
    expect(onGenerateReport).toHaveBeenCalledOnce();
  });

  it("'p' toggles pin with a toast", () => {
    const onTogglePin = vi.fn();
    const { ctx, addToast } = makeCtx({}, { onTogglePin, isPinned: true });
    handleDashboardInput('p', makeKey(), ctx);
    expect(onTogglePin).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith('Session unpinned', 'info');
  });

  it("'s' switches to the pending session", () => {
    const onSessionSwitch = vi.fn();
    const { ctx } = makeCtx({}, { pendingSessionPath: '/tmp/s.jsonl', onSessionSwitch });
    handleDashboardInput('s', makeKey(), ctx);
    expect(onSessionSwitch).toHaveBeenCalledWith('/tmp/s.jsonl');
  });

  it("'x' opens the context menu when the item has actions", () => {
    const panels = [makePanel({ actions: [{ key: 'd', label: 'Del', handler: () => undefined }] })];
    const { ctx, dispatched } = makeCtx({}, { panels, panel: panels[0], selectedItem: item });
    handleDashboardInput('x', makeKey(), ctx);
    expect(dispatched).toEqual([{ type: 'SET_OVERLAY', overlay: 'context-menu' }]);
  });

  it("'[' and ']' cycle detail tabs", () => {
    const { ctx, dispatched } = makeCtx({}, { detailTabCount: 3 });
    handleDashboardInput('[', makeKey(), ctx);
    handleDashboardInput(']', makeKey(), ctx);
    expect(dispatched).toEqual([
      { type: 'CYCLE_DETAIL_TAB', direction: -1, tabCount: 3 },
      { type: 'CYCLE_DETAIL_TAB', direction: 1, tabCount: 3 },
    ]);
  });

  it('digit switches panels with activate/deactivate hooks', () => {
    const panels = [makePanel(), makePanel({ id: 'p2', shortcutKey: 2 })];
    const { ctx, dispatched } = makeCtx({}, { panels, panel: panels[0] });
    handleDashboardInput('2', makeKey(), ctx);
    expect(panels[0].onDeactivate).toHaveBeenCalledOnce();
    expect(panels[1].onActivate).toHaveBeenCalledOnce();
    expect(dispatched).toEqual([{ type: 'SWITCH_PANEL', index: 1 }]);
  });
});

describe('splash screen (hasReceivedEvents=false)', () => {
  it('most keys are gated off', () => {
    const { ctx, dispatched, toggleSessionFilter } = makeCtx({ hasReceivedEvents: false });
    handleDashboardInput('z', makeKey(), ctx);
    handleDashboardInput('/', makeKey(), ctx);
    handleDashboardInput('f', makeKey(), ctx);
    expect(dispatched).toEqual([]);
    expect(toggleSessionFilter).not.toHaveBeenCalled();
  });

  it('digits 1-2 are blocked; higher panels force FIRST_EVENT', () => {
    const panels = [makePanel(), makePanel({ id: 'p2' }), makePanel({ id: 'p3' })];
    const { ctx, dispatched } = makeCtx({ hasReceivedEvents: false }, { panels, panel: panels[0] });
    handleDashboardInput('1', makeKey(), ctx);
    expect(dispatched).toEqual([]);
    handleDashboardInput('3', makeKey(), ctx);
    expect(dispatched).toEqual([
      { type: 'FIRST_EVENT', sessionPrefix: '' },
      { type: 'SWITCH_PANEL', index: 2 },
    ]);
  });

  // CHARACTERIZATION: '?', 'V', 'r', and 'q' run before the splash gate.
  it("'?' and 'q' still work on the splash screen", () => {
    const { ctx, dispatched, exit } = makeCtx({ hasReceivedEvents: false });
    handleDashboardInput('?', makeKey(), ctx);
    expect(dispatched).toEqual([{ type: 'SET_OVERLAY', overlay: 'help' }]);
    handleDashboardInput('q', makeKey(), ctx);
    expect(exit).toHaveBeenCalledOnce();
  });
});

describe('panel keybindings and action shortcuts', () => {
  // CHARACTERIZATION (bug): the global 'f' session filter fires before
  // panel-declared bindings, so a panel's own 'f' binding is unreachable.
  it("global 'f' currently shadows a panel-declared 'f' binding", () => {
    const handler = vi.fn();
    const panels = [
      makePanel({
        bindings: [{ keys: ['f'], label: 'Filter nodes', handler, condition: () => true }],
      }),
    ];
    const { ctx, toggleSessionFilter } = makeCtx(
      {},
      { panels, panel: panels[0], selectedItem: item },
    );
    handleDashboardInput('f', makeKey(), ctx);
    expect(toggleSessionFilter).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  // CHARACTERIZATION (bug): same shadowing class for the global 's'
  // pending-session switch vs a panel's 's' binding.
  it("global 's' currently shadows a panel-declared 's' binding when a pending session exists", () => {
    const handler = vi.fn();
    const onSessionSwitch = vi.fn();
    const panels = [makePanel({ bindings: [{ keys: ['s'], label: 'Sort', handler }] })];
    const { ctx } = makeCtx(
      {},
      { panels, panel: panels[0], pendingSessionPath: '/tmp/s.jsonl', onSessionSwitch },
    );
    handleDashboardInput('s', makeKey(), ctx);
    expect(onSessionSwitch).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it('a panel binding on a free key fires and ticks', () => {
    const handler = vi.fn();
    const panels = [makePanel({ bindings: [{ keys: ['m'], label: 'Mark', handler }] })];
    const { ctx, dispatched } = makeCtx({}, { panels, panel: panels[0], selectedItem: item });
    handleDashboardInput('m', makeKey(), ctx);
    expect(handler).toHaveBeenCalledWith(item);
    expect(dispatched).toEqual([{ type: 'TICK' }]);
  });

  it('a binding whose condition fails falls through to action shortcuts', () => {
    const bindingHandler = vi.fn();
    const actionHandler = vi.fn(() => 'Done');
    const panels = [
      makePanel({
        bindings: [{ keys: ['m'], label: 'Mark', handler: bindingHandler, condition: () => false }],
        actions: [{ key: 'm', label: 'Move', handler: actionHandler }],
      }),
    ];
    const { ctx, addToast } = makeCtx({}, { panels, panel: panels[0], selectedItem: item });
    handleDashboardInput('m', makeKey(), ctx);
    expect(bindingHandler).not.toHaveBeenCalled();
    expect(actionHandler).toHaveBeenCalledWith(item);
    expect(addToast).toHaveBeenCalledWith('Done', 'info');
  });
});

describe('navigation', () => {
  it('side focus: j advances selection and scroll', () => {
    const { ctx, dispatched, sideScroll } = makeCtx(
      {},
      { currentItemCount: 3, clampedSelection: 0 },
    );
    handleDashboardInput('j', makeKey(), ctx);
    expect(dispatched).toEqual([{ type: 'SELECT_ITEM', index: 1 }]);
    expect(sideScroll.selectNext).toHaveBeenCalledOnce();
  });

  it('side focus: j at the last item is a no-op', () => {
    const { ctx, dispatched } = makeCtx({}, { currentItemCount: 3, clampedSelection: 2 });
    handleDashboardInput('j', makeKey(), ctx);
    expect(dispatched).toEqual([]);
  });

  it('side focus: g/G jump to first/last', () => {
    const { ctx, dispatched, sideScroll } = makeCtx(
      {},
      { currentItemCount: 5, clampedSelection: 2 },
    );
    handleDashboardInput('g', makeKey(), ctx);
    handleDashboardInput('G', makeKey(), ctx);
    expect(dispatched).toEqual([
      { type: 'SELECT_ITEM', index: 0 },
      { type: 'SELECT_ITEM', index: 4 },
    ]);
    expect(sideScroll.selectFirst).toHaveBeenCalledOnce();
    expect(sideScroll.selectLast).toHaveBeenCalledOnce();
  });

  it('side focus: enter moves focus to detail', () => {
    const { ctx, dispatched } = makeCtx();
    handleDashboardInput('', makeKey({ return: true }), ctx);
    expect(dispatched).toEqual([{ type: 'SET_FOCUS', target: 'detail' }]);
  });

  it('detail focus: j/k scroll by one line', () => {
    const { ctx, dispatched } = makeCtx(
      { focusTarget: 'detail' },
      { detailLineCount: 40, detailViewportHeight: 10 },
    );
    handleDashboardInput('j', makeKey(), ctx);
    handleDashboardInput('k', makeKey(), ctx);
    expect(dispatched).toEqual([
      { type: 'SCROLL_DETAIL_DELTA', delta: 1, totalLines: 40, viewportHeight: 10 },
      { type: 'SCROLL_DETAIL_DELTA', delta: -1, totalLines: 40, viewportHeight: 10 },
    ]);
  });

  it('detail focus: h returns to side, g/G jump', () => {
    const { ctx, dispatched } = makeCtx(
      { focusTarget: 'detail' },
      { detailLineCount: 40, detailViewportHeight: 10 },
    );
    handleDashboardInput('h', makeKey(), ctx);
    handleDashboardInput('g', makeKey(), ctx);
    handleDashboardInput('G', makeKey(), ctx);
    expect(dispatched).toEqual([
      { type: 'SET_FOCUS', target: 'side' },
      { type: 'SCROLL_DETAIL', offset: 0 },
      { type: 'SCROLL_DETAIL', offset: 30 },
    ]);
  });

  it('tab toggles focus', () => {
    const { ctx, dispatched } = makeCtx();
    handleDashboardInput('', makeKey({ tab: true }), ctx);
    expect(dispatched).toEqual([{ type: 'TOGGLE_FOCUS' }]);
  });
});
