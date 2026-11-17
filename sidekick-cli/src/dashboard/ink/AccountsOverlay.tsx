/**
 * Dashboard overlay listing saved accounts: Enter switches, u undoes the last
 * switch. Mirrors the `sidekick accounts` picker rows so both surfaces agree.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { AccountView } from 'sidekick-shared';
import { PROVIDER_NAMES, accountRowParts, columnWidths } from '../../commands/accounts/format';
import { useTerminalSize } from './useTerminalSize';
import { OVERLAY_FILL } from './overlayFill';

interface AccountsOverlayProps {
  views: AccountView[];
  selectedIndex: number;
}

export function AccountsOverlay({
  views,
  selectedIndex,
}: AccountsOverlayProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const widths = columnWidths(views);
  const now = Date.now();
  const contentWidth =
    8 +
    widths.name +
    (widths.email ? widths.email + 2 : 0) +
    (widths.plan ? widths.plan + 2 : 0) +
    24;
  // Wide enough for the empty-state and footer rows below, so nothing wraps.
  const width = Math.min(Math.max(48, contentWidth), columns - 2);
  const height = views.length + 7;
  let provider: string | null = null;
  let itemIndex = -1;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      width={width}
      position="absolute"
      marginLeft={Math.max(0, Math.floor((columns - width) / 2))}
      marginTop={Math.max(0, Math.floor((rows - height) / 2))}
      paddingX={1}
      backgroundColor={OVERLAY_FILL}
    >
      <Text color="magenta"> Accounts </Text>
      {views.length === 0 && (
        <>
          <Text dimColor wrap="truncate-end">
            No saved accounts.
          </Text>
          <Text dimColor wrap="truncate-end">
            Run: sidekick accounts add
          </Text>
        </>
      )}
      {views.map((view) => {
        itemIndex++;
        const header = view.providerId !== provider ? PROVIDER_NAMES[view.providerId] : null;
        provider = view.providerId;
        const p = accountRowParts(view, now);
        const selected = itemIndex === selectedIndex;
        return (
          <Box key={`${view.providerId}:${view.id}`} flexDirection="column">
            {header && <Text bold>{header}</Text>}
            <Text inverse={selected} wrap="truncate-end">
              {/* A pointer as well as inverse video, which NO_COLOR removes. */}
              {selected ? '\u25B8 ' : '  '}
              <Text color="green">{view.isActive ? '* ' : '  '}</Text>
              {p.name.padEnd(widths.name)}
              {widths.email ? <Text dimColor> {p.email.padEnd(widths.email)}</Text> : ''}
              {'  '}
              <Text color={p.badge.color}>
                {p.badge.glyph} {p.badge.state}
              </Text>
            </Text>
          </Box>
        );
      })}
      <Text dimColor wrap="truncate-end">
        <Text bold>Enter</Text> switch <Text bold>u</Text> undo <Text bold>Esc</Text> close
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text bold>a/l/s</Text> CLI: add · login · shell
      </Text>
    </Box>
  );
}
