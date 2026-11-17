/**
 * Help overlay showing all keybindings, centered over the dashboard.
 *
 * Rows are sized to the box's real inner width (box − border − padding) and
 * truncated rather than wrapped, so one entry is one row and the windowing
 * below counts correctly. The logo only shows when the terminal is tall
 * enough to keep several key rows visible, and the status bar's row is
 * reserved.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SidePanel } from '../panels/types';
import { LOGO_ART } from '../branding';
import { parseBlessedTags } from './parseBlessedTags';
import { useTerminalSize } from './useTerminalSize';
import { wrapPlainText } from '../plainWrap';
import { displayWidth } from '../blessedText';

interface HelpOverlayProps {
  panels: SidePanel[];
  activePanelIndex: number;
  scrollOffset: number;
  /** Report the real max scroll offset so state can be clamped to content. */
  onClampScroll?: (maxOffset: number) => void;
  /** Terminal rows taken by chrome outside the overlay (the status bar). */
  reservedRows?: number;
  /** The latest data or session-read failure, shown at the top when set. */
  lastError?: string | null;
}

type HelpEntry =
  | { kind: 'heading'; text: string }
  | { kind: 'blank' }
  | { kind: 'text'; text: string }
  | { kind: 'row'; key: string; desc: string };

const KEY_WIDTH = 14;
/** Below this many terminal rows the logo is dropped to make room for keys. */
const LOGO_MIN_ROWS = 30;

/** Build the help entries for the active panel. */
export function buildHelpEntries(
  panels: SidePanel[],
  activePanelIndex: number,
  lastError?: string | null,
  textWidth = 56,
): HelpEntry[] {
  const panel = panels[activePanelIndex];
  const actions = panel.getActions();
  const bindings = panel.getKeybindings?.() || [];
  const entries: HelpEntry[] = [];
  const row = (key: string, desc: string) => entries.push({ kind: 'row', key, desc });
  const heading = (text: string) => entries.push({ kind: 'heading', text });
  const blank = () => entries.push({ kind: 'blank' });

  // What the "⚠" badge in the status bar refers to.
  if (lastError) {
    heading('Last error');
    for (const text of wrapPlainText(lastError, Math.max(10, textWidth - 2))) {
      entries.push({ kind: 'text', text });
    }
    blank();
  }

  heading('Panels');
  for (const p of panels) row(String(p.shortcutKey), p.title);
  blank();

  heading('Navigation');
  row('Tab', 'Toggle side / detail focus');
  row('j / ↓', 'Next item / scroll down');
  row('k / ↑', 'Prev item / scroll up');
  row('PgDn / PgUp', 'Page down / up');
  row('g / G', 'First / last (also Home / End)');
  row('Enter', 'Focus detail pane');
  row('h / ← / Esc', 'Back to the side list');
  row('[ / ]', 'Previous / next detail tab');
  row('z', 'Cycle layout mode');
  row('Mouse', 'Click selects, wheel scrolls (M toggles)');
  blank();

  heading('Filter');
  row('/', 'Filter the side list');
  row('Tab', 'In the filter: cycle the mode');
  row('Enter / Esc', 'Keep / clear the filter');
  row('f', 'Toggle the session filter');
  blank();

  heading(`${panel.title} panel`);
  if (actions.length > 0) row('x', 'Actions menu for the selected item');
  for (const a of actions) row(a.key, a.label);
  for (const b of bindings) {
    row(b.keys.join('/'), b.context ? `${b.label} (${b.context})` : b.label);
  }
  if (actions.length === 0 && bindings.length === 0) row('—', 'No panel-specific keys');
  blank();

  heading('General');
  row('R', 'Refresh project data');
  row('r', 'Generate HTML report');
  row('p', 'Pin session (stop auto-switch)');
  row('s', 'Switch to the newly detected session');
  row('A', 'Accounts: switch / undo');
  row('M', 'Toggle mouse capture (copy/select)');
  row('V', 'Version & changelog');
  row('?', 'Toggle this help');
  row('q / Ctrl+C', 'Quit');
  return entries;
}

/** Fit one key row into `innerWidth` columns with a dot leader. */
export function formatHelpRow(key: string, desc: string, innerWidth: number): string {
  const keyCol = key.padEnd(KEY_WIDTH);
  // "  " + key column + " " + dots + " " + desc
  const fixed = 2 + KEY_WIDTH + 2;
  let description = desc;
  let dots = innerWidth - fixed - displayWidth(description);
  if (dots < 1) {
    const room = Math.max(1, innerWidth - fixed - 1);
    description = description.slice(0, Math.max(0, room - 1)) + '…';
    dots = 1;
  }
  return `  ${keyCol} ${'·'.repeat(dots)} ${description}`;
}

export function HelpOverlay({
  panels,
  activePanelIndex,
  scrollOffset,
  onClampScroll,
  reservedRows = 1,
  lastError = null,
}: HelpOverlayProps): React.ReactElement {
  const { columns, rows: termRows } = useTerminalSize();
  const boxWidth = Math.max(20, Math.min(60, columns - 2));
  const innerWidth = boxWidth - 4; // single border (2) + paddingX (2)
  const entries = buildHelpEntries(panels, activePanelIndex, lastError, innerWidth);
  const showLogo = termRows >= LOGO_MIN_ROWS;

  // Chrome inside the box: border (2) + paddingY (2) + scroll indicators (2),
  // plus the logo and its spacer when shown.
  const chrome = 6 + (showLogo ? LOGO_ART.length + 1 : 0);
  const maxVisible = Math.max(1, termRows - reservedRows - chrome);
  const maxOffset = Math.max(0, entries.length - maxVisible);
  React.useEffect(() => {
    if (scrollOffset > maxOffset) onClampScroll?.(maxOffset);
  }, [scrollOffset, maxOffset, onClampScroll]);
  const offset = Math.min(scrollOffset, maxOffset);
  const visible = entries.slice(offset, offset + maxVisible);
  const canScrollUp = offset > 0;
  const canScrollDown = offset + maxVisible < entries.length;

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="magenta"
        paddingX={1}
        paddingY={1}
        width={boxWidth}
        flexShrink={0}
      >
        {showLogo &&
          LOGO_ART.map((line, i) => (
            <Text key={`logo-${i}`} wrap="truncate-end">
              {parseBlessedTags(line)}
            </Text>
          ))}
        {showLogo && <Text> </Text>}

        <Text dimColor wrap="truncate-end">
          {canScrollUp ? '  ▲ scroll up (k)' : ' '}
        </Text>

        {visible.map((entry, i) => {
          const key = `row-${offset + i}`;
          if (entry.kind === 'blank') return <Text key={key}> </Text>;
          if (entry.kind === 'text') {
            return (
              <Text key={key} color="yellow" wrap="truncate-end">
                {'  '}
                {entry.text}
              </Text>
            );
          }
          if (entry.kind === 'heading') {
            return (
              <Text key={key} bold wrap="truncate-end">
                {' '}
                {entry.text}
              </Text>
            );
          }
          const line = formatHelpRow(entry.key, entry.desc, innerWidth);
          const keyEnd = 2 + KEY_WIDTH;
          const rest = line.slice(keyEnd);
          const leader = rest.match(/^ ·+ /)?.[0] ?? ' ';
          return (
            <Text key={key} wrap="truncate-end">
              <Text bold>{line.slice(0, keyEnd)}</Text>
              <Text dimColor>{leader}</Text>
              {rest.slice(leader.length)}
            </Text>
          );
        })}

        <Text dimColor wrap="truncate-end">
          {canScrollDown ? '  ▼ scroll down (j)' : ' '}
        </Text>
      </Box>
    </Box>
  );
}
