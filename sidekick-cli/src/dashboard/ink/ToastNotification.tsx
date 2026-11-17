/**
 * Toast notification displayed at the top-right of the screen.
 * Auto-dismissed by the parent component via timers.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from './useTerminalSize';
import { displayWidth } from '../blessedText';
import { OVERLAY_FILL } from './overlayFill';
import { toastLines } from './toastStack';

const SEVERITY_COLOR: Record<string, string> = {
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
};

const SEVERITY_ICON: Record<string, string> = {
  error: '✘', // ✘
  warning: '⚠', // ⚠
  info: '●', // ●
};

interface ToastEntry {
  id: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

interface ToastNotificationProps {
  toast: ToastEntry;
  /** Row the toast's top border sits on (see `toastOffsets`). */
  top?: number;
}

export function ToastNotification({ toast, top = 0 }: ToastNotificationProps): React.ReactElement {
  const { columns } = useTerminalSize();
  const color = SEVERITY_COLOR[toast.severity] || 'cyan';
  const icon = SEVERITY_ICON[toast.severity] || '●';
  // Wrapped to up to three rows rather than cut to one: a report path or an
  // error message is no use with its end missing.
  const lines = toastLines(toast.message, columns);
  const textWidth = Math.max(...lines.map((line) => displayWidth(line)));

  return (
    <Box
      position="absolute"
      flexDirection="column"
      marginLeft={Math.max(0, columns - textWidth - 8)}
      marginTop={top}
      borderStyle="single"
      borderColor={color}
      paddingX={1}
      backgroundColor={OVERLAY_FILL}
    >
      {lines.map((line, i) => (
        <Text key={i} color={color}>
          {i === 0 ? `${icon} ` : '  '}
          {line}
        </Text>
      ))}
    </Box>
  );
}
