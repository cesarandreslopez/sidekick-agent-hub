/**
 * Core interfaces for the lazydocker-style panel TUI.
 * All panels implement SidePanel to provide items, actions, and detail tabs.
 */

import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';

/** An item displayed in the side panel list. */
export interface PanelItem {
  id: string;
  label: string; // blessed-tagged string for display
  sortKey: number; // lower = higher in list
  data: unknown; // underlying domain object
}

/** An action available for the selected item (shown in context menu and as keybinding). */
export interface PanelAction {
  key: string; // single char shortcut
  label: string; // display label (e.g. "Mark completed")
  /** Return a string to show it as a toast notification. */
  handler: (item: PanelItem) => string | void;
  /** If provided, action only appears when this returns true. */
  condition?: (item: PanelItem) => boolean;
}

/** A keybinding declared by a panel or globally. */
export interface KeyBinding {
  /** Key(s) that trigger this binding (blessed key names). */
  keys: string[];
  /** Display label for help overlay (e.g. "Mark completed"). */
  label: string;
  /** Category for help grouping ("navigation", "actions", "general"). */
  category?: string;
  /** Handler function. */
  handler: (item?: PanelItem) => void;
  /** If provided, binding only active when this returns true. */
  condition?: (item?: PanelItem) => boolean;
}

/** Layout context passed to detail renderers. */
export interface DetailRenderContext {
  /** Usable content columns of the detail pane for the current layout mode. */
  width: number;
}

/** A tab in the detail pane for a selected item. */
export interface DetailTab {
  label: string;
  /**
   * Render blessed-tagged content for the given item. `ctx` carries the
   * live detail-pane width; renderers fall back to the legacy full-terminal
   * estimate when it is absent.
   */
  render: (
    item: PanelItem,
    metrics: DashboardMetrics,
    staticData: StaticData,
    ctx?: DetailRenderContext,
  ) => string;
  /** If true, detail pane scrolls to bottom after render. */
  autoScrollBottom?: boolean;
}

/** A panel that populates the side list and detail pane. */
export interface SidePanel {
  /** Unique panel identifier. */
  readonly id: string;
  /** Display title shown in tab bar. */
  readonly title: string;
  /** Number key shortcut (1-5). */
  readonly shortcutKey: number;
  /** Detail tabs for the selected item. */
  readonly detailTabs: DetailTab[];
  /** Hint shown in side list when no items are available. */
  readonly emptyStateHint?: string;
  /**
   * Optional counter a panel bumps whenever its own view state (a cycled
   * view mode, a filter, async text) changes, so the dashboard can memoise
   * items and detail rendering on it together with the metrics identity.
   */
  readonly viewVersion?: number;

  /** Build the list of items to display. */
  getItems(metrics: DashboardMetrics, staticData: StaticData): PanelItem[];

  /** Get available actions (shown in context menu via `x`). */
  getActions(): PanelAction[];

  /** Optional: panel-specific keybindings (auto-registered when panel is active). */
  getKeybindings?(): KeyBinding[];

  /** Optional: return full searchable text for an item (used by / filter and s search). */
  getSearchableText?(item: PanelItem): string;

  /**
   * Optional: epoch-ms timestamp for an item, used by the Date filter mode.
   * Panels whose item `data` wraps the domain record in an envelope (so the
   * timestamp is not a top-level `createdAt`/`timestamp`) must implement this;
   * panels that expose the raw record as `data` rely on the generic
   * `itemTimestampMs` fallback. Return null when the item has no timestamp.
   */
  getItemTimestamp?(item: PanelItem): number | null;

  /** Optional: extra status hints for this panel. */
  getStatusHints?(): string;

  /** Optional: called when the panel is activated (e.g. to set up search state). */
  onActivate?(): void;

  /** Optional: called when the panel is deactivated. */
  onDeactivate?(): void;

  /** Optional cleanup. */
  dispose?(): void;
}
