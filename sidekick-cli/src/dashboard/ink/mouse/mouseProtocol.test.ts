import { describe, expect, it } from 'vitest';
import { enableMouse, disableMouse } from './mouseProtocol';

function fakeStream(isTTY: boolean) {
  const written: string[] = [];
  return {
    isTTY,
    written,
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  };
}

describe('mouse protocol', () => {
  it('enables SGR 1006 tracking on a TTY', () => {
    const stream = fakeStream(true);
    enableMouse(stream);
    expect(stream.written).toEqual(['\x1b[?1000h', '\x1b[?1002h', '\x1b[?1006h']);
  });

  it('disables tracking in reverse order on a TTY', () => {
    const stream = fakeStream(true);
    disableMouse(stream);
    expect(stream.written).toEqual(['\x1b[?1006l', '\x1b[?1002l', '\x1b[?1000l']);
  });

  it('writes nothing when the stream is not a TTY', () => {
    // Otherwise a redirected or piped stdout carries the control sequences
    // straight into the captured output.
    const stdout = fakeStream(false);
    enableMouse(stdout);
    disableMouse(stdout);
    expect(stdout.written).toEqual([]);
  });

  it('is a no-op when isTTY is absent entirely', () => {
    const stream = { written: [] as string[], write: (c: string) => stream.written.push(c) > 0 };
    enableMouse(stream as never);
    expect(stream.written).toEqual([]);
  });
});
