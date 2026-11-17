/**
 * Splash screen shown when waiting for session events.
 * Displays the Sidekick wordmark, random phrase, spinner, and usage hints.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useSpinner } from './useSpinner';
import { getRandomPhrase } from 'sidekick-shared';
import { LOGO_ART } from '../branding';
import { parseBlessedTags } from './parseBlessedTags';
import { useTerminalSize } from './useTerminalSize';

/** Rows the full splash (logo and spacers) needs, with the status bar below it. */
const SPLASH_FULL_MIN_ROWS = 24;

interface SplashOverlayProps {
  /** Number of dashboard panels, for the "1-N jump" hint. */
  panelCount?: number;
}

export function SplashOverlay({ panelCount }: SplashOverlayProps): React.ReactElement {
  const spinner = useSpinner();
  const phrase = useMemo(() => getRandomPhrase(), []);
  const { columns, rows } = useTerminalSize();
  const jumpHint = panelCount && panelCount > 1 ? `1-${Math.min(panelCount, 9)}` : '1-9';
  // The full splash is 21 rows; on a short terminal the logo and spacers go,
  // so the borders and the --replay hint stay on screen.
  const compact = rows < SPLASH_FULL_MIN_ROWS;
  const spacer = compact ? null : <Text> </Text>;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      paddingX={2}
      paddingY={compact ? 0 : 1}
      width={Math.min(60, columns - 2)}
      flexShrink={0}
    >
      {/* Logo */}
      {!compact &&
        LOGO_ART.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {parseBlessedTags(line)}
          </Text>
        ))}
      {spacer}
      <Text dimColor wrap="truncate-end">
        {' '}
        {phrase}
      </Text>
      {spacer}
      <Text>
        {' '}
        <Text color="magenta">{spinner}</Text> <Text dimColor>Waiting for session events...</Text>
      </Text>
      {spacer}
      <Text>
        {' '}
        <Text dimColor>Navigate:</Text> <Text bold>{jumpHint}</Text> jump <Text bold>?</Text> help{' '}
        <Text bold>q</Text> quit
      </Text>
      {spacer}
      <Text dimColor> Start a Claude Code, OpenCode, or Codex session</Text>
      <Text dimColor> in another terminal and events will appear here.</Text>
      {spacer}
      <Text>
        {' '}
        <Text dimColor>Or use </Text>
        <Text bold>--replay</Text>
        <Text dimColor> to replay an existing session.</Text>
      </Text>
    </Box>
  );
}
