/**
 * Detail pane (right side) with bordered container and windowed content scrolling.
 * Renders blessed-tagged content converted to Ink nodes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { parseBlessedTags } from './parseBlessedTags';

interface DetailPaneProps {
  content: string;
  scrollOffset: number;
  viewportHeight: number;
  focused: boolean;
}

export function DetailPane({
  content,
  scrollOffset,
  viewportHeight,
  focused,
}: DetailPaneProps): React.ReactElement {
  const borderColor = focused ? 'magenta' : 'gray';

  const lines = content ? content.split('\n') : [];
  const totalLines = lines.length;
  const hasMoreAbove = scrollOffset > 0;
  // Pre-compute whether we need indicator space to avoid content overflow
  const indicatorAbove = hasMoreAbove ? 1 : 0;
  const worstCaseBelow = totalLines > scrollOffset + viewportHeight - 1 ? 1 : 0;
  const effectiveHeight = Math.max(1, viewportHeight - indicatorAbove - worstCaseBelow);
  const visibleLines = lines.slice(scrollOffset, scrollOffset + effectiveHeight);
  const hasMoreBelow = scrollOffset + effectiveHeight < totalLines;

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="single"
      borderColor={borderColor}
      paddingLeft={1}
    >
      {/* Scroll indicator top */}
      {hasMoreAbove && (
        <Box justifyContent="center">
          <Text color="gray">▲ ({scrollOffset} more)</Text>
        </Box>
      )}

      {/* Content lines */}
      {visibleLines.map((line, i) => (
        <Text key={scrollOffset + i} wrap="truncate">
          {parseBlessedTags(line)}
        </Text>
      ))}

      {/* Fill remaining space */}
      {visibleLines.length < effectiveHeight &&
        Array.from({ length: effectiveHeight - visibleLines.length }, (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ))}

      {/* Scroll indicator bottom */}
      {hasMoreBelow && (
        <Box justifyContent="center">
          <Text color="gray">▼ ({totalLines - scrollOffset - viewportHeight} more)</Text>
        </Box>
      )}
    </Box>
  );
}
