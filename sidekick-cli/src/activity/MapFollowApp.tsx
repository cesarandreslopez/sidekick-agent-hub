/**
 * The full-screen view behind `sidekick map --follow`. It owns nothing: the
 * controller in `follow.ts` builds each frame from the terminal size this
 * component reports, and handles the keys it forwards.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useTerminalSize } from '../dashboard/ink/useTerminalSize';
import type { FrameRow } from './frame';
import { toneStyle } from './tones';

export type FollowKey =
  | { type: 'quit' }
  | { type: 'feed' }
  | { type: 'insights' }
  | { type: 'pause' }
  | { type: 'live' }
  | { type: 'seek'; ms: number };

export interface MapFollowAppProps {
  /** Builds the frame for the current terminal size. */
  frame: (size: { columns: number; rows: number }) => FrameRow[];
  onKey: (key: FollowKey) => void;
  /** Changes whenever the controller wants a redraw. */
  tick: number;
}

/** Maps a keypress to a view action; null for keys the view ignores. */
export function followKeyFor(
  input: string,
  key: {
    escape?: boolean;
    ctrl?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    shift?: boolean;
  },
): FollowKey | null {
  if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return { type: 'quit' };
  if (key.leftArrow) return { type: 'seek', ms: key.shift ? -60_000 : -10_000 };
  if (key.rightArrow) return { type: 'seek', ms: key.shift ? 60_000 : 10_000 };
  if (input === 'f') return { type: 'feed' };
  if (input === 'i') return { type: 'insights' };
  if (input === 'p' || input === ' ') return { type: 'pause' };
  if (input === 'l') return { type: 'live' };
  return null;
}

function Row({ row }: { row: FrameRow }): React.ReactElement {
  if (row.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {row.map((segment, index) => {
        const style = toneStyle(segment);
        return (
          <Text key={index} color={style.color} bold={style.bold} dimColor={style.dim}>
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

export function MapFollowApp({ frame, onKey }: MapFollowAppProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  useInput((input, key) => {
    const action = followKeyFor(input, key);
    if (action) onKey(action);
  });
  const lines = frame({ columns, rows });
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {lines.map((row, index) => (
        <Row key={index} row={row} />
      ))}
    </Box>
  );
}
