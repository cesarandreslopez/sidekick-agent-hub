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

interface SplashOverlayProps {
  /** Number of dashboard panels, for the "1-N jump" hint. */
  panelCount?: number;
}

export function SplashOverlay({ panelCount }: SplashOverlayProps): React.ReactElement {
  const spinner = useSpinner();
  const phrase = useMemo(() => getRandomPhrase(), []);
  const { columns } = useTerminalSize();
  const jumpHint = panelCount && panelCount > 1 ? `1-${Math.min(panelCount, 9)}` : '1-9';

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      paddingX={2}
      paddingY={1}
      width={Math.min(60, columns - 2)}
    >
      {/* Logo */}
      {LOGO_ART.map((line, i) => (
        <Text key={i}>{parseBlessedTags(line)}</Text>
      ))}
      <Text> </Text>
      <Text dimColor> {phrase}</Text>
      <Text> </Text>
      <Text>
        {' '}
        <Text color="magenta">{spinner}</Text>{' '}
        <Text dimColor>Waiting for session events...</Text>
      </Text>
      <Text> </Text>
      <Text>
        {' '}
        <Text dimColor>Navigate:</Text> <Text bold>{jumpHint}</Text> jump <Text bold>?</Text>{' '}
        help <Text bold>q</Text> quit
      </Text>
      <Text> </Text>
      <Text dimColor> Start a Claude Code, OpenCode, or Codex session</Text>
      <Text dimColor> in another terminal and events will appear here.</Text>
      <Text> </Text>
      <Text>
        {' '}
        <Text dimColor>Or use </Text>
        <Text bold>--replay</Text>
        <Text dimColor> to replay an existing session.</Text>
      </Text>
    </Box>
  );
}
