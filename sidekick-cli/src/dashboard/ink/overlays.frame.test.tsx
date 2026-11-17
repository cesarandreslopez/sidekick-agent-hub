/**
 * Overlays drawn over the dashboard must be opaque: Ink leaves padding cells
 * and the ends of short rows unpainted, so text underneath showed through
 * toasts, the actions menu and the accounts overlay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'events';
import { Box, Text, render } from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { ToastNotification } from './ToastNotification';
import { ContextMenuOverlay } from './ContextMenuOverlay';
import { AccountsOverlay } from './AccountsOverlay';
import { FilterOverlay } from './FilterOverlay';
import { toastOffsets } from './toastStack';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

async function renderFrame(element: React.ReactElement, columns: number, rows: number) {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: false,
    write: vi.fn((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }),
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    setEncoding: vi.fn(),
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    read: vi.fn(() => null),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const app = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frame = (writes[writes.length - 1] ?? '').replace(ANSI, '');
  app.unmount();
  return frame.split('\n');
}

/** A screen of 'y' with `overlay` drawn over it. */
function overScreen(overlay: React.ReactElement, columns: number, rows: number) {
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => (
        <Text key={i} wrap="truncate-end">
          {'y'.repeat(columns)}
        </Text>
      ))}
      {overlay}
    </Box>
  );
}

/** Text between the first pair of vertical borders on each bordered row. */
function insideBorders(lines: string[]): string[] {
  return lines
    .map((line) => line.match(/│(.*)│/)?.[1])
    .filter((inside): inside is string => inside !== undefined);
}

describe('overlay opacity', () => {
  it('paints the whole toast box over the text underneath', async () => {
    const lines = await renderFrame(
      overScreen(
        <ToastNotification toast={{ id: 1, message: 'Saved', severity: 'info' }} top={0} />,
        80,
        8,
      ),
      80,
      8,
    );
    const inside = insideBorders(lines);
    expect(inside.length).toBeGreaterThan(0);
    for (const row of inside) expect(row).not.toContain('y');
  });

  it('paints the actions menu, including short rows', async () => {
    const actions = [
      { key: 'c', label: 'Clone it', handler: () => {} },
      { key: 'x', label: 'A rather longer action label', handler: () => {} },
    ];
    const lines = await renderFrame(
      overScreen(<ContextMenuOverlay actions={actions} selectedIndex={0} />, 80, 12),
      80,
      12,
    );
    const inside = insideBorders(lines);
    expect(inside.length).toBeGreaterThanOrEqual(3);
    for (const row of inside) expect(row).not.toContain('y');
  });

  it('paints the accounts overlay, and its empty state and footer do not wrap', async () => {
    const lines = await renderFrame(
      overScreen(<AccountsOverlay views={[]} selectedIndex={0} />, 80, 14),
      80,
      14,
    );
    const inside = insideBorders(lines);
    for (const row of inside) expect(row).not.toContain('y');
    const text = inside.join('\n');
    expect(text).toContain('No saved accounts.');
    expect(text).toContain('Run: sidekick accounts add');
    expect(text).toContain('Enter switch u undo Esc close');
  });
});

describe('selection markers without colour', () => {
  let level: typeof chalk.level;
  beforeEach(() => {
    level = chalk.level;
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = level;
  });

  it('marks the selected action with a pointer', async () => {
    const actions = [
      { key: 'c', label: 'Copy', handler: () => {} },
      { key: 'o', label: 'Open', handler: () => {} },
    ];
    const lines = await renderFrame(
      <Box width={60} height={10}>
        <ContextMenuOverlay actions={actions} selectedIndex={1} />
      </Box>,
      60,
      10,
    );
    const marked = lines.filter((line) => line.includes('▸'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('Open');
  });

  it('shows the active filter mode in brackets', async () => {
    const lines = await renderFrame(
      <Box height={4} width={80}>
        <FilterOverlay filterString="abc" filterMode="regex" filterError={null} />
      </Box>,
      80,
      4,
    );
    const text = lines.join('\n');
    expect(text).toContain('[Regex]');
    expect(text).not.toContain('[Substr]');
  });
});

describe('toast layout', () => {
  it('shows a long report path in full across rows', async () => {
    const path =
      '/private/tmp/claude-501/-Users-someone-code-project/sidekick-report-1794926533884.html';
    const lines = await renderFrame(
      overScreen(
        <ToastNotification toast={{ id: 1, message: `Report: ${path}`, severity: 'info' }} />,
        80,
        8,
      ),
      80,
      8,
    );
    const text = insideBorders(lines).join('').replace(/\s+/g, '');
    expect(text).toContain('sidekick-report-1794926533884.html');
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(80);
  });

  it('stacks toasts by their real height so wrapped ones do not overlap', () => {
    const long = 'x '.repeat(60);
    expect(toastOffsets(['short', long, 'short'], 80)).toEqual([0, 3, 8]);
  });
});
