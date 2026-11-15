/**
 * Detail tab bar showing sub-tabs for the selected panel item. The layout
 * comes from `layoutDetailTabs` (shared with mouse hit-testing): every tab
 * when they fit, otherwise the active tab and its position.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DetailTabLayout } from './tabLayout';

interface DetailTabBarProps {
  layout: DetailTabLayout;
}

export function DetailTabBar({ layout }: DetailTabBarProps): React.ReactElement {
  if (layout.spans.length === 0) {
    return <Box height={1} />;
  }

  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate-end">
        {' '}
        {layout.spans.map((span, i) => (
          <React.Fragment key={span.index}>
            {i > 0 ? ' ' : ''}
            {span.active ? (
              <Text bold color="magenta">
                {span.text}
              </Text>
            ) : (
              <Text dimColor>{span.text}</Text>
            )}
          </React.Fragment>
        ))}
        {layout.compact ? <Text dimColor>{`  ${layout.position}`}</Text> : null}
        {layout.hint ? <Text dimColor>{`  ${layout.hint}`}</Text> : null}
      </Text>
    </Box>
  );
}
