import { describe, it, expect } from 'vitest';
import { parseMouseEvent } from './parseMouseEvent';

describe('parseMouseEvent', () => {
  it('parses left click at (5, 10)', () => {
    // SGR coords are 1-based: col=6, row=11
    const event = parseMouseEvent('\x1b[<0;6;11M');
    expect(event).toEqual({
      type: 'click',
      button: 'left',
      x: 5,
      y: 10,
      shift: false,
      meta: false,
      ctrl: false,
    });
  });

  it('parses left release', () => {
    const event = parseMouseEvent('\x1b[<0;6;11m');
    expect(event).toEqual({
      type: 'release',
      button: 'left',
      x: 5,
      y: 10,
      shift: false,
      meta: false,
      ctrl: false,
    });
  });

  it('parses middle click', () => {
    const event = parseMouseEvent('\x1b[<1;1;1M');
    expect(event).toEqual({
      type: 'click',
      button: 'middle',
      x: 0,
      y: 0,
      shift: false,
      meta: false,
      ctrl: false,
    });
  });

  it('parses right click', () => {
    const event = parseMouseEvent('\x1b[<2;10;20M');
    expect(event).toEqual({
      type: 'click',
      button: 'right',
      x: 9,
      y: 19,
      shift: false,
      meta: false,
      ctrl: false,
    });
  });

  it('parses scroll up', () => {
    const event = parseMouseEvent('\x1b[<64;15;5M');
    expect(event).toEqual({
      type: 'scroll',
      button: 'none',
      x: 14,
      y: 4,
      shift: false,
      meta: false,
      ctrl: false,
      scrollDirection: 'up',
    });
  });

  it('parses scroll down', () => {
    const event = parseMouseEvent('\x1b[<65;15;5M');
    expect(event).toEqual({
      type: 'scroll',
      button: 'none',
      x: 14,
      y: 4,
      shift: false,
      meta: false,
      ctrl: false,
      scrollDirection: 'down',
    });
  });

  it('parses shift+click (code 4)', () => {
    const event = parseMouseEvent('\x1b[<4;1;1M');
    expect(event).toEqual({
      type: 'click',
      button: 'left',
      x: 0,
      y: 0,
      shift: true,
      meta: false,
      ctrl: false,
    });
  });

  it('parses ctrl+click (code 16)', () => {
    const event = parseMouseEvent('\x1b[<16;1;1M');
    expect(event).toEqual({
      type: 'click',
      button: 'left',
      x: 0,
      y: 0,
      shift: false,
      meta: false,
      ctrl: true,
    });
  });

  it('parses meta+click (code 8)', () => {
    const event = parseMouseEvent('\x1b[<8;1;1M');
    expect(event).toEqual({
      type: 'click',
      button: 'left',
      x: 0,
      y: 0,
      shift: false,
      meta: true,
      ctrl: false,
    });
  });

  it('parses combined modifiers (shift+ctrl = 20)', () => {
    const event = parseMouseEvent('\x1b[<20;3;4M');
    expect(event).toEqual({
      type: 'click',
      button: 'left',
      x: 2,
      y: 3,
      shift: true,
      meta: false,
      ctrl: true,
    });
  });

  it('parses left drag (code 32)', () => {
    const event = parseMouseEvent('\x1b[<32;10;10M');
    expect(event).toEqual({
      type: 'drag',
      button: 'left',
      x: 9,
      y: 9,
      shift: false,
      meta: false,
      ctrl: false,
    });
  });

  it('parses right drag (code 34)', () => {
    const event = parseMouseEvent('\x1b[<34;5;5M');
    expect(event).toEqual({
      type: 'drag',
      button: 'right',
      x: 4,
      y: 4,
      shift: false,
      meta: false,
      ctrl: false,
    });
  });

  it('returns null for non-mouse data', () => {
    expect(parseMouseEvent('hello')).toBeNull();
    expect(parseMouseEvent('\x1b[A')).toBeNull(); // arrow key
    expect(parseMouseEvent('')).toBeNull();
  });

  it('handles Buffer input', () => {
    const buf = Buffer.from('\x1b[<0;1;1M', 'utf-8');
    const event = parseMouseEvent(buf);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('click');
    expect(event!.button).toBe('left');
  });

  it('parses large coordinates', () => {
    const event = parseMouseEvent('\x1b[<0;200;50M');
    expect(event).not.toBeNull();
    expect(event!.x).toBe(199);
    expect(event!.y).toBe(49);
  });
});
