import { describe, expect, it, vi } from 'vitest';
import { createMouseDataHandler } from './mouseDataHandler';

describe('createMouseDataHandler', () => {
  it('keeps one handler while dispatching through the latest callback ref', () => {
    const first = vi.fn();
    const second = vi.fn();
    const ref = { current: first };
    const handler = createMouseDataHandler(ref);
    ref.current = second;
    handler(Buffer.from('\x1b[<0;1;1M'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
