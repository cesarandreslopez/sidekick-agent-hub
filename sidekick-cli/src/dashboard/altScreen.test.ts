import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createAltScreen, leaveActiveAltScreen, stripScrollbackErase } from './altScreen';

function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY,
    columns: 100,
    rows: 30,
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  });
  return { stream: stream as unknown as NodeJS.WriteStream, writes };
}

describe('alternate screen', () => {
  it('enters and leaves once on a TTY', () => {
    const { stream, writes } = fakeStream(true);
    const alt = createAltScreen(stream);
    alt.enter();
    alt.enter();
    expect(alt.active).toBe(true);
    alt.leave();
    alt.leave();
    expect(writes).toEqual(['\x1b[?1049h\x1b[H', '\x1b[?1049l']);
  });

  it('does nothing on a non-TTY stream', () => {
    const { stream, writes } = fakeStream(false);
    const alt = createAltScreen(stream);
    alt.enter();
    alt.leave();
    expect(writes).toEqual([]);
    expect(alt.stdout).toBe(stream);
  });

  it('hands Ink a stream that drops scrollback erases but keeps everything else', () => {
    const { stream, writes } = fakeStream(true);
    const alt = createAltScreen(stream);
    alt.stdout.write('\x1b[2J\x1b[3J\x1b[Hframe');
    expect(writes).toEqual(['\x1b[2J\x1b[Hframe']);
    // Size and listeners stay live on the real stream.
    expect(alt.stdout.columns).toBe(100);
    const onResize = vi.fn();
    alt.stdout.on('resize', onResize);
    (stream as unknown as EventEmitter).emit('resize');
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('drops writes made through its stream after it has left', () => {
    const { stream, writes } = fakeStream(true);
    const alt = createAltScreen(stream);
    alt.enter();
    alt.stdout.write('frame');
    alt.leave();
    const done = vi.fn();
    expect(alt.stdout.write('\x1b[2J\x1b[Hlate frame', done)).toBe(true);
    expect(done).toHaveBeenCalled();
    expect(writes).toEqual(['\x1b[?1049h\x1b[H', 'frame', '\x1b[?1049l']);
  });

  it('leaveActiveAltScreen restores the screen before a fatal message', () => {
    const { stream, writes } = fakeStream(true);
    const alt = createAltScreen(stream);
    alt.enter();
    leaveActiveAltScreen();
    expect(alt.active).toBe(false);
    expect(writes[writes.length - 1]).toBe('\x1b[?1049l');
    leaveActiveAltScreen();
    expect(writes).toHaveLength(2);
  });

  it('strips only the scrollback erase', () => {
    expect(stripScrollbackErase('a\x1b[3Jb\x1b[2Jc')).toBe('ab\x1b[2Jc');
    const buffer = Buffer.from('x');
    expect(stripScrollbackErase(buffer)).toBe(buffer);
  });
});
