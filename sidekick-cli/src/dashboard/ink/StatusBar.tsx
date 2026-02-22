/**
 * Status bar (bottom row) showing brand, version, event count, keybinding hints.
 */

declare const __CLI_VERSION__: string;

import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  eventCount: number;
  providerName?: string;
  focusTarget: 'side' | 'detail';
  panelHints: string;
  sessionFilter: string | null;
  filterString: string;
  matchCount?: number;
  totalCount?: number;
}

export function StatusBar({
  eventCount,
  providerName,
  focusTarget,
  panelHints,
  sessionFilter,
  filterString,
  matchCount,
  totalCount,
}: StatusBarProps): React.ReactElement {
  const evtLabel = eventCount > 0 ? `${eventCount} events` : 'waiting...';

  return (
    <Box height={1} width="100%">
      {/* Brand + version */}
      <Text bold color="magenta">⚡ SIDEKICK</Text>
      <Text color="gray"> v{__CLI_VERSION__}</Text>

      {/* Provider */}
      {providerName && (
        <>
          <Text color="gray"> | </Text>
          <Text color="cyan">{providerName}</Text>
        </>
      )}

      <Text color="gray"> | </Text>
      <Text>{evtLabel}</Text>

      {/* Filter status */}
      {filterString && (
        <Text color="yellow">  filter: "{filterString}" ({matchCount ?? 0} of {totalCount ?? 0})</Text>
      )}

      {/* Session filter */}
      {sessionFilter && (
        <Text color="magenta">  {sessionFilter}</Text>
      )}

      <Text color="gray"> | </Text>

      {/* Focus hints */}
      {focusTarget === 'side' ? (
        <Text>
          <Text bold>↑↓</Text> navigate  <Text bold>Tab</Text> detail  {panelHints}<Text bold>/</Text> filter  <Text bold>?</Text> help  <Text bold>q</Text> quit
        </Text>
      ) : (
        <Text>
          <Text bold>j/k</Text> scroll  <Text bold>[]</Text> tab  <Text bold>Tab</Text> side  {panelHints}<Text bold>?</Text> help  <Text bold>q</Text> quit
        </Text>
      )}
    </Box>
  );
}
