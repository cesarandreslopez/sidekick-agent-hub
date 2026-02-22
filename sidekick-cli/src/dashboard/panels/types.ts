/**
 * Core interfaces for the lazydocker-style panel TUI.
 * All panels implement SidePanel to provide items, actions, and detail tabs.
 */

import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';

/** An item displayed in the side panel list. */
export interface PanelItem {
  id: string;
  label: string;        // blessed-tagged string for display
  sortKey: number;       // lower = higher in list
  data: unknown;         // underlying domain object
}

/** An action available for the selected item (shown in context menu and as keybinding). */
export interface PanelAction {
  key: string;           // single char shortcut
  label: string;         // display label (e.g. "Mark completed")
  handler: (item: PanelItem) => void;
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

/** A tab in the detail pane for a selected item. */
export interface DetailTab {
  label: string;
  /** Render blessed-tagged content for the given item. */
  render: (item: PanelItem, metrics: DashboardMetrics, staticData: StaticData) => string;
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

  /** Build the list of items to display. */
  getItems(metrics: DashboardMetrics, staticData: StaticData): PanelItem[];

  /** Get available actions (shown in context menu via `x`). */
  getActions(): PanelAction[];

  /** Optional: panel-specific keybindings (auto-registered when panel is active). */
  getKeybindings?(): KeyBinding[];

  /** Optional: return full searchable text for an item (used by / filter and s search). */
  getSearchableText?(item: PanelItem): string;

  /** Optional: extra status hints for this panel. */
  getStatusHints?(): string;

  /** Optional: called when the panel is activated (e.g. to set up search state). */
  onActivate?(): void;

  /** Optional: called when the panel is deactivated. */
  onDeactivate?(): void;

  /** Optional cleanup. */
  dispose?(): void;
}
