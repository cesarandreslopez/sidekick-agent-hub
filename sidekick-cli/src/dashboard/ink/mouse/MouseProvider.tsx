/**
 * React component that enables terminal mouse tracking and dispatches
 * parsed mouse events via a callback prop. No context — just stdin parsing.
 */

import React, { useEffect } from 'react';
import { useInput } from 'ink';
import { enableMouse, disableMouse } from './mouseProtocol';
import { parseMouseEvent } from './parseMouseEvent';
import type { TerminalMouseEvent } from './parseMouseEvent';

interface MouseProviderProps {
  onMouse: (event: TerminalMouseEvent) => void;
  children: React.ReactNode;
}

/**
 * Dummy component that calls useInput to consume raw stdin data,
 * preventing mouse escape sequences from echoing as garbage text.
 */
function InputSink(): null {
  useInput(() => {});
  return null;
}

export function MouseProvider({ onMouse, children }: MouseProviderProps): React.ReactElement {
  useEffect(() => {
    enableMouse();

    const handler = (data: Buffer) => {
      const event = parseMouseEvent(data);
      if (event) {
        onMouse(event);
      }
    };

    process.stdin.on('data', handler);

    // Safety net: disable mouse on process exit even if unmount doesn't fire
    const exitHandler = () => disableMouse();
    process.on('exit', exitHandler);

    return () => {
      process.stdin.removeListener('data', handler);
      process.removeListener('exit', exitHandler);
      disableMouse();
    };
  }, [onMouse]);

  return (
    <>
      <InputSink />
      {children}
    </>
  );
}
