/**
 * Context menu overlay showing available actions for the selected item.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { PanelAction } from '../panels/types';

interface ContextMenuOverlayProps {
  actions: PanelAction[];
  selectedIndex: number;
}

export function ContextMenuOverlay({ actions, selectedIndex }: ContextMenuOverlayProps): React.ReactElement {
  if (actions.length === 0) {
    return <Box />;
  }

  const maxLen = Math.max(...actions.map(a => a.key.length + a.label.length + 4), 20);
  const width = Math.min(maxLen + 6, 50);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      width={width}
      position="absolute"
      marginLeft={Math.floor((process.stdout.columns - width) / 2)}
      marginTop={Math.floor((process.stdout.rows - actions.length - 2) / 2)}
    >
      <Text color="magenta"> Actions </Text>
      {actions.map((a, i) => (
        <Box key={a.key}>
          {i === selectedIndex ? (
            <Text inverse> <Text bold>{a.key}</Text>  {a.label}</Text>
          ) : (
            <Text> <Text bold>{a.key}</Text>  {a.label}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
