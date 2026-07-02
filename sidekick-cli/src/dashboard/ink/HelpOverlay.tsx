/**
 * Help overlay showing all keybindings, centered over the dashboard.
 * Dot-leader alignment for consistent visual hierarchy. Content rows are
 * windowed (same mechanism as ChangelogOverlay) so the overlay stays usable
 * near the 15-row minimum terminal height.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SidePanel } from '../panels/types';
import { LOGO_ART } from '../branding';
import { parseBlessedTags } from './parseBlessedTags';
import { useTerminalSize } from './useTerminalSize';

interface HelpOverlayProps {
  panels: SidePanel[];
  activePanelIndex: number;
  scrollOffset: number;
}

/** Render a key-description row with dot-leader fill. */
function helpRow(key: string, desc: string, keyWidth = 14, totalWidth = 54): React.ReactElement {
  const padding = keyWidth - key.length;
  const dotCount = Math.max(1, totalWidth - keyWidth - desc.length);
  const dots = '·'.repeat(dotCount);
  return (
    <Text>
      {'  '}
      <Text bold>{key}</Text>
      {' '.repeat(Math.max(0, padding))} <Text dimColor>{dots}</Text> {desc}
    </Text>
  );
}

export function HelpOverlay({
  panels,
  activePanelIndex,
  scrollOffset,
}: HelpOverlayProps): React.ReactElement {
  const { columns, rows: termRows } = useTerminalSize();
  const panel = panels[activePanelIndex];
  const actions = panel.getActions();
  const bindings = panel.getKeybindings?.() || [];

  // Flat list of content rows (everything below the fixed logo header)
  const rows: React.ReactElement[] = [];

  rows.push(<Text bold> Panels</Text>);
  for (const p of panels) rows.push(helpRow(String(p.shortcutKey), p.title));
  rows.push(<Text> </Text>);

  rows.push(<Text bold> Navigation</Text>);
  rows.push(helpRow('Tab', 'Toggle side / detail focus'));
  rows.push(helpRow('j / ↓', 'Next item / scroll down'));
  rows.push(helpRow('k / ↑', 'Prev item / scroll up'));
  rows.push(helpRow('g / G', 'First / last item'));
  rows.push(helpRow('Enter', 'Focus detail pane'));
  rows.push(helpRow('h / ←', 'Return to side'));
  rows.push(helpRow('[ / ]', 'Cycle detail tabs'));
  rows.push(helpRow('z', 'Cycle layout mode'));
  rows.push(<Text> </Text>);

  rows.push(<Text bold> Actions</Text>);
  rows.push(helpRow('x', 'Context menu'));
  rows.push(helpRow('/', 'Filter side list'));
  rows.push(helpRow('f', 'Toggle session filter'));

  if (actions.length > 0 || bindings.length > 0) {
    rows.push(<Text> </Text>);
    rows.push(<Text bold> {panel.title} Actions</Text>);
    for (const a of actions) rows.push(helpRow(a.key, a.label));
    for (const b of bindings) rows.push(helpRow(b.keys.join('/'), b.label));
  }

  rows.push(<Text> </Text>);
  rows.push(<Text bold> General</Text>);
  rows.push(helpRow('r', 'Generate HTML report'));
  rows.push(helpRow('M', 'Toggle mouse capture (copy/select)'));
  rows.push(helpRow('V', 'Version & changelog'));
  rows.push(helpRow('?', 'Toggle this help'));
  rows.push(helpRow('Esc', 'Close overlay / clear filter'));
  rows.push(helpRow('q / Ctrl+C', 'Quit'));

  // Window the rows: border(2) + paddingY(2) + logo(5) + spacer(1) +
  // scroll indicators(2) of chrome around the content.
  const maxVisible = Math.max(5, termRows - 12);
  const maxOffset = Math.max(0, rows.length - maxVisible);
  const offset = Math.min(scrollOffset, maxOffset);
  const visible = rows.slice(offset, offset + maxVisible);
  const canScrollUp = offset > 0;
  const canScrollDown = offset + maxVisible < rows.length;

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="magenta"
        paddingX={1}
        paddingY={1}
        width={Math.min(60, columns - 2)}
      >
        {/* Logo */}
        {LOGO_ART.map((line, i) => (
          <Text key={`logo-${i}`}>{parseBlessedTags(line)}</Text>
        ))}
        <Text> </Text>

        {canScrollUp ? <Text color="gray">{'  ▲ scroll up (k)'}</Text> : <Text> </Text>}

        {visible.map((row, i) => (
          <React.Fragment key={`row-${offset + i}`}>{row}</React.Fragment>
        ))}

        {canScrollDown ? <Text color="gray">{'  ▼ scroll down (j)'}</Text> : <Text> </Text>}
      </Box>
    </Box>
  );
}
