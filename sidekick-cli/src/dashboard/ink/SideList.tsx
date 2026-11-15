/**
 * Side panel list (left pane) with bordered container,
 * windowed scrolling, and selection highlight.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { PanelItem } from '../panels/types';
import { parseBlessedTags } from './parseBlessedTags';
import { tokenizeTagged, truncateTagged, wrapTaggedLines } from '../blessedText';

/** Truncate a blessed-tagged label to maxVisible terminal columns. */
function truncateTaggedLabel(label: string, maxVisible: number): string {
  return truncateTagged(label, Math.max(1, maxVisible));
}

interface SideListProps {
  items: PanelItem[];
  selectedIndex: number;
  scrollOffset: number;
  focused: boolean;
  width: number;
  viewportHeight: number;
  panelTitle: string;
  sessionFilterActive?: boolean;
  emptyStateHint?: string;
  /** Active filter string for search-term highlighting. */
  filterString?: string;
}

function escapeBraces(text: string): string {
  return text.replace(/[{}]/g, (brace) => (brace === '{' ? '{open}' : '{close}'));
}

/** Apply search-term highlighting to a blessed-tagged label. */
function applySearchHighlight(label: string, filterString: string): string {
  if (!filterString) return label;
  // Escape regex special chars in the search string
  const escaped = filterString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern: RegExp;
  try {
    pattern = new RegExp(`(${escaped})`, 'gi');
  } catch {
    return label;
  }
  // Highlight only inside text runs, never inside a tag.
  return tokenizeTagged(label)
    .map((token) => {
      if (token.kind !== 'text') return token.raw;
      return token.text
        .split(pattern)
        .map((part, i) =>
          i % 2 === 1
            ? `{blue-bg}{white-fg}${escapeBraces(part)}{/white-fg}{/blue-bg}`
            : escapeBraces(part),
        )
        .join('');
    })
    .join('');
}

export function SideList({
  items,
  selectedIndex,
  scrollOffset,
  focused,
  width,
  viewportHeight,
  panelTitle,
  sessionFilterActive,
  emptyStateHint,
  filterString,
}: SideListProps): React.ReactElement {
  // Unfocused chrome is dim default-colour, not ANSI bright-black ("gray"),
  // which disappears on Solarized-style themes.
  const borderColor = focused ? 'magenta' : undefined;
  const borderStyle = focused ? 'double' : 'single';
  // Inner width minus border (2) and padding (1)
  const innerWidth = Math.max(1, width - 3);

  // Windowed slice
  const visibleItems = items.slice(scrollOffset, scrollOffset + viewportHeight);
  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + viewportHeight < items.length;

  // Empty-state rows, pre-wrapped so the fill below counts real rows.
  const emptyRows: string[] = [];
  if (items.length === 0 && viewportHeight >= 3) {
    const lines: string[] = [];
    if (filterString) {
      lines.push(`No matches for "${escapeBraces(filterString)}"`);
      lines.push('{magenta-fg}{bold}Esc{/bold}{/magenta-fg}{grey-fg} clears the filter{/grey-fg}');
    } else if (sessionFilterActive) {
      lines.push('{grey-fg}No items in this session{/grey-fg}');
      lines.push('{grey-fg}Press {/grey-fg}{magenta-fg}{bold}f{/bold}{/magenta-fg}{grey-fg} to see all{/grey-fg}');
    } else {
      lines.push('{grey-fg}No items yet{/grey-fg}');
      if (emptyStateHint && viewportHeight >= 5) lines.push(`{grey-fg}${emptyStateHint}{/grey-fg}`);
    }
    emptyRows.push('');
    for (const line of lines) emptyRows.push(...wrapTaggedLines(line, innerWidth));
    emptyRows.splice(Math.max(1, viewportHeight - visibleItems.length));
  }
  const fillCount = Math.max(0, viewportHeight - visibleItems.length - emptyRows.length);

  return (
    <Box
      width={width}
      flexShrink={0}
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={borderColor}
      borderDimColor={!focused}
      overflow="hidden"
    >
      {/* Label */}
      <Box>
        <Text color={borderColor} dimColor={!focused} wrap="truncate-end">
          {' '}
          {panelTitle} ({items.length}){' '}
        </Text>
      </Box>

      {/* Scroll indicator top */}
      {hasMoreAbove && (
        <Box justifyContent="center" width={innerWidth}>
          <Text dimColor>▲</Text>
        </Box>
      )}

      {/* Items */}
      {visibleItems.map((item, i) => {
        const realIndex = scrollOffset + i;
        const isSelected = realIndex === selectedIndex;
        const marker = isSelected ? '▸' : ' ';
        let label = truncateTaggedLabel(item.label, innerWidth - 2);
        if (filterString) label = applySearchHighlight(label, filterString);

        return (
          <Box key={item.id} width={innerWidth}>
            {isSelected ? (
              <Text inverse wrap="truncate-end">
                <Text bold>{marker}</Text> {parseBlessedTags(label)}
              </Text>
            ) : (
              <Text wrap="truncate-end">
                {marker} {parseBlessedTags(label)}
              </Text>
            )}
          </Box>
        );
      })}

      {/* Empty-state hint */}
      {emptyRows.map((row, i) => (
        <Box key={`empty-hint-${i}`} justifyContent="center" width={innerWidth}>
          <Text wrap="truncate-end">{parseBlessedTags(row) ?? ' '}</Text>
        </Box>
      ))}

      {/* Fill remaining space */}
      {Array.from({ length: fillCount }, (_, i) => (
        <Box key={`empty-${i}`} width={innerWidth}>
          <Text> </Text>
        </Box>
      ))}

      {/* Scroll indicator bottom */}
      {hasMoreBelow && (
        <Box justifyContent="center" width={innerWidth}>
          <Text dimColor>▼</Text>
        </Box>
      )}
    </Box>
  );
}
