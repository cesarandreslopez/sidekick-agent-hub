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
  const truncMsg = toast.message.length > 56 ? toast.message.substring(0, 53) + '...' : toast.message;

  return (
    <Box
      position="absolute"
      marginLeft={Math.max(0, process.stdout.columns - truncMsg.length - 6)}
      marginTop={0}
      borderStyle="single"
      borderColor={color}
    >
      <Text color={color}>{truncMsg}</Text>
    </Box>
  );
}
