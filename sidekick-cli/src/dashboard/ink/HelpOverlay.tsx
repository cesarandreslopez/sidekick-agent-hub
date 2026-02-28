/**
 * Help overlay showing all keybindings, centered over the dashboard.
 * Dot-leader alignment for consistent visual hierarchy.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SidePanel } from '../panels/types';
import { LOGO_ART } from '../branding';
import { parseBlessedTags } from './parseBlessedTags';

interface HelpOverlayProps {
  panels: SidePanel[];
  activePanelIndex: number;
}

/** Render a key-description row with dot-leader fill. */
function helpRow(key: string, desc: string, keyWidth = 14, totalWidth = 54): React.ReactElement {
  const padding = keyWidth - key.length;
  const dotCount = Math.max(1, totalWidth - keyWidth - desc.length);
  const dots = '\u00B7'.repeat(dotCount);
  return (
    <Text>
      {'  '}<Text bold>{key}</Text>{' '.repeat(Math.max(0, padding))} <Text dimColor>{dots}</Text> {desc}
    </Text>
  );
}

export function HelpOverlay({ panels, activePanelIndex }: HelpOverlayProps): React.ReactElement {
  const panel = panels[activePanelIndex];
  const actions = panel.getActions();
  const bindings = panel.getKeybindings?.() || [];

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      paddingX={1}
      paddingY={1}
      width={60}
    >
      {/* Robot Logo */}
      {LOGO_ART.map((line, i) => (
        <Text key={`logo-${i}`}>{parseBlessedTags(line)}</Text>
      ))}
      <Text> </Text>

      {/* Panels */}
      <Text bold>  Panels</Text>
      {panels.map(p => helpRow(String(p.shortcutKey), p.title))}
      <Text> </Text>

      {/* Navigation */}
      <Text bold>  Navigation</Text>
      {helpRow('Tab', 'Toggle side / detail focus')}
      {helpRow('j / \u2193', 'Next item / scroll down')}
      {helpRow('k / \u2191', 'Prev item / scroll up')}
      {helpRow('g / G', 'First / last item')}
      {helpRow('Enter', 'Focus detail pane')}
      {helpRow('h / \u2190', 'Return to side')}
      {helpRow('[ / ]', 'Cycle detail tabs')}
      {helpRow('z', 'Cycle layout mode')}
      <Text> </Text>

      {/* Actions */}
      <Text bold>  Actions</Text>
      {helpRow('x', 'Context menu')}
      {helpRow('/', 'Filter side list')}
      {helpRow('f', 'Toggle session filter')}

      {/* Panel-specific */}
      {(actions.length > 0 || bindings.length > 0) && (
        <>
          <Text> </Text>
          <Text bold>  {panel.title} Actions</Text>
          {actions.map(a => (
            <React.Fragment key={a.key}>{helpRow(a.key, a.label)}</React.Fragment>
          ))}
          {bindings.map(b => (
            <React.Fragment key={b.keys[0]}>{helpRow(b.keys.join('/'), b.label)}</React.Fragment>
          ))}
        </>
      )}

      <Text> </Text>
      <Text bold>  General</Text>
      {helpRow('r', 'Generate HTML report')}
      {helpRow('V', 'Version & changelog')}
      {helpRow('?', 'Toggle this help')}
      {helpRow('Esc', 'Close overlay / clear filter')}
      {helpRow('q / Ctrl+C', 'Quit')}
    </Box>
    </Box>
  );
}
