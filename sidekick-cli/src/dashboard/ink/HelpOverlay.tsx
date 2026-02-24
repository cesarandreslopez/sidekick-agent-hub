/**
 * Help overlay showing all keybindings, centered over the dashboard.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SidePanel } from '../panels/types';

interface HelpOverlayProps {
  panels: SidePanel[];
  activePanelIndex: number;
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
      {/* Logo */}
      <Text>          <Text color="yellow">⚡</Text></Text>
      <Text>          <Text color="magenta">│</Text></Text>
      <Text>  <Text color="white">{'</>'}</Text>  <Text color="white">╭──┴──╮</Text>   <Text bold color="magenta">S I D E K I C K</Text></Text>
      <Text>       <Text color="white">│</Text> <Text color="cyan">●</Text> <Text color="cyan">●</Text> <Text color="white">│</Text>   <Text bold>Agent Hub</Text></Text>
      <Text>       <Text color="white">│</Text>  <Text color="green">◡</Text>  <Text color="white">│</Text>   <Text color="gray">Terminal Dashboard</Text></Text>
      <Text>       <Text color="white">╰─────╯</Text></Text>
      <Text> </Text>

      {/* Panels */}
      <Text bold>  Panels</Text>
      {panels.map(p => (
        <Text key={p.id}>  <Text bold>{p.shortcutKey}</Text>           {p.title}</Text>
      ))}
      <Text> </Text>

      {/* Navigation */}
      <Text bold>  Navigation</Text>
      <Text>  <Text bold>Tab</Text>            Toggle side ↔ detail focus</Text>
      <Text>  <Text bold>j / ↓</Text>          Next item (side) / scroll (detail)</Text>
      <Text>  <Text bold>k / ↑</Text>          Prev item (side) / scroll (detail)</Text>
      <Text>  <Text bold>g / G</Text>           First / last item</Text>
      <Text>  <Text bold>Enter</Text>          Focus detail pane</Text>
      <Text>  <Text bold>h / ←</Text>          Return to side</Text>
      <Text>  <Text bold>[ / ]</Text>          Cycle detail tabs</Text>
      <Text>  <Text bold>z</Text>              Cycle layout mode</Text>
      <Text> </Text>

      {/* Actions */}
      <Text bold>  Actions</Text>
      <Text>  <Text bold>x</Text>              Context menu</Text>
      <Text>  <Text bold>/</Text>              Filter side list</Text>
      <Text>  <Text bold>f</Text>              Toggle session filter</Text>

      {/* Panel-specific */}
      {(actions.length > 0 || bindings.length > 0) && (
        <>
          <Text> </Text>
          <Text bold>  {panel.title} Actions</Text>
          {actions.map(a => (
            <Text key={a.key}>  <Text bold>{a.key}</Text>              {a.label}</Text>
          ))}
          {bindings.map(b => (
            <Text key={b.keys[0]}>  <Text bold>{b.keys.join('/')}</Text>              {b.label}</Text>
          ))}
        </>
      )}

      <Text> </Text>
      <Text bold>  General</Text>
      <Text>  <Text bold>V</Text>              Version & changelog</Text>
      <Text>  <Text bold>?</Text>              Toggle this help</Text>
      <Text>  <Text bold>Esc</Text>            Close overlay / clear filter / back</Text>
      <Text>  <Text bold>q / Ctrl+C</Text>     Quit</Text>
    </Box>
    </Box>
  );
}
