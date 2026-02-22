/**
 * Hook that cycles through braille spinner frames on an interval.
 * Returns the current frame string.
 */

import { useState, useEffect } from 'react';

const FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2807', '\u280F'];
const DEFAULT_INTERVAL_MS = 80;

export function useSpinner(intervalMs = DEFAULT_INTERVAL_MS): string {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex(prev => (prev + 1) % FRAMES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return FRAMES[frameIndex];
}
