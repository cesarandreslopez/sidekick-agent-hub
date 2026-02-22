/**
 * Tab bar showing panel shortcuts: [1] Sessions  [2] Tasks  ...
 * Active panel highlighted with magenta.
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

const MODE_COLORS: Record<string, string> = {
  normal: 'gray',
  expanded: 'cyan',
  'wide-side': 'yellow',
};

export function TabBar({ panels, activeIndex, layoutMode }: TabBarProps): React.ReactElement {
  const modeLabel = MODE_LABELS[layoutMode] || layoutMode;
  const modeColor = MODE_COLORS[layoutMode] || 'gray';

  return (
    <Box height={1} width="100%">
      <Box flexGrow={1}>
        {panels.map((p, i) => (
          <Box key={p.id} marginRight={1}>
            {i === activeIndex ? (
              <Text bold color="magenta">[{p.shortcutKey}] {p.title}</Text>
            ) : (
              <Text color="gray">[{p.shortcutKey}] {p.title}</Text>
            )}
          </Box>
        ))}
      </Box>
      <Box>
        <Text color={modeColor}>z: {modeLabel} ▸</Text>
      </Box>
    </Box>
  );
}
