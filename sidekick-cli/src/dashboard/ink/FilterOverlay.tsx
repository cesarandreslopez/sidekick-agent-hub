/**
 * Filter overlay shown at the bottom of the screen.
 * Captures keystrokes for live text filtering.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface FilterOverlayProps {
  filterString: string;
}

export function FilterOverlay({ filterString }: FilterOverlayProps): React.ReactElement {
  return (
    <Box
      position="absolute"
      marginTop={process.stdout.rows - 2}
      width="100%"
      height={1}
    >
      <Text bold color="magenta"> / </Text>
      <Text>{filterString}</Text>
      <Text color="gray">█</Text>
    </Box>
  );
}
