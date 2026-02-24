/**
 * Changelog overlay showing version info and recent changes, centered over the dashboard.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ChangelogEntry } from 'sidekick-shared';

declare const __CLI_VERSION__: string;

interface ChangelogOverlayProps {
  entries: ChangelogEntry[];
  scrollOffset: number;
}

export function ChangelogOverlay({ entries, scrollOffset }: ChangelogOverlayProps): React.ReactElement {
  const width = 64;
  const maxVisibleLines = Math.max(process.stdout.rows - 12, 10);

  // Build all content lines
  const lines: React.ReactElement[] = [];

  // Version header
  const latestDate = entries[0]?.date || '';
  lines.push(
    <Text key="ver">
      {'  '}
      <Text bold color="cyan">Terminal Dashboard v{__CLI_VERSION__}</Text>
      {latestDate ? <Text color="gray">{' — '}{latestDate}</Text> : null}
    </Text>
  );
  lines.push(<Text key="sep"> </Text>);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Version heading (skip for first entry since it's in the header)
    if (i > 0) {
      lines.push(
        <Text key={`v-${i}`}>
          {'  '}
          <Text bold>v{entry.version}</Text>
          <Text color="gray">{' — '}{entry.date}</Text>
        </Text>
      );
    }
    for (const section of entry.sections) {
      lines.push(
        <Text key={`h-${i}-${section.heading}`}>
          {'  '}
          <Text bold color="yellow">{section.heading}</Text>
        </Text>
      );
      for (let j = 0; j < section.items.length; j++) {
        // Truncate long items to fit in the box
        const maxLen = width - 8;
        let text = section.items[j];
        if (text.length > maxLen) {
          text = text.slice(0, maxLen - 1) + '\u2026';
        }
        lines.push(
          <Text key={`item-${i}-${section.heading}-${j}`}>
            {'    '}<Text color="gray">{'\u2022'}</Text> {text}
          </Text>
        );
      }
    }
    if (i < entries.length - 1) {
      lines.push(<Text key={`gap-${i}`}> </Text>);
    }
  }

  // Apply scroll offset
  const visibleLines = lines.slice(scrollOffset, scrollOffset + maxVisibleLines);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset + maxVisibleLines < lines.length;

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      paddingX={1}
      paddingY={1}
      width={width}
    >
      {/* Logo */}
      <Text>          <Text color="yellow">{'\u26A1'}</Text></Text>
      <Text>          <Text color="magenta">{'\u2502'}</Text></Text>
      <Text>  <Text color="white">{'</>'}</Text>  <Text color="white">{'\u256D\u2500\u2500\u2534\u2500\u2500\u256E'}</Text>   <Text bold color="magenta">W H A T ' S   N E W</Text></Text>
      <Text>       <Text color="white">{'\u2502'}</Text> <Text color="cyan">{'\u25CF'}</Text> <Text color="cyan">{'\u25CF'}</Text> <Text color="white">{'\u2502'}</Text>   <Text bold>Sidekick Agent Hub</Text></Text>
      <Text>       <Text color="white">{'\u2502'}</Text>  <Text color="green">{'\u25E1'}</Text>  <Text color="white">{'\u2502'}</Text></Text>
      <Text>       <Text color="white">{'\u2570\u2500\u2500\u2500\u2500\u2500\u256F'}</Text></Text>
      <Text> </Text>

      {/* Scroll indicator top */}
      {canScrollUp && <Text color="gray">{'  \u25B2 scroll up (k)'}</Text>}

      {/* Content */}
      {visibleLines}

      {/* Scroll indicator bottom */}
      {canScrollDown && <Text color="gray">{'  \u25BC scroll down (j)'}</Text>}

      <Text> </Text>
      <Text color="gray">  Full changelog: <Text color="cyan">https://cesarandreslopez.github.io/sidekick-agent-hub/changelog/</Text></Text>
      <Text> </Text>
      <Text color="gray">  Press <Text bold>Esc</Text> or <Text bold>V</Text> to close</Text>
    </Box>
    </Box>
  );
}
