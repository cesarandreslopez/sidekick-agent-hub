/**
 * Context menu overlay showing available actions for the selected item.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { PanelAction } from '../panels/types';
import { useTerminalSize } from './useTerminalSize';
import { OVERLAY_FILL } from './overlayFill';

interface ContextMenuOverlayProps {
  actions: PanelAction[];
  selectedIndex: number;
}

export function ContextMenuOverlay({
  actions,
  selectedIndex,
}: ContextMenuOverlayProps): React.ReactElement {
  // Hook must run unconditionally, before the empty-actions early return
  const { columns, rows } = useTerminalSize();

  if (actions.length === 0) {
    return <Box />;
  }

  const maxLen = Math.max(...actions.map((a) => a.key.length + a.label.length + 6), 20);
  const width = Math.min(maxLen + 6, 50, columns - 2);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      width={width}
      position="absolute"
      marginLeft={Math.max(0, Math.floor((columns - width) / 2))}
      marginTop={Math.max(0, Math.floor((rows - actions.length - 2) / 2))}
      backgroundColor={OVERLAY_FILL}
    >
      <Text color="magenta"> Actions </Text>
      {actions.map((a, i) => (
        <Box key={a.key}>
          {/* A pointer as well as inverse video, which NO_COLOR removes. */}
          <Text inverse={i === selectedIndex} wrap="truncate-end">
            {i === selectedIndex ? ' \u25B8 ' : '   '}
            <Text bold>{a.key}</Text> {a.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
