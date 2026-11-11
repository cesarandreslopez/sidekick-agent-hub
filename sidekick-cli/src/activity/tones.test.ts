import { describe, expect, it } from 'vitest';
import type { ActivityTextSegment } from 'sidekick-shared';
import { stripBlessedTags, visibleLength } from '../dashboard/formatters';
import { rowsToAnsi, segmentsToBlessed, segmentsToPlain, toneStyle } from './tones';
import type { ChalkLike } from './tones';

describe('toneStyle', () => {
  it('colors accents by station and falls back for unknown tones', () => {
    expect(toneStyle({ tone: 'accent', station: 'shell' })).toEqual({ color: 'green' });
    expect(toneStyle({ tone: 'accent' })).toEqual({ color: 'magentaBright' });
    expect(toneStyle({ tone: 'fault' })).toEqual({ color: 'red', bold: true });
    expect(toneStyle({ tone: 'dim' })).toEqual({ color: 'gray', dim: true });
    expect(toneStyle({ tone: 'default', bold: true })).toEqual({ bold: true });
    expect(toneStyle({ tone: 'unheard-of' as never })).toEqual({});
  });
});

describe('segmentsToBlessed', () => {
  it('escapes braces from data so they never read as tags', () => {
    const row: ActivityTextSegment[] = [
      { text: '{red-fg}fake{/red-fg}', tone: 'default' },
      { text: ' set {a}', tone: 'fault' },
    ];
    const tagged = segmentsToBlessed(row);
    expect(tagged).not.toContain('{red-fg}fake');
    expect(stripBlessedTags(tagged)).toBe('{red-fg}fake{/red-fg} set {a}');
    expect(visibleLength(tagged)).toBe(segmentsToPlain(row).length);
  });

  it('wraps colored and bold segments in balanced tags', () => {
    expect(segmentsToBlessed([{ text: 'x', tone: 'hot' }])).toBe(
      '{yellow-fg}{bold}x{/bold}{/yellow-fg}',
    );
    expect(segmentsToBlessed([{ text: 'y', tone: 'muted' }])).toBe('{grey-fg}y{/grey-fg}');
  });
});

describe('rowsToAnsi', () => {
  it('runs every styled segment through the matching chalk styles', () => {
    const calls: string[] = [];
    const style = (name: string) => (text: string) => {
      calls.push(name);
      return `<${name}>${text}</${name}>`;
    };
    const chalk = Object.assign((text: string) => text, {
      red: style('red'),
      bold: style('bold'),
      green: style('green'),
    }) as unknown as ChalkLike;
    const [line] = rowsToAnsi(
      [
        [
          { text: 'boom', tone: 'fault' },
          { text: ' ok', tone: 'accent', station: 'shell' },
        ],
      ],
      chalk,
    );
    expect(line).toBe('<bold><red>boom</red></bold><green> ok</green>');
    expect(calls).toEqual(['red', 'bold', 'green']);
  });
});
