/**
 * Detail tab bar showing sub-tabs for the selected panel item.
 * Active tab highlighted with magenta.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DetailTab } from '../panels/types';

interface DetailTabBarProps {
  tabs: DetailTab[];
  activeIndex: number;
}

export function DetailTabBar({ tabs, activeIndex }: DetailTabBarProps): React.ReactElement {
  if (tabs.length === 0) {
    return <Box height={1} />;
  }

  return (
    <Box height={1}>
      <Text> </Text>
      {tabs.map((tab, i) => (
        <Box key={tab.label} marginRight={1}>
          {i === activeIndex ? (
            <Text bold color="magenta">▸ {tab.label}</Text>
          ) : (
            <Text color="gray">  {tab.label}</Text>
          )}
        </Box>
      ))}
      {tabs.length > 1 && (
        <Text color="gray">  ← [ ] →</Text>
      )}
    </Box>
  );
}
