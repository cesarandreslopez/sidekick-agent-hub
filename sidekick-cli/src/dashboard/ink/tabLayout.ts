/**
 * Column layout for the dashboard's two tab bars.
 *
 * The renderers and the mouse hit-testing both read these spans, so a click
 * lands on exactly the tab drawn under it at every terminal width. Widths are
 * display columns.
 */

import { displayWidth } from '../blessedText';

export interface TabSpan {
  /** Index into the source list. */
  index: number;
  /** First column of the span (relative to the bar's origin). */
  start: number;
  /** One past the last column. */
  end: number;
  text: string;
  active: boolean;
}

export interface TopTabSource {
  shortcutKey: string | number;
  title: string;
  /** Abbreviation for narrow terminals ("Sess", "Evt"). */
  shortTitle?: string;
}

export type TopTabTier = 'full' | 'short' | 'digits';

export interface TopTabLayout {
  tier: TopTabTier;
  spans: TabSpan[];
  /** Total width of the spans and their separators. */
  width: number;
  /** Whether the `z: <layout> ▸` mode label fits on the right. */
  showMode: boolean;
  modeText: string;
}

/** Below this width the layout-mode label is dropped from the tab bar. */
export const MODE_LABEL_MIN_COLUMNS = 100;

/**
 * The active tab carries a `▸` marker as well as colour, so it reads without
 * colour (NO_COLOR, --no-color, monochrome terminals).
 */
function topTabText(tab: TopTabSource, active: boolean, tier: TopTabTier): string {
  const marker = active ? '▸' : ' ';
  if (active) return `${marker}${tab.shortcutKey} ${tab.title}`;
  if (tier === 'full') return `${marker}${tab.shortcutKey} ${tab.title}`;
  if (tier === 'short') {
    const short = tab.shortTitle ?? tab.title.slice(0, 4);
    return `${marker}${tab.shortcutKey} ${short}`;
  }
  return `${marker}${tab.shortcutKey}`;
}

function spansFor(texts: Array<{ text: string; active: boolean }>, origin: number): TabSpan[] {
  const spans: TabSpan[] = [];
  let column = origin;
  texts.forEach(({ text, active }, index) => {
    if (index > 0) column += 1; // one-space separator
    const width = displayWidth(text);
    spans.push({ index, start: column, end: column + width, text, active });
    column += width;
  });
  return spans;
}

/**
 * Lay out the panel tab bar in the widest tier that fits: full titles, then
 * abbreviations, then digits only (the active tab always keeps its title).
 */
export function layoutTopTabs(
  tabs: TopTabSource[],
  activeIndex: number,
  columns: number,
  modeLabel = 'Normal',
): TopTabLayout {
  const modeText = `z: ${modeLabel} ▸`;
  let chosen: { tier: TopTabTier; spans: TabSpan[] } | null = null;
  for (const tier of ['full', 'short', 'digits'] as const) {
    const spans = spansFor(
      tabs.map((tab, i) => ({
        text: topTabText(tab, i === activeIndex, tier),
        active: i === activeIndex,
      })),
      0,
    );
    const width = spans.length > 0 ? spans[spans.length - 1].end : 0;
    if (width <= columns || tier === 'digits') {
      chosen = { tier, spans };
      break;
    }
  }
  const spans = chosen!.spans;
  const width = spans.length > 0 ? spans[spans.length - 1].end : 0;
  const showMode =
    columns >= MODE_LABEL_MIN_COLUMNS && width + 1 + displayWidth(modeText) <= columns;
  return { tier: chosen!.tier, spans, width, showMode, modeText };
}

/** Index of the top tab drawn at column `x`, or null. */
export function topTabIndexAtColumn(x: number, layout: TopTabLayout): number | null {
  const span = layout.spans.find((s) => x >= s.start && x < s.end);
  return span ? span.index : null;
}

export interface DetailTabLayout {
  /** Full form shows every tab; compact shows the active one and its position. */
  compact: boolean;
  /** Clickable tabs (every tab in the full form, only the active one when compact). */
  spans: TabSpan[];
  /** `2/7` position marker shown in the compact form. */
  position: string;
  /** The `[ ] tabs` hint, or '' when it does not fit. */
  hint: string;
}

export const DETAIL_TAB_HINT = '[ ] tabs';

/**
 * Lay out the detail tab bar for a bar `width` columns wide. Tabs start one
 * column in. When every label does not fit, the bar falls back to the active
 * label plus its position (`▸ Timeline  2/7`), so the active tab never
 * disappears.
 */
export function layoutDetailTabs(
  labels: string[],
  activeIndex: number,
  width: number,
): DetailTabLayout {
  if (labels.length === 0) return { compact: false, spans: [], position: '', hint: '' };
  const origin = 1;
  // Active and inactive tabs are the same width, so a click target never
  // shifts as the selection moves.
  const full = spansFor(
    labels.map((label, i) => ({
      text: i === activeIndex ? `▸ ${label}` : `  ${label}`,
      active: i === activeIndex,
    })),
    origin,
  );
  const fullEnd = full[full.length - 1].end;
  const hintText = labels.length > 1 ? `  ${DETAIL_TAB_HINT}` : '';
  if (fullEnd <= width) {
    return {
      compact: false,
      spans: full,
      position: '',
      hint: hintText && fullEnd + displayWidth(hintText) <= width ? DETAIL_TAB_HINT : '',
    };
  }

  const active = Math.max(0, Math.min(activeIndex, labels.length - 1));
  const position = `${active + 1}/${labels.length}`;
  const positionText = `  ${position}`;
  let label = labels[active];
  const maxLabel = Math.max(1, width - origin - 2 - displayWidth(positionText));
  if (displayWidth(label) > maxLabel) label = label.slice(0, Math.max(1, maxLabel - 1)) + '…';
  const text = `▸ ${label}`;
  const span: TabSpan = {
    index: active,
    start: origin,
    end: origin + displayWidth(text),
    text,
    active: true,
  };
  const used = span.end + displayWidth(positionText);
  return {
    compact: true,
    spans: [span],
    position,
    hint: hintText && used + displayWidth(hintText) <= width ? DETAIL_TAB_HINT : '',
  };
}

/** Index of the detail tab drawn at column `x` (relative to the bar), or null. */
export function detailTabIndexAtColumn(x: number, layout: DetailTabLayout): number | null {
  const span = layout.spans.find((s) => x >= s.start && x < s.end);
  return span ? span.index : null;
}
