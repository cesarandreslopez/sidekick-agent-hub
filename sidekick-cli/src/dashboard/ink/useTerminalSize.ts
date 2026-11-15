/**
 * Hook that returns terminal dimensions and re-renders on resize.
 *
 * Reads the stream Ink renders to (which may be a wrapper around
 * process.stdout, or a test stream), so the layout and Ink agree on the size.
 */

import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

interface TerminalSize {
  columns: number;
  rows: number;
}

type SizedStream = {
  columns?: number;
  rows?: number;
  on?: (event: 'resize', listener: () => void) => unknown;
  off?: (event: 'resize', listener: () => void) => unknown;
};

function sizeOf(stream: SizedStream | undefined): TerminalSize {
  return {
    columns: stream?.columns || process.stdout.columns || 80,
    rows: stream?.rows || process.stdout.rows || 24,
  };
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const stream = (stdout as SizedStream | undefined) ?? process.stdout;
  const [size, setSize] = useState<TerminalSize>(() => sizeOf(stream));

  useEffect(() => {
    const onResize = () => {
      const next = sizeOf(stream);
      setSize((prev) => (prev.columns === next.columns && prev.rows === next.rows ? prev : next));
    };
    onResize();
    stream.on?.('resize', onResize);
    return () => {
      stream.off?.('resize', onResize);
    };
  }, [stream]);

  return size;
}
