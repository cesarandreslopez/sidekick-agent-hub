/**
 * Overlay shown when the terminal is below minimum dimensions.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface TooSmallOverlayProps {
  columns: number;
  rows: number;
}

export function TooSmallOverlay({ columns, rows }: TooSmallOverlayProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      justifyContent="center"
      alignItems="center"
    >
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="red"
        paddingX={2}
        paddingY={1}
      >
        <Text color="red">Terminal too small</Text>
        <Text color="gray">Need at least 60x15 (current: {columns}x{rows})</Text>
      </Box>
    </Box>
  );
}
