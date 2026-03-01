/**
 * Filter overlay shown at the bottom of the screen.
 * Supports 4 filter modes: substring, fuzzy, regex, date.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { FilterMode } from 'sidekick-shared';

interface FilterOverlayProps {
  filterString: string;
  filterMode: FilterMode;
  filterError: string | null;
}

const MODE_LABELS: Record<FilterMode, { key: string; label: string }> = {
  substring: { key: 'S', label: 'Substr' },
  fuzzy: { key: 'F', label: 'Fuzzy' },
  regex: { key: 'R', label: 'Regex' },
  date: { key: 'D', label: 'Date' },
};

const MODE_ORDER: FilterMode[] = ['substring', 'fuzzy', 'regex', 'date'];

export function FilterOverlay({ filterString, filterMode, filterError }: FilterOverlayProps): React.ReactElement {
  return (
    <Box
      position="absolute"
      marginTop={process.stdout.rows - 2}
      width="100%"
      height={1}
    >
      {/* Mode indicator */}
      {MODE_ORDER.map(mode => {
        const { key, label } = MODE_LABELS[mode];
        const isActive = mode === filterMode;
        return (
          <Text key={mode}>
            {isActive ? (
              <Text bold color="magenta">[{key}]{label} </Text>
            ) : (
              <Text color="gray">[{key}]{label} </Text>
            )}
          </Text>
        );
      })}
      <Text bold color="magenta"> / </Text>
      {filterError ? (
        <Text color="red">{filterString}</Text>
      ) : (
        <Text>{filterString}</Text>
      )}
      <Text color="gray">█</Text>
      {filterError && (
        <Text color="red"> {filterError}</Text>
      )}
    </Box>
  );
}

/** Get the next filter mode in the cycle. */
export function nextFilterMode(current: FilterMode): FilterMode {
  const idx = MODE_ORDER.indexOf(current);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
}
