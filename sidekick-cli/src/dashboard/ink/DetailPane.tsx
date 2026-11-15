/**
 * Detail pane (right side) with bordered container and windowed content scrolling.
 *
 * Content arrives pre-wrapped into physical rows (see `wrapTaggedLines`), so
 * one entry is exactly one terminal row: scrolling, the "more" indicators and
 * the pane height all count the same thing. Each row is still truncated at
 * the pane edge as a safety net, and an empty row renders as a blank row
 * rather than collapsing to zero height.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { parseBlessedTags } from './parseBlessedTags';
import { clampDetailScroll } from './detailScroll';

interface DetailPaneProps {
  /** Pre-wrapped rows, each no wider than the pane's content width. */
  rows: string[];
  scrollOffset: number;
  viewportHeight: number;
  focused: boolean;
}

export function DetailPane({
  rows,
  scrollOffset,
  viewportHeight,
  focused,
}: DetailPaneProps): React.ReactElement {
  const borderColor = focused ? 'magenta' : undefined;
  const borderStyle = focused ? 'double' : 'single';

  const totalLines = rows.length === 1 && rows[0] === '' ? 0 : rows.length;
  const offset = clampDetailScroll(scrollOffset, totalLines, viewportHeight);
  const hasMoreAbove = offset > 0;
  // Pre-compute whether we need indicator space to avoid content overflow
  const indicatorAbove = hasMoreAbove ? 1 : 0;
  const worstCaseBelow = totalLines > offset + viewportHeight - indicatorAbove ? 1 : 0;
  const effectiveHeight = Math.max(1, viewportHeight - indicatorAbove - worstCaseBelow);
  const visibleLines = rows.slice(offset, offset + effectiveHeight).slice(0, totalLines);
  const hasMoreBelow = offset + effectiveHeight < totalLines;

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      minWidth={0}
      borderStyle={borderStyle}
      borderColor={borderColor}
      borderDimColor={!focused}
      paddingLeft={1}
      overflow="hidden"
    >
      {/* Scroll indicator top */}
      {hasMoreAbove && (
        <Box justifyContent="center">
          <Text dimColor wrap="truncate-end">
            ▲ ({offset} more)
          </Text>
        </Box>
      )}

      {/* Content lines */}
      {visibleLines.map((line, i) => (
        <Text key={offset + i} wrap="truncate-end">
          {parseBlessedTags(line) ?? ' '}
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
          <Text dimColor wrap="truncate-end">
            ▼ ({totalLines - offset - effectiveHeight} more)
          </Text>
        </Box>
      )}
    </Box>
  );
}
