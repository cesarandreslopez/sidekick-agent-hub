/**
 * Tab bar showing panel shortcuts. The layout (full titles, abbreviations or
 * digits, and whether the layout-mode label fits) comes from `layoutTopTabs`,
 * which the mouse hit-testing reads too. The active panel is marked with `▸`
 * as well as colour.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TopTabLayout } from './tabLayout';

interface TabBarProps {
  layout: TopTabLayout;
}

export function TabBar({ layout }: TabBarProps): React.ReactElement {
  return (
    <Box height={1} width="100%" overflow="hidden">
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          {layout.spans.map((span, i) => (
            <React.Fragment key={span.index}>
              {i > 0 ? ' ' : ''}
              {span.active ? (
                <Text bold underline color="magenta">
                  {span.text}
                </Text>
              ) : (
                <Text dimColor>{span.text}</Text>
              )}
            </React.Fragment>
          ))}
        </Text>
      </Box>
      {layout.showMode && (
        <Box flexShrink={0}>
          <Text dimColor>{layout.modeText}</Text>
        </Box>
      )}
    </Box>
  );
}
