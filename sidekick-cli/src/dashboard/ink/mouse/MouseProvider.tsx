/**
 * React component that enables terminal mouse tracking and dispatches
 * parsed mouse events via a callback prop. No context — just stdin parsing.
 */

import React, { useEffect, useRef } from 'react';
import { useInput } from 'ink';
import { enableMouse, disableMouse } from './mouseProtocol';
import type { TerminalMouseEvent } from './parseMouseEvent';
import { createMouseDataHandler } from './mouseDataHandler';

interface MouseProviderProps {
  onMouse: (event: TerminalMouseEvent) => void;
  /** When false, mouse tracking stays off so terminal text selection works. */
  enabled?: boolean;
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

export function MouseProvider({
  onMouse,
  enabled = true,
  children,
}: MouseProviderProps): React.ReactElement {
  const onMouseRef = useRef(onMouse);
  onMouseRef.current = onMouse;

  useEffect(() => {
    if (!enabled) return;
    enableMouse();

    const handler = createMouseDataHandler(onMouseRef);

    process.stdin.on('data', handler);

    // Safety net: disable mouse on process exit even if unmount doesn't fire
    const exitHandler = () => disableMouse();
    process.on('exit', exitHandler);

    return () => {
      process.stdin.removeListener('data', handler);
      process.removeListener('exit', exitHandler);
      disableMouse();
    };
  }, [enabled]);

  return (
    <>
      <InputSink />
      {children}
    </>
  );
}
