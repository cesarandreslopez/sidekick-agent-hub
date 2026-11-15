/**
 * Toast notification displayed at the top-right of the screen.
 * Auto-dismissed by the parent component via timers.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from './useTerminalSize';
import { displayWidth } from '../blessedText';

const SEVERITY_COLOR: Record<string, string> = {
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
};

const SEVERITY_ICON: Record<string, string> = {
  error: '\u2718', // ✘
  warning: '\u26A0', // ⚠
  info: '\u25CF', // ●
};

interface ToastEntry {
  id: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

interface ToastNotificationProps {
  toast: ToastEntry;
  /** Stack position from the top; each toast occupies three rows. */
  row?: number;
}

export function ToastNotification({ toast, row = 0 }: ToastNotificationProps): React.ReactElement {
  const { columns } = useTerminalSize();
  const color = SEVERITY_COLOR[toast.severity] || 'cyan';
  const icon = SEVERITY_ICON[toast.severity] || '\u25CF';
  const maxMsg = Math.max(16, Math.min(56, columns - 10));
  let truncMsg = toast.message;
  if (displayWidth(truncMsg) > maxMsg) {
    let cut = '';
    for (const ch of Array.from(truncMsg)) {
      if (displayWidth(cut + ch) > maxMsg - 3) break;
      cut += ch;
    }
    truncMsg = cut + '...';
  }

  return (
    <Box
      position="absolute"
      marginLeft={Math.max(0, columns - displayWidth(truncMsg) - 8)}
      marginTop={row * 3}
      borderStyle="single"
      borderColor={color}
      paddingX={1}
    >
      <Text color={color}>
        {icon} {truncMsg}
      </Text>
    </Box>
  );
}
