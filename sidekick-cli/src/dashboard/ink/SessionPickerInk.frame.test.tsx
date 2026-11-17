/**
 * Session picker layout: rendered into fake terminals of several sizes, it
 * must fit, use the rows it has, and mark the selection without colour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { SessionPickerInk, pickerLayout, pickerNavigationDelta } from './SessionPickerInk';
import type { SessionPickerItem } from '../SessionPickerHelpers';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function items(count: number): SessionPickerItem[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionPath: `/s/${i}.jsonl`,
    label: `Session number ${i} about refactoring the parser and adding regression tests`,
    sessionId: `abcd${String(i).padStart(4, '0')}`,
    age: `${i + 1}m ago`,
    isActive: i === 0,
    providerId: 'claude-code' as const,
  }));
}

async function renderPicker(list: SessionPickerItem[], columns: number, rows: number) {
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
  const app = render(<SessionPickerInk items={list} onSelect={() => {}} />, {
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
  const lines = frame.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

describe('session picker layout', () => {
  let level: typeof chalk.level;
  beforeEach(() => {
    level = chalk.level;
  });
  afterEach(() => {
    chalk.level = level;
  });

  it.each([
    [60, 15],
    [80, 24],
    [100, 30],
    [160, 45],
  ])('fits a %ix%i terminal', async (columns, rows) => {
    const lines = await renderPicker(items(40), columns, rows);
    expect(lines.length).toBeLessThanOrEqual(rows);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
  });

  it('fills the list box instead of leaving rows blank', async () => {
    const list = items(40);
    const lines = await renderPicker(list, 80, 24);
    const layout = pickerLayout(80, 24, list);
    const shown = lines.filter((line) => line.includes('Session number')).length;
    expect(shown).toBe(layout.viewportHeight);
  });

  it('uses the width it has for titles, and drops the id column when narrow', async () => {
    const wide = await renderPicker(items(3), 160, 45);
    expect(wide.join('\n')).toContain('adding regression tests');
    expect(wide.join('\n')).toContain('abcd0001');
    const narrow = await renderPicker(items(3), 60, 15);
    expect(narrow.join('\n')).not.toContain('abcd0001');
  });

  it('marks the selected row with a pointer even without colour', async () => {
    chalk.level = 0;
    const lines = await renderPicker(items(5), 80, 24);
    const marked = lines.filter((line) => line.includes('▸'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('Session number 0');
  });

  it('shows the too-small notice below 60x15', async () => {
    const lines = await renderPicker(items(5), 59, 24);
    expect(lines.join('\n')).toContain('Terminal too small');
  });

  it('drops the logo on short terminals so the list keeps its rows', () => {
    expect(pickerLayout(80, 24, []).showLogo).toBe(true);
    expect(pickerLayout(80, 18, []).showLogo).toBe(false);
    expect(pickerLayout(80, 18, []).viewportHeight).toBe(14);
  });
});

describe('pickerNavigationDelta', () => {
  it('moves by the length of a run of j or k, as Ink delivers held keys', () => {
    expect(pickerNavigationDelta('j', {})).toBe(1);
    expect(pickerNavigationDelta('jjjj', {})).toBe(4);
    expect(pickerNavigationDelta('kk', {})).toBe(-2);
    expect(pickerNavigationDelta('', { downArrow: true })).toBe(1);
    expect(pickerNavigationDelta('', { upArrow: true })).toBe(-1);
  });

  it('ignores mixed or other input', () => {
    expect(pickerNavigationDelta('jk', {})).toBe(0);
    expect(pickerNavigationDelta('q', {})).toBe(0);
    expect(pickerNavigationDelta('hello', {})).toBe(0);
  });
});
