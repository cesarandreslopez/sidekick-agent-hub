/**
 * Side panel list (left pane) with bordered container,
 * windowed scrolling, and selection highlight.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { PanelItem } from '../panels/types';
import { parseBlessedTags } from './parseBlessedTags';

const TAG_RE = /\{\/?\w[\w-]*\}/g;

/** Truncate a blessed-tagged string to maxVisible visible characters. */
function truncateTaggedLabel(label: string, maxVisible: number): string {
  const stripped = label.replace(TAG_RE, '');
  if (stripped.length <= maxVisible) return label;

  // Walk the label, counting visible chars, and cut when we hit the limit
  let visible = 0;
  let cutIndex = label.length;
  let i = 0;
  while (i < label.length) {
    if (label[i] === '{') {
      const close = label.indexOf('}', i);
      if (close !== -1) { i = close + 1; continue; }
    }
    visible++;
    if (visible >= maxVisible - 1) { cutIndex = i + 1; break; }
    i++;
  }
  // Close any open blessed tags by appending a reset — but since parseBlessedTags
  // handles unclosed tags gracefully, just truncate and add ellipsis
  return label.substring(0, cutIndex) + '\u2026';
}

interface SideListProps {
  items: PanelItem[];
  selectedIndex: number;
  scrollOffset: number;
  focused: boolean;
  width: number;
  viewportHeight: number;
  panelTitle: string;
}

export function SideList({
  items,
  selectedIndex,
  scrollOffset,
  focused,
  width,
  viewportHeight,
  panelTitle,
}: SideListProps): React.ReactElement {
  const borderColor = focused ? 'magenta' : 'gray';
  // Inner width minus border (2) and padding (1)
  const innerWidth = Math.max(1, width - 3);

  // Windowed slice
  const visibleItems = items.slice(scrollOffset, scrollOffset + viewportHeight);
  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + viewportHeight < items.length;

  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      overflow="hidden"
    >
      {/* Label */}
      <Box>
        <Text color={borderColor}> {panelTitle} ({items.length}) </Text>
      </Box>

      {/* Scroll indicator top */}
      {hasMoreAbove && (
        <Box justifyContent="center" width={innerWidth}>
          <Text color="gray">▲</Text>
        </Box>
      )}

      {/* Items */}
      {visibleItems.map((item, i) => {
        const realIndex = scrollOffset + i;
        const isSelected = realIndex === selectedIndex;
        const marker = isSelected ? '▸' : ' ';
        const label = truncateTaggedLabel(item.label, innerWidth - 2);

        return (
          <Box key={item.id} width={innerWidth}>
            {isSelected ? (
              <Text inverse>
                <Text bold>{marker}</Text> {parseBlessedTags(label)}
              </Text>
            ) : (
              <Text>
                {marker} {parseBlessedTags(label)}
              </Text>
            )}
          </Box>
        );
      })}

      {/* Fill remaining space */}
      {visibleItems.length < viewportHeight &&
        Array.from({ length: viewportHeight - visibleItems.length }, (_, i) => (
          <Box key={`empty-${i}`} width={innerWidth}>
            <Text> </Text>
          </Box>
        ))}

      {/* Scroll indicator bottom */}
      {hasMoreBelow && (
        <Box justifyContent="center" width={innerWidth}>
          <Text color="gray">▼</Text>
        </Box>
      )}
    </Box>
  );
}
