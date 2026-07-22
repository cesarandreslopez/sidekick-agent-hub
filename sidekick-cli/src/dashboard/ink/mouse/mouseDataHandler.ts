import { parseMouseEvents, type TerminalMouseEvent } from './parseMouseEvent';

export interface MouseCallbackRef {
  current: (event: TerminalMouseEvent) => void;
}

export function createMouseDataHandler(ref: MouseCallbackRef): (data: Buffer) => void {
  return (data) => {
    for (const event of parseMouseEvents(data)) ref.current(event);
  };
}
