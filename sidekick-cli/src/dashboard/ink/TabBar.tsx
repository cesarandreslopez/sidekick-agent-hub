/**
 * Tab bar showing panel shortcuts with clean styling.
 * Active panel underlined in magenta, inactive tabs dimmed.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SidePanel } from '../panels/types';

interface TabBarProps {
  panels: SidePanel[];
  activeIndex: number;
  layoutMode: string;
}

const MODE_LABELS: Record<string, string> = {
  normal: 'Normal',
  expanded: 'Expanded',
  'wide-side': 'Wide Side',
};

export function TabBar({ panels, activeIndex, layoutMode }: TabBarProps): React.ReactElement {
  const modeLabel = MODE_LABELS[layoutMode] || layoutMode;

  return (
    <Box height={1} width="100%">
      <Box flexGrow={1}>
        {panels.map((p, i) => (
          <Box key={p.id} marginRight={1}>
            {i === activeIndex ? (
              <Text bold underline color="magenta">{p.shortcutKey} {p.title}</Text>
            ) : (
              <><Text dimColor>{p.shortcutKey}</Text><Text color="gray"> {p.title}</Text></>
            )}
          </Box>
        ))}
      </Box>
      <Box>
        <Text dimColor>z: {modeLabel} {'\u25B8'}</Text>
      </Box>
    </Box>
  );
}
