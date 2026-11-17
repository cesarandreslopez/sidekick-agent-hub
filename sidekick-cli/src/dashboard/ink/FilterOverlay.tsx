/**
 * Filter overlay shown at the bottom of the screen.
 * Supports 4 filter modes: substring, fuzzy, regex, date.
 *
 * Every printable key is part of the query, so the modes are cycled with
 * Tab (the only mode key) and the row says so. The whole row is one line,
 * cut at the terminal edge rather than wrapped onto the status bar.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { FilterMode } from 'sidekick-shared';
import { useTerminalSize } from './useTerminalSize';

interface FilterOverlayProps {
  filterString: string;
  filterMode: FilterMode;
  filterError: string | null;
}

const MODE_LABELS: Record<FilterMode, string> = {
  substring: 'Substr',
  fuzzy: 'Fuzzy',
  regex: 'Regex',
  date: 'Date',
};

const MODE_ORDER: FilterMode[] = ['substring', 'fuzzy', 'regex', 'date'];

export function FilterOverlay({
  filterString,
  filterMode,
  filterError,
}: FilterOverlayProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const showDateHelp = filterMode === 'date' && !filterString;
  return (
    <Box position="absolute" marginTop={rows - 2} width={columns} height={1} overflow="hidden">
      <Text wrap="truncate-end">
        {' '}
        {MODE_ORDER.map((mode, i) => (
          <React.Fragment key={mode}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            {mode === filterMode ? (
              // Brackets as well as colour: NO_COLOR leaves only the text.
              <Text bold color="magenta" underline>
                [{MODE_LABELS[mode]}]
              </Text>
            ) : (
              <Text dimColor>{MODE_LABELS[mode]}</Text>
            )}
          </React.Fragment>
        ))}
        <Text bold color="magenta">
          {'  / '}
        </Text>
        {filterError ? <Text color="red">{filterString}</Text> : <Text>{filterString}</Text>}
        <Text dimColor>█</Text>
        {filterError ? <Text color="red"> {filterError}</Text> : null}
        {showDateHelp ? (
          <Text dimColor> today · yesterday · 2d · 1w · YYYY-MM-DD · &gt;expr · &lt;expr</Text>
        ) : (
          <Text dimColor>
            {'   '}
            <Text bold>Tab</Text> mode · <Text bold>Enter</Text> keep · <Text bold>Esc</Text> clear
          </Text>
        )}
      </Text>
    </Box>
  );
}

/** Get the next filter mode in the cycle. */
export function nextFilterMode(current: FilterMode): FilterMode {
  const idx = MODE_ORDER.indexOf(current);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
}
