import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import { SessionPickerInk } from './SessionPickerInk';
import { createAltScreen } from '../altScreen';
import type { SessionPickerItem } from '../SessionPickerHelpers';

/** An 80×24 TTY that records what reaches the terminal. */
function fakeTerminal() {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    isTTY: true,
    write: vi.fn((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }),
  });
  const pending: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding: vi.fn(),
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    read: vi.fn(() => pending.shift() ?? null),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const press = (key: string) => {
    pending.push(key);
    stdin.emit('readable');
  };
  return {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    writes,
    press,
  };
}

const items: SessionPickerItem[] = Array.from({ length: 6 }, (_, i) => ({
  sessionPath: `/sessions/s${i}.jsonl`,
  providerId: 'claude-code',
  label: `session ${i}`,
  age: `${i}m ago`,
  sessionId: `s${i}`,
  isActive: i === 0,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

async function renderPicker(useAltScreen: boolean): Promise<{ erases: number; output: string }> {
  const term = fakeTerminal();
  const alt = createAltScreen(term.stdout);
  if (useAltScreen) alt.enter();
  const app = render(<SessionPickerInk items={items} onSelect={() => {}} />, {
    stdout: useAltScreen ? alt.stdout : term.stdout,
    stdin: term.stdin,
    patchConsole: false,
  });
  await tick();
  term.press('\x1b[B');
  await tick();
  term.press('\x1b[B');
  await tick();
  app.unmount();
  alt.leave();
  const output = term.writes.join('');
  return { erases: output.split('\x1b[3J').length - 1, output };
}

// In CI, Ink renders non-interactively (only the final frame, no per-frame
// clears), so the control has nothing to measure there.
const inkClearsFrames = !process.env.CI;

describe('session picker in the alternate screen', () => {
  it('never erases the scrollback when it re-renders a full-height frame', async () => {
    if (inkClearsFrames) {
      // Control: straight to the terminal, Ink's full-screen clear erases it.
      expect((await renderPicker(false)).erases).toBeGreaterThan(0);
    }
    // Through the dashboard's alternate-screen stream, the picker still draws
    // but nothing erases the scrollback.
    const viaAltScreen = await renderPicker(true);
    expect(viaAltScreen.output).toContain('session 0');
    expect(viaAltScreen.erases).toBe(0);
  });
});
