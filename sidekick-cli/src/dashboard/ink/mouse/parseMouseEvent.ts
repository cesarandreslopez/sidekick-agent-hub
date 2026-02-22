/**
 * Parse SGR 1006 mouse escape sequences from raw stdin data.
 */

export interface TerminalMouseEvent {
  type: 'click' | 'release' | 'scroll' | 'drag';
  button: 'left' | 'middle' | 'right' | 'none';
  x: number;  // 0-based column
  y: number;  // 0-based row
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  scrollDirection?: 'up' | 'down';
}

// SGR mouse sequence: ESC [ < Cb ; Cx ; Cy M/m
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * Try to parse an SGR mouse event from raw stdin data.
 * Returns null if the data is not a mouse sequence.
 */
export function parseMouseEvent(data: Buffer | string): TerminalMouseEvent | null {
  const str = typeof data === 'string' ? data : data.toString('utf-8');
  const match = SGR_MOUSE_RE.exec(str);
  if (!match) return null;

  const code = parseInt(match[1], 10);
  const cx = parseInt(match[2], 10);
  const cy = parseInt(match[3], 10);
  const isRelease = match[4] === 'm';

  // Convert from 1-based protocol coords to 0-based
  const x = cx - 1;
  const y = cy - 1;

  // Extract modifier bits
  const shift = (code & 4) !== 0;
  const meta = (code & 8) !== 0;
  const ctrl = (code & 16) !== 0;

  // Strip modifier bits to get base button code
  const baseCode = code & ~(4 | 8 | 16);

  // Scroll events (64 = up, 65 = down)
  if (baseCode === 64 || baseCode === 65) {
    return {
      type: 'scroll',
      button: 'none',
      x, y,
      shift, meta, ctrl,
      scrollDirection: baseCode === 64 ? 'up' : 'down',
    };
  }

  // Drag events (32 = left drag, 33 = middle drag, 34 = right drag)
  if (baseCode >= 32 && baseCode <= 34) {
    const buttons: Array<'left' | 'middle' | 'right'> = ['left', 'middle', 'right'];
    return {
      type: 'drag',
      button: buttons[baseCode - 32],
      x, y,
      shift, meta, ctrl,
    };
  }

  // Regular click/release (0 = left, 1 = middle, 2 = right)
  if (baseCode >= 0 && baseCode <= 2) {
    const buttons: Array<'left' | 'middle' | 'right'> = ['left', 'middle', 'right'];
    return {
      type: isRelease ? 'release' : 'click',
      button: buttons[baseCode],
      x, y,
      shift, meta, ctrl,
    };
  }

  return null;
}
