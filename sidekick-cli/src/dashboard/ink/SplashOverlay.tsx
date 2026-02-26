/**
 * Splash screen shown when waiting for session events.
 * Displays logo, version, random phrase, spinner, and usage hints.
 */

declare const __CLI_VERSION__: string;

import React from 'react';
import { Box, Text } from 'ink';
import { useSpinner } from './useSpinner';
import { getRandomPhrase } from 'sidekick-shared';

export function SplashOverlay(): React.ReactElement {
  const spinner = useSpinner();

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      paddingX={2}
      paddingY={1}
      width={60}
    >
      {/* Logo */}
      <Text>          <Text color="yellow">⚡</Text></Text>
      <Text>          <Text color="magenta">│</Text></Text>
      <Text>  <Text color="white">{'</>'}</Text>  <Text color="white">╭──┴──╮</Text>   <Text bold color="magenta">S I D E K I C K</Text></Text>
      <Text>       <Text color="white">│</Text> <Text color="cyan">●</Text> <Text color="cyan">●</Text> <Text color="white">│</Text>   <Text bold>Agent Hub</Text></Text>
      <Text>       <Text color="white">│</Text>  <Text color="green">◡</Text>  <Text color="white">│</Text>   <Text color="gray">Terminal Dashboard v{__CLI_VERSION__}</Text></Text>
      <Text>       <Text color="white">╰─────╯</Text></Text>
      <Text> </Text>
      <Text color="gray">  {getRandomPhrase()}</Text>
      <Text> </Text>
      <Text>  <Text color="magenta">{spinner}</Text> <Text color="gray">Waiting for session events...</Text></Text>
      <Text> </Text>
      <Text>  <Text color="gray">Navigate:</Text>  <Text bold>1-5</Text> jump   <Text bold>?</Text> help   <Text bold>q</Text> quit</Text>
      <Text> </Text>
      <Text color="gray">  Start a Claude Code, OpenCode, or Codex session</Text>
      <Text color="gray">  in another terminal and events will appear here.</Text>
      <Text> </Text>
      <Text>  <Text color="gray">Or use </Text><Text bold>--replay</Text><Text color="gray"> to replay an existing session.</Text></Text>
    </Box>
  );
}
