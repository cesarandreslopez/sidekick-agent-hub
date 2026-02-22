/**
 * Ink-based session picker shown before the dashboard starts.
 * Lists available sessions and lets the user select one.
 */

import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { SessionProvider, ProviderId } from 'sidekick-shared';
import { collectSessionItems, collectMultiProviderItems, PROVIDER_BADGES, type SessionPickerItem } from '../SessionPickerHelpers';

interface SessionPickerInkProps {
  items: SessionPickerItem[];
  onSelect: (sessionPath: string | null) => void;
}

export function SessionPickerInk({ items, onSelect }: SessionPickerInkProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();

  // items + 1 for the "wait for new session" option
  const totalItems = items.length + 1;

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      exit();
      return;
    }

    if (input === 'j' || key.downArrow) {
      setSelectedIndex(prev => Math.min(prev + 1, totalItems - 1));
      return;
    }

    if (input === 'k' || key.upArrow) {
      setSelectedIndex(prev => Math.max(prev - 1, 0));
      return;
    }

    if (key.return) {
      if (selectedIndex === items.length) {
        // "Wait for new session"
        onSelect(null);
      } else {
        onSelect(items[selectedIndex].sessionPath);
      }
      return;
    }
  });

  const rows = process.stdout.rows || 24;
  const viewportHeight = Math.max(5, rows - 15);
  const scrollOffset = Math.max(0, Math.min(selectedIndex - Math.floor(viewportHeight / 2), totalItems - viewportHeight));

  const visibleStart = Math.max(0, scrollOffset);
  const visibleEnd = Math.min(totalItems, visibleStart + viewportHeight);

  return (
    <Box flexDirection="column" width="100%" height={rows}>
      {/* Logo */}
      <Box justifyContent="center" marginTop={1}>
        <Box flexDirection="column" width={50}>
          <Text>          <Text color="yellow">⚡</Text></Text>
          <Text>          <Text color="magenta">│</Text></Text>
          <Text>  <Text color="white">{'</>'}</Text>  <Text color="white">╭──┴──╮</Text>   <Text bold color="magenta">S I D E K I C K</Text></Text>
          <Text>       <Text color="white">│</Text> <Text color="cyan">●</Text> <Text color="cyan">●</Text> <Text color="white">│</Text>   <Text bold>Agent Hub</Text></Text>
          <Text>       <Text color="white">│</Text>  <Text color="green">◡</Text>  <Text color="white">│</Text>   <Text color="gray">Terminal Dashboard</Text></Text>
          <Text>       <Text color="white">╰─────╯</Text></Text>
        </Box>
      </Box>

      {/* Session list */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="magenta"
        marginX={2}
        flexGrow={1}
      >
        <Text color="magenta"> Sessions ({items.length}) </Text>

        {Array.from({ length: visibleEnd - visibleStart }, (_, vi) => {
          const i = visibleStart + vi;
          const isSelected = i === selectedIndex;

          if (i === items.length) {
            // "Wait for new session" option
            return (
              <Box key="wait">
                <Text inverse={isSelected}>
                  <Text color="yellow">+</Text> Wait for a new session to start...
                </Text>
              </Box>
            );
          }

          const item = items[i];
          const dot = item.isActive ? '●' : '○';
          const dotColor = item.isActive ? 'green' : 'gray';
          const badge = item.providerId ? PROVIDER_BADGES[item.providerId] : null;
          const truncLabel = item.label.length > 40
            ? item.label.substring(0, 37) + '...'
            : item.label;

          return (
            <Box key={item.sessionPath}>
              <Text inverse={isSelected}>
                {badge && <Text color={badge.color}>[{badge.badge}]</Text>}{' '}
                <Text color={dotColor}>{dot}</Text> {truncLabel.padEnd(40)}  <Text color="gray">{item.age.padEnd(9)}</Text> <Text color="gray">{item.sessionId}</Text>{item.isActive ? <Text color="green"> LIVE</Text> : ''}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Status bar */}
      <Box height={1}>
        <Text> <Text bold color="magenta">⚡ SIDEKICK</Text> <Text color="gray">Session Picker</Text>  <Text bold>↑/↓</Text> navigate  <Text bold>Enter</Text> select  <Text bold>q</Text> quit</Text>
      </Box>
    </Box>
  );
}

export interface SessionPickerResult {
  sessionPath: string | null;
  providerId?: ProviderId;
}

/**
 * Show the session picker and return the selected path + provider.
 * Returns null path for "wait for new session", throws on quit.
 * If additionalProviders are supplied, sessions from all providers are shown.
 */
export async function showSessionPicker(
  provider: SessionProvider,
  workspacePath: string,
  additionalProviders?: SessionProvider[],
): Promise<SessionPickerResult> {
  const { render } = await import('ink');

  let items: SessionPickerItem[];
  if (additionalProviders && additionalProviders.length > 0) {
    const allProviders = [provider, ...additionalProviders].map(p => ({ provider: p, workspacePath }));
    items = collectMultiProviderItems(allProviders);
  } else {
    const sessions = provider.findAllSessions(workspacePath);
    if (sessions.length === 0) return { sessionPath: null };
    items = collectSessionItems(sessions, provider);
  }

  if (items.length === 0) return { sessionPath: null };

  return new Promise<SessionPickerResult>((resolve, reject) => {
    const instance = render(
      <SessionPickerInk
        items={items}
        onSelect={(selectedPath) => {
          instance.unmount();
          const selected = items.find(it => it.sessionPath === selectedPath);
          resolve({ sessionPath: selectedPath, providerId: selected?.providerId });
        }}
      />,
    );

    instance.waitUntilExit().then(() => {
      reject(new Error('quit'));
    }).catch(reject);
  });
}
