/**
 * Toast notification displayed at the top-right of the screen.
 * Auto-dismissed by the parent component via timers.
 */

import React from 'react';
import { Box, Text } from 'ink';

const SEVERITY_COLOR: Record<string, string> = {
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
};

const SEVERITY_ICON: Record<string, string> = {
  error: '\u2718',   // ✘
  warning: '\u26A0', // ⚠
  info: '\u25CF',    // ●
};

interface ToastEntry {
  id: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

interface ToastNotificationProps {
  toast: ToastEntry;
}

export function ToastNotification({ toast }: ToastNotificationProps): React.ReactElement {
  const color = SEVERITY_COLOR[toast.severity] || 'cyan';
  const icon = SEVERITY_ICON[toast.severity] || '\u25CF';
  const truncMsg = toast.message.length > 56 ? toast.message.substring(0, 53) + '...' : toast.message;

  return (
    <Box
      position="absolute"
      marginLeft={Math.max(0, process.stdout.columns - truncMsg.length - 8)}
      marginTop={0}
      borderStyle="single"
      borderColor={color}
      paddingX={1}
    >
      <Text color={color}>{icon} {truncMsg}</Text>
    </Box>
  );
}
